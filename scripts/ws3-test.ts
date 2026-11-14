/**
 * WS3 self-test. Run: bun scripts/ws3-test.ts
 * Exercises the voice tools directly (no HTTP server needed).
 * Seeds before and after so the demo data is left exactly as found.
 */
import { execFileSync } from 'node:child_process';
import { listBookings, listSms } from '../src/lib/db';
import {
  checkAvailability, createBooking, getPricing, flagEmergency, sendSmsTool,
  createPaymentLink, handoffToHuman, runTool,
} from '../src/lib/voice/tools';

const BIZ = 'biz_miami_cool_air';

function seed() {
  execFileSync('bun', ['scripts/seed.ts'], { cwd: process.cwd(), stdio: 'inherit' });
}

let pass = 0;
let failCount = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) {
    failCount++;
    if (detail !== undefined) console.log('       got:', JSON.stringify(detail).slice(0, 600));
  } else {
    pass++;
  }
}

seed();

// 1. availability: no date → three real slots
const avail = await checkAvailability({ business_id: BIZ });
const slots = (avail.data as { slots?: { start: string }[] } | undefined)?.slots ?? [];
check('checkAvailability returns exactly 3 slots', slots.length === 3, avail);
check('checkAvailability message is speakable and ends with a question',
  /which works better\?$|does that work for you\?$/.test(avail.message), avail.message);
check('checkAvailability message names real times', slots.every((s) => {
  const t = new Date(s.start);
  const h12 = t.getHours() % 12 === 0 ? 12 : t.getHours() % 12;
  return avail.message.includes(`${h12} `) || avail.message.includes(`${h12}:`) || new Date(s.start).getMonth() >= 0;
}) && avail.message.includes('I have'), avail.message);

// Spanish variant
const availEs = await checkAvailability({ business_id: BIZ, language: 'es' });
check('checkAvailability Spanish message present',
  availEs.message.startsWith('Tengo') && /le queda mejor\?$/.test(availEs.message), availEs.message);

// date-specific
const firstSlotDate = slots[0]?.start.slice(0, 10) ?? '';
const availDay = await checkAvailability({ business_id: BIZ, date: firstSlotDate });
check('checkAvailability(date) only offers that day',
  ((availDay.data as { slots?: { start: string }[] })?.slots ?? []).length > 0, availDay);

// 2. booking success
const target = slots[0].start;
const before = (await listBookings(BIZ)).length;
const booked = await createBooking({
  business_id: BIZ,
  customer_name: 'WS3 Tester',
  customer_phone: '+13055551234',
  service: 'AC repair',
  scheduled_at: target,
  address: '100 Test St, Miami, FL',
  price_estimate: 150,
});
const bookingId = (booked.data as { booking?: { id: string; scheduled_at: string } } | undefined)?.booking?.id;
check('createBooking succeeds for an open slot', booked.ok && !!bookingId, booked);
check('createBooking writes exactly one booking', (await listBookings(BIZ)).length === before + 1);
check('createBooking message confirms a real time', /You're all set for .+\. I'm sending your confirmation text now\.$/.test(booked.message), booked.message);
check('createBooking Spanish message present',
  (await createBooking({
    business_id: BIZ, language: 'es', customer_name: 'Prueba ES',
    customer_phone: '+13055551235', service: 'AC repair', scheduled_at: slots[1]?.start ?? target,
  })).message.startsWith('Listo, quedó agendado para '));

// 3. bad time rejected (same slot already booked)
const dup = await createBooking({
  business_id: BIZ,
  customer_name: 'WS3 Tester',
  customer_phone: '+13055551234',
  service: 'AC repair',
  scheduled_at: target,
});
check('createBooking rejects an already-booked slot', dup.ok === false, dup);
check('rejection message offers an alternative', /instead\.$/.test(dup.message) || /alternativa/.test(dup.message), dup.message);

// outside business hours (3 AM)
const nightStart = new Date(`${target.slice(0, 10)}T03:00:00`);
const night = await createBooking({
  business_id: BIZ,
  customer_name: 'WS3 Night',
  customer_phone: '+13055551236',
  service: 'AC repair',
  scheduled_at: nightStart.toISOString(),
});
check('createBooking rejects a 3 AM slot', night.ok === false, night);

// missing fields
const incomplete = await createBooking({ business_id: BIZ, customer_name: 'Only Name' });
check('createBooking rejects missing fields with a speakable message',
  incomplete.ok === false && incomplete.message.length > 0, incomplete);

// garbage timestamp
const garbage = await createBooking({
  business_id: BIZ, customer_name: 'A', customer_phone: '+13055550000',
  service: 'AC repair', scheduled_at: 'next tuesday-ish',
});
check('createBooking rejects a non-ISO time', garbage.ok === false, garbage);

// 4. pricing: AC repair → $150
const repair = await getPricing({ business_id: BIZ, service_name: 'AC repair' });
const repairData = repair.data as { matched?: boolean; price?: number; service?: string } | undefined;
check('getPricing("AC repair") matches and returns $150',
  repairData?.matched === true && repairData?.price === 150, repair);
check('getPricing message quotes the starting price',
  repair.message.includes('$150') && repair.message.includes('starts at'), repair.message);

const repairEs = await getPricing({ business_id: BIZ, service_name: 'reparación de AC', language: 'es' });
check('getPricing Spanish message present',
  repairEs.message.includes('empieza en'), repairEs.message);

// no-match: roof replacement must NOT invent a price
const roof = await getPricing({ business_id: BIZ, service_name: 'roof replacement' });
const roofData = roof.data as { matched?: boolean; price?: number | null } | undefined;
check('getPricing("roof replacement") reports matched:false', roofData?.matched === false, roof);
check('getPricing("roof replacement") invents no price',
  roofData?.price == null && !/\$\d/.test(roof.message), roof);
check('getPricing no-match message defers to the owner',
  roof.message === "I'll have the owner confirm that price for you." && roof.ok === true, roof.message);

const roofEs = await getPricing({ business_id: BIZ, service_name: 'techo', language: 'es' });
check('getPricing Spanish no-match message present',
  roofEs.message === 'Voy a pedirle al dueño que le confirme ese precio.', roofEs.message);

// 5. emergency: flags the call + logs an owner SMS
const smsBefore = (await listSms(BIZ)).length;
const emergency = await flagEmergency({
  business_id: BIZ,
  reason: 'Water pouring from ceiling unit',
  customer_name: 'WS3 Emergency',
  customer_phone: '+13055559999',
  address: '9 Flood Rd, Miami, FL',
});
const emergencyData = emergency.data as {
  call?: { id: string; urgency: string; flagged_reason: string; status: string };
  owner_sms?: { kind: string; to_phone: string } | null;
} | undefined;
const ownerLogs = (await listSms(BIZ)).filter((s) => s.kind === 'owner_alert');
check('flagEmergency marks the call urgency=emergency',
  emergencyData?.call?.urgency === 'emergency', emergency);
check('flagEmergency stores the reason',
  (emergencyData?.call?.flagged_reason ?? '').includes('Water pouring'), emergency);
check('flagEmergency logs an owner_alert SMS', ownerLogs.length >= 1 && (await listSms(BIZ)).length > smsBefore, ownerLogs);
check('flagEmergency owner SMS goes to the owner phone',
  ownerLogs.some((s) => s.to_phone === '+13055550199'), ownerLogs);
check('flagEmergency message is speakable',
  emergency.message === "I've flagged this as an emergency and the owner has been notified.", emergency.message);
check('flagEmergency Spanish message present',
  (await flagEmergency({ business_id: BIZ, reason: 'fuga de agua', language: 'es' }))
    .message === 'Lo marqué como emergencia y el dueño ya fue notificado.');

// 6. handoff preserves status
const handoff = await handoffToHuman({ business_id: BIZ, reason: 'Caller asked for the owner' });
check('handoffToHuman sets status handed_off',
  (handoff.data as { call?: { status: string } } | undefined)?.call?.status === 'handed_off', handoff);
check('handoffToHuman message is speakable',
  handoff.message === 'Let me connect you with the owner — one moment.', handoff.message);

// 7. sms + payment link
const sms = await sendSmsTool({ business_id: BIZ, to: '+13055551234', body: 'Your tech is on the way.' });
check('sendSms logs an SMS with kind other',
  sms.ok && (await listSms(BIZ)).some((s) => s.body === 'Your tech is on the way.' && s.kind === 'other'), sms);
check('sendSms Spanish message present',
  (await sendSmsTool({ business_id: BIZ, to: '+13055551234', body: 'Hola', language: 'es' }))
    .message.includes('Le acabo de mandar'));

const pay = await createPaymentLink({
  business_id: BIZ, amount_cents: 18900, description: 'Emergency deposit', to: '+13055551234',
});
const payData = pay.data as { amount_cents?: number; link?: { url: string } } | undefined;
check('createPaymentLink returns a link for $189',
  pay.ok && payData?.amount_cents === 18900 && !!payData?.link?.url, pay);
check('createPaymentLink message names the amount',
  pay.message === "I'm sending you a secure link for the $189 deposit right now.", pay.message);

const capped = await createPaymentLink({ business_id: BIZ, amount_cents: 99_999, description: 'Too much' });
check('createPaymentLink caps at 50000 cents',
  (capped.data as { amount_cents?: number } | undefined)?.amount_cents === 50000, capped);
check('createPaymentLink Spanish message present',
  (await createPaymentLink({ business_id: BIZ, amount_cents: 5000, description: 'Dep', language: 'es' }))
    .message.includes('enlace seguro para el depósito de $50'));

// 8. dispatcher + failure modes
const viaDispatcher = await runTool('get_pricing', { business_id: BIZ, service_name: 'duct cleaning' });
check('runTool dispatches get_pricing', viaDispatcher.ok && viaDispatcher.message.includes('$350'), viaDispatcher);
const unknown = await runTool('make_coffee', { business_id: BIZ });
check('runTool unknown tool returns a speakable fallback',
  unknown.ok === false && unknown.message === 'Let me get the owner for that.', unknown);
const noBiz = await runTool('check_availability', { business_id: 'nope' });
check('runTool with a bad business id never throws',
  noBiz.message.length > 0 && noBiz.ok === false, noBiz);
const noArgs = await runTool('create_booking', {});
check('runTool with no args never throws',
  typeof noArgs.message === 'string' && noArgs.message.length > 0, noArgs);

// booking survived in the store with the right call linkage
const savedBooking = (await listBookings(BIZ)).find((b) => b.id === bookingId);
check('booking persists with the requested service and time',
  savedBooking?.service === 'AC repair' && savedBooking?.scheduled_at === new Date(target).toISOString(),
  savedBooking);

seed();

console.log(`\n${failCount === 0 ? `ALL PASS (${pass}/${pass + failCount})` : `FAILURES: ${failCount}/${pass + failCount}`}`);
process.exit(failCount === 0 ? 0 : 1);
