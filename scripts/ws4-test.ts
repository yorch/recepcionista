/**
 * WS4 self-test. Run: bun scripts/ws4-test.ts
 * Exercises the messaging layer directly (no HTTP server needed).
 */
import { execFileSync } from 'node:child_process';
import { getBooking, getBusiness, listSms } from '../src/lib/db';
import {
  confirmationSms, paymentLinkSms, gratitudeSms, reviewRequestSms,
  ownerEscalationSms, formatWhen, SMS_LIMIT,
} from '../src/lib/messaging/templates';
import { sendAndLog } from '../src/lib/messaging';

const BIZ = 'biz_miami_cool_air';
let pass = 0;
let failCount = 0;

function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) {
    failCount++;
    if (detail !== undefined) console.log('       got:', JSON.stringify(detail).slice(0, 500));
  } else pass++;
}

async function main() {
  execFileSync('bun', ['scripts/seed.ts'], { cwd: process.cwd(), stdio: 'ignore' });

  const business = getBusiness(BIZ)!;
  const booking = getBooking('bk_demo_3')!;

  // --- templates ---
  const en = confirmationSms({ business, booking, language: 'en' });
  const es = confirmationSms({ business, booking, language: 'es' });
  check('confirmation EN present', en.includes('Miami Cool Air') && en.includes('Seasonal maintenance'));
  check('confirmation ES differs from EN', es !== en && es.includes('Confirmado'), es);
  check('confirmation EN <= 300 chars', en.length <= SMS_LIMIT, en.length);
  check('confirmation ES <= 300 chars', es.length <= SMS_LIMIT, es.length);
  check('confirmation names first name', en.includes('Rosa'), en);

  const link = paymentLinkSms({
    business, amount_cents: 18900, url: 'https://pay.example.com/x', service: 'Emergency', language: 'en',
  });
  const linkEs = paymentLinkSms({
    business, amount_cents: 18900, url: 'https://pay.example.com/x', service: 'Emergency', language: 'es',
  });
  check('payment link contains url', link.includes('https://pay.example.com/x'));
  check('payment link names amount', link.includes('$189'), link);
  check('payment link ES differs', linkEs !== link && linkEs.includes('Depósito'), linkEs);
  check('payment link <= 300', link.length <= SMS_LIMIT && linkEs.length <= SMS_LIMIT);

  const grat = gratitudeSms({ business, booking, language: 'en' });
  const gratEs = gratitudeSms({ business, booking, language: 'es' });
  check('gratitude asks 1-5', grat.includes('1-5'), grat);
  check('gratitude ES localized', gratEs.includes('Responda'), gratEs);
  check('gratitude <= 300', grat.length <= SMS_LIMIT && gratEs.length <= SMS_LIMIT);

  const review = reviewRequestSms({ business, booking, reviewUrl: 'https://g.page/x' });
  check('review ask contains link', review.includes('https://g.page/x'));

  const esc = ownerEscalationSms({ business, customer: 'Rosa', reason: 'AC still hot' });
  check('escalation quotes the reason', esc.includes('AC still hot'));

  const whenEn = formatWhen(booking.scheduled_at, 'en');
  const whenEs = formatWhen(booking.scheduled_at, 'es');
  check('formatWhen EN readable', /at \d/.test(whenEn), whenEn);
  check('formatWhen ES readable', /a las \d/.test(whenEs), whenEs);

  // --- send path ---
  const before = listSms(BIZ).length;
  const sent = await sendAndLog({
    business_id: BIZ,
    to: '+13055550166',
    body: es,
    kind: 'confirmation',
  });
  check('sendAndLog returns a log row', Boolean(sent.sms.id));
  check('sendAndLog status is sent or mock', sent.status === 'sent' || sent.status === 'mock', sent.status);
  check('sendAndLog persisted a row', listSms(BIZ).length === before + 1);

  execFileSync('bun', ['scripts/seed.ts'], { cwd: process.cwd(), stdio: 'ignore' });

  console.log(`\n${failCount === 0 ? 'ALL PASS' : 'FAILURES'} (${pass}/${pass + failCount})`);
  if (failCount > 0) process.exit(1);
}

main();
