/**
 * "Reply C to cancel": the booking confirmation text promises it, this is the handler (called by /api/sms/inbound AFTER signature
 * verification, STOP/START/HELP handling and the owner YES/NO/UNDO commands, so every opt-out keyword keeps precedence).
 *
 *  - ONLY the bare letter C (case, accents and punctuation folded: "c", "C.", "C!"). "CANCEL" is a STOP-class keyword under Twilio's
 *    opt-out semantics and stays an opt-out; the footer text therefore says "Reply C".
 *  - The sender must be the booking's own number (its E.164): it cancels THAT sender's next upcoming booking for the business the inbound
 *    number belongs to (the number is unique to one business). Exactly one upcoming booking -> cancel it; none -> say so; several -> ask
 *    them to call (never guess which one).
 *  - Cancelling goes through the same function as the dashboard and the voice tool (booking-changes.cancelBooking): atomic transition,
 *    refund bookkeeping, audit, calendar/webhook hooks. The reply carries the refund-policy verdict text (the app never refunds by itself).
 *  - Rate limited per sender and per business; Twilio retries are deduplicated by MessageSid. A sender who opted out of this business's
 *    texts still gets their cancellation processed (it is their own explicit request) but receives NO reply text.
 * Returns the TwiML reply (possibly empty), or null when the message is not a bare C.
 */
import { countryForBusiness, getBooking, isOptedOut, claimEvent, completeEvent, prisma, recordAudit } from '@/lib/db';
import { cancelBooking, customerLanguage } from '@/lib/booking-changes';
import { meterSms } from '@/lib/messaging';
import { normalizeInbound, twiml } from '@/lib/messaging/keywords';
import { smsSegments } from '@/lib/messaging/policy';
import { cancelSms } from '@/lib/messaging/templates';
import { toE164 } from '@/lib/phone';
import { rateLimit } from '@/lib/ratelimit';
import { bookingRefundEligibility } from '@/lib/refunds';
import { logger } from '@/lib/log';
import type { Business } from '@/lib/types';

const log = logger('sms/cancel');

export const isCancelReply = (body: string | null | undefined): boolean => normalizeInbound(body) === 'C';

type Lang = 'en' | 'es';

export async function handleCancelReply(business: Business, from: string, body: string | null | undefined, opts: { messageSid?: string | null; now?: Date } = {}): Promise<string | null> {
  if (!isCancelReply(body)) return null;
  const now = opts.now ?? new Date();
  const country = countryForBusiness(business);
  const sender = toE164(from, country);
  const lang: Lang = business.locale_default === 'es' ? 'es' : 'en';
  const t = (en: string, es: string) => (lang === 'es' ? es : en);
  if (!sender) return twiml(); // an alphanumeric / unparseable sender is never a customer's phone

  const [perSender, perBusiness] = await Promise.all([
    rateLimit(`sms-cancel:${business.id}:${sender}`, 5, 10 * 60_000),
    rateLimit(`sms-cancel:${business.id}`, 120, 60 * 60_000),
  ]);
  if (!perSender.allowed || !perBusiness.allowed) { log.warn('rate_limited', { business: business.id }); return twiml(); }

  const sid = (opts.messageSid ?? '').trim();
  if (sid && !(await claimEvent('sms_cancel', `${business.id}:${sid}`, 60_000))) return twiml(); // a Twilio retry of the same message
  const optedOut = await isOptedOut(business.id, from, country);
  const reply = async (text: string): Promise<string> => {
    if (optedOut) return twiml(); // they opted out of our texts: honour it, even for this answer
    await meterSms(business.id, smsSegments(text));
    return twiml(text);
  };
  const audit = (action: string, meta: Record<string, unknown>) => recordAudit({ actor_kind: 'webhook', business_id: business.id, action, target: `business:${business.id}`, meta: { source: 'sms_reply', ...meta } });

  const upcoming = await prisma.booking.findMany({
    where: { businessId: business.id, phoneE164: sender, status: { in: ['pending', 'confirmed'] }, scheduledAt: { gt: now }, anonymizedAt: null },
    orderBy: { scheduledAt: 'asc' }, take: 3, select: { id: true },
  });
  const callUs = business.phone ? t(` Please call ${business.name} at ${business.phone}.`, ` Por favor llame a ${business.name} al ${business.phone}.`) : t(` Please call ${business.name}.`, ` Por favor llame a ${business.name}.`);

  if (upcoming.length === 0) {
    await audit('booking.sms_cancel_refused', { why: 'no_upcoming_booking' });
    return reply(t(`${business.name}: We could not find an upcoming booking for this number.${callUs}`, `${business.name}: No encontramos una cita próxima para este número.${callUs}`));
  }
  if (upcoming.length > 1) {
    await audit('booking.sms_cancel_refused', { why: 'several_upcoming_bookings' });
    return reply(t(`${business.name}: You have more than one upcoming booking, so we cannot tell which one to cancel.${callUs}`, `${business.name}: Tiene más de una cita próxima y no sabemos cuál cancelar.${callUs}`));
  }

  const out = await cancelBooking({
    businessId: business.id, bookingId: upcoming[0].id, actor: { kind: 'webhook', meta: { source: 'sms_reply', channel: 'sms' } },
    reason: 'customer_sms_reply', notify: false, initiator: 'customer', now,
  });
  if (sid) await completeEvent('sms_cancel', `${business.id}:${sid}`);
  if (!out.ok) {
    await audit('booking.sms_cancel_refused', { why: out.reason });
    return reply(t(`${business.name}: We could not cancel that booking by text.${callUs}`, `${business.name}: No pudimos cancelar la cita por texto.${callUs}`));
  }
  const booking = (await getBooking(out.booking.id)) ?? out.booking;
  const e = bookingRefundEligibility(booking, business.refund_policy, now);
  const deposit = e.reason === 'no_deposit' ? { state: 'none' as const } : { state: e.eligible ? ('refundable' as const) : ('not_refundable' as const), amount_cents: booking.deposit_amount ?? 0 };
  const language = await customerLanguage(booking, business);
  return reply(cancelSms({ business, booking, language, deposit }));
}
