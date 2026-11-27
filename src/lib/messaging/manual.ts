/**
 * A text the OWNER or staff types in the dashboard: a free-form message to one customer ("manual") or the answer to an inbox message
 * ("owner_inbox_reply"). Always through `sendAndLog`, so it obeys the opt-out list, the plan cap, the STOP footer and the quiet hours
 * (9pm-8am in the business zone), and is logged (the dashboard's message log reads that table).
 *
 * Abuse limits: the recipient must be a number this business already has a relationship with (a booking, a call or an inbox
 * message), so the dashboard is not an open SMS relay; and the volume is capped per business and per recipient per hour.
 */
import { countryForBusiness, prisma } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { rateLimit } from '@/lib/ratelimit';
import { tzOf } from '@/lib/time';
import { sendAndLog } from '@/lib/messaging';
import { smsDelivered } from '@/lib/messaging/delivery';
import { MANUAL_TEXT_MAX } from '@/lib/messaging/manual-limits';
import { isQuietHour } from '@/lib/messaging/policy';
import { highRateNanpDestination } from '@/lib/voice/forward-number';
import type { Business, SmsLog } from '@/lib/types';
import { quietWindowFor } from '@/lib/admin/tenant-knobs';

export { MANUAL_TEXT_MAX };

/** Longest manual text INCLUDING the STOP footer (". Reply STOP to opt out" is 23 characters). */
const MAX_WITH_FOOTER = MANUAL_TEXT_MAX + 30;
const HOUR_MS = 60 * 60_000;
/** Control characters (except newline) and invisible direction/line-separator marks never go into a text. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0009\\u000B-\\u001F\\u007F\\u200B-\\u200F\\u2028-\\u202E\\u2066-\\u2069]', 'g');
export const MANUAL_BUSINESS_HOURLY_LIMIT = 40;
export const MANUAL_RECIPIENT_HOURLY_LIMIT = 6;

export type ManualTextResult =
  | { ok: true; sms: SmsLog; delivered: boolean }
  | { ok: false; reason: 'invalid_recipient' | 'unknown_recipient' | 'empty' | 'too_long' | 'rate_limited' | 'quiet_hours' | 'opted_out' | 'cap_reached' | 'not_allowed' | 'high_rate_destination' | 'send_failed'; sms?: SmsLog };

/** Is `e164` a customer of this business (booking, call or inbox message), erased or anonymised records excluded? */
export async function isKnownCustomerNumber(businessId: string, e164: string): Promise<boolean> {
  const [booking, call, inbound] = await Promise.all([
    prisma.booking.findFirst({ where: { businessId, phoneE164: e164, anonymizedAt: null }, select: { id: true } }),
    prisma.call.findFirst({ where: { businessId, callerE164: e164 }, select: { id: true } }),
    prisma.inboundMessage.findFirst({ where: { businessId, fromE164: e164 }, select: { id: true } }),
  ]);
  return Boolean(booking || call || inbound);
}

export interface ManualTextInput {
  business: Business;
  /** Any form of the customer's number; read in the business's country. */
  to: string;
  body: string;
  kind: 'manual' | 'owner_inbox_reply';
  /** For a reply: the recipient came from the stored message, so the "known customer" check is already satisfied. */
  trustedRecipient?: boolean;
  bookingId?: string | null;
  now?: Date;
}

export async function sendManualText(input: ManualTextInput): Promise<ManualTextResult> {
  const { business } = input;
  const now = input.now ?? new Date();
  const body = (input.body ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
  if (!body) return { ok: false, reason: 'empty' };
  if ([...body].length > MANUAL_TEXT_MAX) return { ok: false, reason: 'too_long' };
  const e164 = toE164(input.to, countryForBusiness(business));
  if (!e164) return { ok: false, reason: 'invalid_recipient' };
  if (e164 === business.owner_phone_e164 || e164 === business.phone_e164) return { ok: false, reason: 'not_allowed' };
  if (!input.trustedRecipient && !(await isKnownCustomerNumber(business.id, e164))) return { ok: false, reason: 'unknown_recipient' };
  // Caribbean / Pacific-territory / premium NANP numbers cost far more per text and are the SMS-pumping destinations: an owner text goes there only to a
  // number that has a booking with this business (an inbox message or a call alone is not enough: anyone can text the business line from such a number).
  if (highRateNanpDestination(e164) && !(await prisma.booking.findFirst({ where: { businessId: business.id, phoneE164: e164, anonymizedAt: null }, select: { id: true } }))) {
    return { ok: false, reason: 'high_rate_destination' };
  }
  // Quiet hours apply to every owner-typed text (the policy itself only blocks kind 'manual'; replies are held to the same rule here).
  if (isQuietHour(now, tzOf(business), await quietWindowFor(business.id))) return { ok: false, reason: 'quiet_hours' };

  const biz = await rateLimit(`manual-sms:biz:${business.id}`, MANUAL_BUSINESS_HOURLY_LIMIT, HOUR_MS, { failClosed: true });
  const to = await rateLimit(`manual-sms:to:${business.id}:${e164}`, MANUAL_RECIPIENT_HOURLY_LIMIT, HOUR_MS, { failClosed: true });
  if (!biz.allowed || !to.allowed) return { ok: false, reason: 'rate_limited' };

  const { sms, blocked } = await sendAndLog({
    business_id: business.id, to: e164, body, kind: input.kind, booking_id: input.bookingId ?? null,
    consent_basis: input.kind === 'owner_inbox_reply' ? 'customer_reply' : 'owner_manual', max_chars: MAX_WITH_FOOTER, now,
  });
  if (blocked) {
    const reason = blocked === 'blocked_opt_out' ? 'opted_out' : blocked === 'blocked_cap' ? 'cap_reached' : blocked === 'blocked_quiet_hours' ? 'quiet_hours' : 'not_allowed';
    return { ok: false, reason, sms };
  }
  if (!smsDelivered(sms.status)) return { ok: false, reason: 'send_failed', sms };
  return { ok: true, sms, delivered: true };
}
