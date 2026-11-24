/**
 * WS4 self-test. Run: bun scripts/ws4-test.ts
 *
 * Calls the real route handlers with real `Request` objects (no HTTP server
 * needed), so what passes here is the same code the dashboard and the voice
 * tools hit. Re-seeds before and after so demo data is left clean.
 */
import { execFileSync } from 'node:child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getBooking, getBusiness, listSms } from '../src/lib/db';
import {
  confirmationSms, formatWhen, gratitudeSms, ownerAlertSms, ownerEscalationSms,
  paymentLinkSms, reviewRequestSms, reviewUrl, SMS_LIMIT,
  type Lang,
} from '../src/lib/messaging/templates';

import { POST as sendSmsRoute } from '../src/app/api/sms/send/route';
import { POST as confirmationRoute } from '../src/app/api/sms/confirmation/route';
import { POST as paymentLinkRoute } from '../src/app/api/sms/payment-link/route';
import { POST as gratitudeRoute } from '../src/app/api/sms/gratitude/route';
import { POST as gratitudeReplyRoute } from '../src/app/api/sms/gratitude-reply/route';
import { POST as createLinkRoute } from '../src/app/api/payments/create-link/route';
import { POST as webhookRoute } from '../src/app/api/payments/webhook/route';
import { makeT } from '../src/lib/i18n';
import PayPage from '../src/app/pay/[id]/page';
import { PaymentReceived } from '../src/app/pay/[id]/received';
import { assertSafeDatabase, forwardedArgs } from './_safe-db';

assertSafeDatabase('ws4-test');

const BIZ = 'biz_miami_cool_air';
const CONFIRM_BOOKING = 'bk_demo_3';
const GRATITUDE_BOOKING = 'bk_demo_2';

let pass = 0;
let failCount = 0;

function check(label: string, cond: boolean | undefined, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`PASS — ${label}`);
    return;
  }
  failCount++;
  console.log(`FAIL — ${label}`);
  if (detail !== undefined) console.log('       got:', JSON.stringify(detail).slice(0, 600));
}

/** Body length, or Infinity when a route returned no body — such a probe fails the `<=`. */
const bodyLen = (d?: { body?: string; sms?: { body?: string } }) =>
  (d?.body ?? d?.sms?.body)?.length ?? Infinity;

function seed() {
  execFileSync('bun', ['scripts/seed.ts', ...forwardedArgs()], { cwd: process.cwd(), stdio: 'ignore' });
}

function call(handler: (req: Request) => Promise<Response>, body: unknown) {
  return handler(
    new Request('http://localhost:3000/api/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Shape the routes return; every field optional because tests probe failures too. */
type JsonBody = {
  ok?: boolean;
  data?: {
    id?: string; body?: string; to_phone?: string; status?: string; kind?: string;
    url?: string; mock?: boolean; routed?: string; deduped?: boolean;
    amount_cents?: number;
    link?: { url?: string; mock?: boolean; id?: string };
    sms?: { id?: string; body?: string; kind?: string; status?: string; to_phone?: string; booking_id?: string | null };
  };
};

async function postJson(handler: (req: Request) => Promise<Response>, body: unknown) {
  const res = await call(handler, body);
  return { status: res.status, json: (await res.json().catch(() => null)) as JsonBody | null };
}

async function main() {
  seed();

  const business = await getBusiness(BIZ);
  const confirmBooking = await getBooking(CONFIRM_BOOKING);
  const gratBooking = await getBooking(GRATITUDE_BOOKING);
  if (!business || !confirmBooking || !gratBooking) {
    console.log('FAIL — seeded fixtures missing (run bun scripts/seed.ts)');
    process.exit(1);
  }

  // ---------- 1. templates ----------
  console.log('--- templates ---');
  const langs: Lang[] = ['en', 'es', 'mixed'];

  const confirmations = langs.map((l) => confirmationSms({ business, booking: confirmBooking, language: l }));
  check('confirmationSms mentions business + service',
    confirmations[0].includes('Miami Cool Air') && confirmations[0].includes(confirmBooking.service),
    confirmations[0]);
  check('confirmationSms EN says Confirmed + Reply C',
    confirmations[0].includes('Confirmed') && confirmations[0].includes('Reply C to cancel'),
    confirmations[0]);
  check('confirmationSms ES present and different from EN',
    confirmations[1].includes('Confirmado') && confirmations[1] !== confirmations[0],
    confirmations[1]);
  check('confirmationSms mixed present',
    confirmations[2] !== confirmations[0] && confirmations[2].includes('Gracias'),
    confirmations[2]);
  check('confirmationSms names the customer',
    confirmations[0].includes(confirmBooking.customer_name.split(' ')[0]),
    confirmations[0]);
  check('confirmationSms includes the estimate', confirmations[0].includes('$129'), confirmations[0]);

  const linkEn = paymentLinkSms({ business, amount_cents: 18900, url: 'https://pay.example.com/abc', service: 'AC repair', language: 'en' });
  const linkEs = paymentLinkSms({ business, amount_cents: 18900, url: 'https://pay.example.com/abc', service: 'AC repair', language: 'es' });
  check('paymentLinkSms carries the url', linkEn.includes('https://pay.example.com/abc'), linkEn);
  check('paymentLinkSms carries $189', linkEn.includes('$189'), linkEn);
  check('paymentLinkSms ES present and different', linkEs.includes('Depósito') && linkEs !== linkEn, linkEs);

  const gratEn = gratitudeSms({ business, booking: gratBooking, language: 'en' });
  const gratEs = gratitudeSms({ business, booking: gratBooking, language: 'es' });
  check('gratitudeSms asks 1-5', gratEn.includes('1-5'), gratEn);
  check('gratitudeSms names the customer', gratEn.includes(gratBooking.customer_name.split(' ')[0]), gratEn);
  check('gratitudeSms ES present and different', gratEs.includes('Responda 1-5') && gratEs !== gratEn, gratEs);

  const review = reviewRequestSms({ business, booking: gratBooking, reviewUrl: reviewUrl() });
  check('reviewRequestSms carries the review url', review.includes(reviewUrl()), review);

  const escalation = ownerEscalationSms({ business, customer: 'Danny', reason: 'AC still blowing warm' });
  check('ownerEscalationSms is bilingual',
    /contento/.test(escalation) && /unhappy/.test(escalation), escalation);
  check('ownerEscalationSms quotes the reason', escalation.includes('AC still blowing warm'), escalation);

  const alert = ownerAlertSms({ business, text: 'Deposit $189 paid.' });
  check('ownerAlertSms prefixes the business', alert.startsWith('Miami Cool Air'), alert);

  const when = formatWhen(confirmBooking.scheduled_at, 'en');
  check('formatWhen reads like "today at 2:00 PM" / "<Weekday> at 9:00 AM"',
    /^(today|tomorrow|yesterday|[A-Z][a-z]+day) at \d{1,2}:\d{2} [AP]M$/.test(when), when);
  const today = formatWhen(new Date().toISOString(), 'en');
  check('formatWhen(now) starts with "today at"', today.startsWith('today at '), today);
  const esWhen = formatWhen(confirmBooking.scheduled_at, 'es');
  check('formatWhen ES uses "a las"', esWhen.includes('a las '), esWhen);

  const allBodies = [...confirmations, linkEn, linkEs, gratEn, gratEs, review, escalation, alert];
  check(`every template body <= ${SMS_LIMIT} chars`,
    allBodies.every((b) => b.length <= SMS_LIMIT), allBodies.map((b) => b.length));

  // ---------- 2. POST /api/sms/send ----------
  console.log('\n--- POST /api/sms/send ---');
  const before = (await listSms(BIZ)).length;
  const raw = await postJson(sendSmsRoute, {
    business_id: BIZ, to: '+1 (305) 555-0100', body: 'Test ping from WS4.', kind: 'other',
  });
  check('send → 200 + ok', raw.status === 200 && raw.json?.ok === true, raw.json);
  check('send returns the SmsLog',
    Boolean(raw.json?.data?.id) && raw.json?.data?.body === 'Test ping from WS4.', raw.json?.data);
  check('send normalizes the phone to E.164', raw.json?.data?.to_phone === '+13055550100', raw.json?.data?.to_phone);
  check('send logged a row', (await listSms(BIZ)).length === before + 1);
  check('send status is sent or mock', ['sent', 'mock'].includes(String(raw.json?.data?.status)), raw.json?.data?.status);
  const badSend = await postJson(sendSmsRoute, { business_id: BIZ, to: '' });
  check('send rejects a missing body with 422', badSend.status === 422, badSend.status);

  // ---------- 3. POST /api/sms/confirmation ----------
  console.log('\n--- POST /api/sms/confirmation ---');
  const confirm = await postJson(confirmationRoute, { booking_id: CONFIRM_BOOKING, language: 'es' });
  check('confirmation → 200 + ok', confirm.status === 200 && confirm.json?.ok === true, confirm.json);
  check('confirmation returns {sms, body}',
    Boolean(confirm.json?.data?.sms?.id) && typeof confirm.json?.data?.body === 'string', confirm.json?.data);
  check('confirmation status is sent or mock',
    ['sent', 'mock'].includes(String(confirm.json?.data?.sms?.status)), confirm.json?.data?.sms?.status);
  check('confirmation SMS is logged in sms_log',
    (await listSms(BIZ)).some((s) => s.id === confirm.json?.data?.sms?.id), confirm.json?.data?.sms?.id);
  check('confirmation row has kind "confirmation"',
    confirm.json?.data?.sms?.kind === 'confirmation', confirm.json?.data?.sms?.kind);
  check('confirmation body <= 300 chars',
    bodyLen(confirm.json?.data) <= SMS_LIMIT, confirm.json?.data?.body?.length);
  check('confirmation honored language: "es"',
    confirm.json?.data?.body?.includes('Confirmado'), confirm.json?.data?.body);

  const confirmAgain = await postJson(confirmationRoute, { booking_id: CONFIRM_BOOKING, language: 'es' });
  check('confirmation is idempotent within 2 minutes',
    confirmAgain.json?.data?.deduped === true
      && confirmAgain.json?.data?.sms?.id === confirm.json?.data?.sms?.id,
    confirmAgain.json?.data);
  const confirmMissing = await postJson(confirmationRoute, { booking_id: 'bk_nope' });
  check('confirmation 404s an unknown booking', confirmMissing.status === 404, confirmMissing.status);

  // ---------- 4. payments ----------
  console.log('\n--- POST /api/payments/create-link ---');
  const link = await postJson(createLinkRoute, {
    business_id: BIZ, amount_cents: 18900, description: 'Emergency deposit', booking_id: 'bk_demo_2',
  });
  check('create-link → 200 + ok', link.status === 200 && link.json?.ok === true, link.json);
  check('create-link returns a URL',
    typeof link.json?.data?.url === 'string' && link.json.data.url.startsWith('http'), link.json?.data);
  check('create-link echoes amount + mock flag',
    link.json?.data?.amount_cents === 18900 && typeof link.json?.data?.mock === 'boolean', link.json?.data);
  const tooSmall = await postJson(createLinkRoute, { business_id: BIZ, amount_cents: 50, description: 'x' });
  check('create-link rejects under $1 with 422', tooSmall.status === 422, tooSmall.status);
  const tooBig = await postJson(createLinkRoute, { business_id: BIZ, amount_cents: 50001, description: 'x' });
  check('create-link rejects over $500 with 422', tooBig.status === 422, tooBig.status);

  console.log('\n--- POST /api/sms/payment-link ---');
  const paySms = await postJson(paymentLinkRoute, {
    business_id: BIZ, booking_id: 'bk_demo_2', to: '+13055550177',
    amount_cents: 18900, description: 'Emergency deposit', language: 'en',
  });
  check('payment-link → 200 + ok', paySms.status === 200 && paySms.json?.ok === true, paySms.json);
  check('payment-link returns {sms, link} with a URL',
    Boolean(paySms.json?.data?.sms?.id) && typeof paySms.json?.data?.link?.url === 'string',
    paySms.json?.data);
  check('payment-link SMS contains that URL',
    paySms.json?.data?.sms?.body?.includes(String(paySms.json?.data?.link?.url)), paySms.json?.data?.sms?.body);
  check('payment-link row kind is "payment_link"',
    paySms.json?.data?.sms?.kind === 'payment_link', paySms.json?.data?.sms?.kind);
  check('payment-link body <= 300 chars',
    bodyLen(paySms.json?.data) <= SMS_LIMIT, paySms.json?.data?.body?.length);

  const providedUrl = await postJson(paymentLinkRoute, {
    business_id: BIZ, to: '+13055550177', amount_cents: 18900,
    description: 'Emergency deposit', url: 'https://buy.stripe.com/test_prebuilt', language: 'es',
  });
  check('payment-link reuses a pre-built url (voice tool sends one)',
    providedUrl.json?.data?.link?.url === 'https://buy.stripe.com/test_prebuilt', providedUrl.json?.data?.link);

  // ---------- 5. POST /api/sms/gratitude ----------
  console.log('\n--- POST /api/sms/gratitude ---');
  const grat = await postJson(gratitudeRoute, { booking_id: GRATITUDE_BOOKING, language: 'en' });
  check('gratitude → 200 + ok', grat.status === 200 && grat.json?.ok === true, grat.json);
  check('gratitude returns {sms, body}',
    Boolean(grat.json?.data?.sms?.id) && typeof grat.json?.data?.body === 'string', grat.json?.data);
  check('gratitude row kind is "gratitude"', grat.json?.data?.sms?.kind === 'gratitude', grat.json?.data?.sms?.kind);
  check('gratitude body asks 1-5', grat.json?.data?.body?.includes('1-5'), grat.json?.data?.body);
  check('gratitude body <= 300 chars', bodyLen(grat.json?.data) <= SMS_LIMIT, grat.json?.data?.body?.length);

  // ---------- 6. POST /api/sms/gratitude-reply ----------
  console.log('\n--- POST /api/sms/gratitude-reply ---');
  const happy = await postJson(gratitudeReplyRoute, { booking_id: GRATITUDE_BOOKING, rating: 5 });
  check('rating 5 → routed:"review"', happy.status === 200 && happy.json?.data?.routed === 'review', happy.json);
  check('rating 5 sent a review_request to the customer',
    happy.json?.data?.sms?.kind === 'review_request'
      && happy.json?.data?.sms?.to_phone === gratBooking.customer_phone,
    happy.json?.data?.sms);
  check('rating 5 body contains the review url',
    happy.json?.data?.body?.includes(reviewUrl()), happy.json?.data?.body);

  const rating4 = await postJson(gratitudeReplyRoute, { booking_id: GRATITUDE_BOOKING, rating: 4 });
  check('rating 4 → routed:"review" (boundary)', rating4.json?.data?.routed === 'review', rating4.json?.data?.routed);

  const unhappy = await postJson(gratitudeReplyRoute, { booking_id: GRATITUDE_BOOKING, rating: 2 });
  check('rating 2 → routed:"owner"', unhappy.status === 200 && unhappy.json?.data?.routed === 'owner', unhappy.json);
  check('rating 2 texted the owner, not the customer',
    unhappy.json?.data?.sms?.to_phone === business.owner_phone
      && unhappy.json?.data?.sms?.kind === 'owner_alert',
    unhappy.json?.data?.sms);
  check('rating 2 sends no review link to anyone',
    !(unhappy.json?.data?.body ?? '').includes(reviewUrl()), unhappy.json?.data?.body);
  check('rating 2 body <= 300 chars',
    bodyLen(unhappy.json?.data) <= SMS_LIMIT, unhappy.json?.data?.body?.length);

  const rating3 = await postJson(gratitudeReplyRoute, { booking_id: GRATITUDE_BOOKING, rating: 3 });
  check('rating 3 → routed:"owner" (boundary)', rating3.json?.data?.routed === 'owner', rating3.json?.data?.routed);

  const badRating = await postJson(gratitudeReplyRoute, { booking_id: GRATITUDE_BOOKING, rating: 9 });
  check('rating out of range → 422', badRating.status === 422, badRating.status);

  // ---------- 7. POST /api/payments/webhook ----------
  console.log('\n--- POST /api/payments/webhook ---');
  const completed = await call(webhookRoute, {
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: { object: { amount_total: 18900, metadata: { booking_id: 'bk_demo_1', business_id: BIZ } } },
  });
  check('webhook → 200', completed.status === 200, completed.status);
  check('webhook marks the matching booking deposit_paid',
    (await getBooking('bk_demo_1'))?.deposit_paid === true, await getBooking('bk_demo_1'));

  const unmatched = await call(webhookRoute, {
    type: 'checkout.session.completed',
    data: { object: { amount_total: 5000, metadata: { business_id: BIZ } } },
  });
  check('webhook without booking_id still returns 200', unmatched.status === 200, unmatched.status);
  check('webhook without booking_id logs an owner_alert SMS summarizing the payment',
    (await listSms(BIZ)).some((s) => s.kind === 'owner_alert' && s.body.includes('$50')),
    (await listSms(BIZ)).filter((s) => s.kind === 'owner_alert'));

  const unrelated = await call(webhookRoute, { type: 'customer.created', data: { object: {} } });
  check('webhook ignores unrelated event types with 200', unrelated.status === 200, unrelated.status);

  // ---------- 8. the /pay/[id] checkout page ----------
  console.log('\n--- /pay/[id] checkout page ---');
  const rendered = await PayPage({
    params: Promise.resolve({ id: 'mock_abc123' }),
    searchParams: Promise.resolve({ amount: '18900', for: 'Emergency deposit' }),
  });
  // The page is a tree of components; renderToStaticMarkup needs the whole tree,
  // so assert on what the props resolve to plus the success island's HTML.
  check('checkout page renders without throwing', Boolean(rendered), typeof rendered);
  const successHtml = renderToStaticMarkup(
    createElement(PaymentReceived, {
      reference: 'mock_abc123',
      amountCents: 18900,
      label: 'Emergency deposit',
      businessName: 'Miami Cool Air Conditioning',
      last4: '4242',
      t: makeT('en'),
      locale: 'en',
    }),
  );
  check('success state says "Payment received"', successHtml.includes('Payment received'), successHtml.slice(0, 200));
  check('success state confirms the tech', successHtml.includes('Your tech is confirmed'), successHtml.slice(0, 300));
  check('success state shows the amount paid', successHtml.includes('$189.00'), successHtml.slice(0, 400));

  // ---------- 9. global invariant ----------
  console.log('\n--- invariant: nothing over 300 chars ---');
  const logged = await listSms(BIZ);
  const oversized = logged.filter((s) => s.body.length > SMS_LIMIT);
  check(`all ${logged.length} logged SMS bodies <= ${SMS_LIMIT} chars`, oversized.length === 0,
    oversized.map((s) => ({ len: s.body.length, kind: s.kind })));

  seed(); // leave demo data clean

  console.log(`\n${failCount === 0 ? 'ALL PASS' : 'FAILURES'} (${pass}/${pass + failCount})`);
  if (failCount > 0) process.exit(1);
}

main();
