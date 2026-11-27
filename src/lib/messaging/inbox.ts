/**
 * Customer texts that are not keywords (STOP/START/HELP/YES, an owner code, a bare C, a 1-5 rating): the owner's inbox.
 *
 * `handleInboundText` is the one place the inbound webhook calls for them. In order:
 *   1. refuse what must never be stored (no sid, the owner's own phone, the business line, an unparseable sender);
 *   2. per-sender and per-business flood limits (a flood is dropped and logged, never forwarded);
 *   3. store it (`recordInboundMessage`, deduped on the Twilio MessageSid, so a redelivery never double-forwards or double-replies);
 *   4. forward a short alert to the VERIFIED owner phone (not in quiet hours, within a per-business hourly budget, once per message);
 *   5. send the customer a one-time acknowledgement (once per sender per 24 h, only if they have not opted out; it goes through
 *      `sendAndLog`, so it obeys the opt-out list, the plan cap and is logged as `inbox_autoreply`).
 * Nothing here throws on a provider failure: the text is already stored, which is the part that must not be lost.
 */
import { configEnv } from '@/lib/config';
import {
  claimEvent, countryForBusiness, getInboundMessageBySid, isOptedOut, linkInboundToBooking, markInboundAutoReplied, setInboundStatus, markInboundForwarded, prisma, recordInboundMessage, releaseEvent,
} from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { rateLimit } from '@/lib/ratelimit';
import { tzOf } from '@/lib/time';
import { logger } from '@/lib/log';
import { sendAndLog } from '@/lib/messaging';
import { mockSmsAllowed, smsDelivered } from '@/lib/messaging/delivery';
import { autoReplyText, ownerForwardLogText, ownerForwardText } from '@/lib/messaging/inbox-copy';
import { isOwnerNumber, ownerAlertStatus } from '@/lib/messaging/owner';
import { POSSIBLE_REVOCATION } from '@/lib/messaging/inbox-view';
import { isQuietHour } from '@/lib/messaging/policy';
import { looksLikeRevocation, normalizeInbound } from '@/lib/messaging/keywords';
import { highRateNanpDestination } from '@/lib/voice/forward-number';
import { alertOwner } from '@/lib/voice/owner-alert';
import type { Business, InboundMessage } from '@/lib/types';

const log = logger('sms/inbox');

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Texts one sender may leave per hour / texts one business may receive per hour before the rest is dropped. */
export const INBOX_SENDER_HOURLY_LIMIT = 10;
export const INBOX_BUSINESS_HOURLY_LIMIT = 300;
export const DEFAULT_INBOX_FORWARD_HOURLY_LIMIT = 10;
/** Owner texts about ONE sender per hour: one number can never spend the whole business forward budget (the rest stays in the dashboard inbox). */
export const INBOX_SENDER_FORWARD_HOURLY_LIMIT = 2;

/** INBOX_FORWARD_HOURLY_LIMIT: owner texts about customer messages per business per hour (default 10, at least 1). */
export function inboxForwardHourlyLimit(env: NodeJS.ProcessEnv = configEnv()): number {
  const raw = (env.INBOX_FORWARD_HOURLY_LIMIT ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 1 ? n : DEFAULT_INBOX_FORWARD_HOURLY_LIMIT;
}

/** Bare acknowledgements ("ok", "yes", "thanks", "gracias", "k", a thumbs-up): kept for the record, but nobody is alerted and nothing is answered. */
const TRIVIAL_ACK = new Set(['OK', 'OKAY', 'K', 'KK', 'YES', 'Y', 'YEP', 'YEAH', 'SI', 'SIP', 'THX', 'TY', 'THANKS', 'THANK YOU', 'THANKS A LOT', 'GRACIAS', 'MUCHAS GRACIAS', 'VALE', 'LISTO', 'PERFECT', 'PERFECTO', 'GOT IT', 'NO', 'NOPE']);
export function isTrivialAck(body: string | null | undefined): boolean {
  const n = normalizeInbound(body);
  if (TRIVIAL_ACK.has(n)) return true;
  return n === '' && /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]+$/u.test((body ?? '').trim()) && (body ?? '').trim().length > 0;
}

export interface InboundTextFields { From?: string; Body?: string; MessageSid?: string; SmsMessageSid?: string }

export type InboundTextOutcome = {
  stored: boolean;
  /** Why nothing was stored. */
  dropped?: 'no_sid' | 'invalid_sender' | 'owner_number' | 'business_line' | 'empty' | 'sender_rate_limited' | 'business_rate_limited' | 'rejected';
  message?: InboundMessage;
  /** The owner alert: 'sent', or why it was not texted (the message is in the inbox either way). */
  forward?: 'sent' | 'duplicate' | 'quiet_hours' | 'budget' | 'sender_budget' | 'no_owner_phone' | 'owner_unverified' | 'failed';
  trivial?: boolean;
  autoReply?: 'sent' | 'skipped_recent' | 'skipped_opted_out' | 'skipped_duplicate' | 'skipped_ineligible' | 'skipped_possible_revocation' | 'skipped_high_rate' | 'blocked' | 'failed';
};

const e164Eligible = (e164: string): boolean => /^\+[1-9]\d{9,14}$/.test(e164); // a real handset-length number: never a short code

export async function handleInboundText(business: Business, fields: InboundTextFields, now: Date = new Date()): Promise<InboundTextOutcome> {
  const country = countryForBusiness(business);
  const sid = (fields.MessageSid || fields.SmsMessageSid || '').trim();
  const from = (fields.From ?? '').trim();
  const body = fields.Body ?? '';
  if (!sid) { log.warn('inbound.no_sid', { business: business.id }); return { stored: false, dropped: 'no_sid' }; }
  const e164 = toE164(from, country);
  if (!e164) return { stored: false, dropped: 'invalid_sender' };
  if (!body.trim()) return { stored: false, dropped: 'empty' };
  // The owner texting their own business number is not a customer; the business line texting itself is a loop.
  if (isOwnerNumber(business, from, country)) return { stored: false, dropped: 'owner_number' };
  if (business.phone_e164 && e164 === business.phone_e164) return { stored: false, dropped: 'business_line' };

  // A redelivery of a text we already hold is not new traffic: it does not spend the flood budgets.
  const known = await getInboundMessageBySid(sid);
  const redelivery = known !== null && known.business_id === business.id;
  // The SENDER's budget is spent first and the business budget only for texts it lets through: one number flooding the line can burn its own 10 per hour
  // and nothing more, so it can never lock every other customer out of the inbox (rejected attempts count against the limiter that rejected them).
  const sender = redelivery ? { allowed: true } : await rateLimit(`inbox:sender:${business.id}:${e164}`, INBOX_SENDER_HOURLY_LIMIT, HOUR_MS);
  if (!sender.allowed) { log.warn('inbound.sender_rate_limited', { business: business.id }); return { stored: false, dropped: 'sender_rate_limited' }; }
  const bizBudget = redelivery ? { allowed: true } : await rateLimit(`inbox:biz:${business.id}`, INBOX_BUSINESS_HOURLY_LIMIT, HOUR_MS);
  if (!bizBudget.allowed) { log.warn('inbound.business_rate_limited', { business: business.id }); return { stored: false, dropped: 'business_rate_limited' }; }

  const rec = await recordInboundMessage({ business_id: business.id, from, body, twilio_message_sid: sid, received_at: now, country });
  if (!rec.ok) { log.warn('inbound.rejected', { business: business.id, reason: rec.reason }); return { stored: false, dropped: 'rejected' }; }
  const message = rec.message;
  const out: InboundTextOutcome = { stored: true, message };

  // Best effort: tie the text to the customer's latest booking so the owner sees what it is about.
  try {
    const booking = await prisma.booking.findFirst({
      where: { businessId: business.id, phoneE164: e164, anonymizedAt: null }, orderBy: { scheduledAt: 'desc' }, select: { id: true },
    });
    if (booking && !message.booking_id) await linkInboundToBooking(business.id, message.id, booking.id);
  } catch (err) {
    log.warn('inbound.link_failed', { business: business.id, err });
  }

  // "ok" / "thanks" / "yes": stored (and marked ignored so it does not count as new), never forwarded or answered.
  if (isTrivialAck(body)) {
    if (message.status === 'new') await setInboundStatus(business.id, message.id, 'ignored', 'auto:acknowledgement', now);
    return { ...out, trivial: true };
  }
  // "Don't text me again" / "remove me from your list" / "Stop. Who is this?": no automatic reply (a reply to an opt-out request is a compliance risk);
  // the text is flagged for the owner, who is told in the forward.
  const revocation = looksLikeRevocation(body);
  if (revocation && message.status === 'new') {
    await prisma.inboundMessage.updateMany({ where: { id: message.id, businessId: business.id, status: 'new' }, data: { handledBy: POSSIBLE_REVOCATION } }).catch(() => undefined);
  }
  out.forward = await forwardToOwner(business, message, now, revocation);
  out.autoReply = revocation ? 'skipped_possible_revocation' : await autoReply(business, message, e164, now);
  return out;
}

/** Revert the "forwarded" stamp after a failed send so a redelivery of the webhook can try again. */
async function unstampForwarded(businessId: string, id: string): Promise<void> {
  await prisma.inboundMessage.updateMany({ where: { id, businessId }, data: { forwardedToOwnerAt: null } }).catch(() => undefined);
}

async function forwardToOwner(business: Business, message: InboundMessage, now: Date, possibleOptOut = false): Promise<NonNullable<InboundTextOutcome['forward']>> {
  if (message.forwarded_to_owner_at) return 'duplicate';
  const status = ownerAlertStatus(business);
  if (status !== 'ok') return status === 'no_owner_phone' ? 'no_owner_phone' : 'owner_unverified';
  // Not at night: the message waits in the dashboard inbox (the badge counts it) instead of waking the owner.
  if (isQuietHour(now, tzOf(business))) return 'quiet_hours';
  // At most 2 owner texts per sender per hour: the rest waits in the inbox (and the badge), and the business budget below is not spent on it.
  const perSender = await rateLimit(`inbox-forward:sender:${business.id}:${message.from_e164}`, INBOX_SENDER_FORWARD_HOURLY_LIMIT, HOUR_MS, { failClosed: true });
  if (!perSender.allowed) return 'sender_budget';
  if (!(await markInboundForwarded(business.id, message.id, now))) return 'duplicate'; // another delivery owns the alert
  const budget = await rateLimit(`inbox-forward:hour:${business.id}`, inboxForwardHourlyLimit(), HOUR_MS, { failClosed: true });
  if (!budget.allowed) {
    log.warn('inbound.forward_budget_spent', { business: business.id, limit_per_hour: inboxForwardHourlyLimit() });
    await unstampForwarded(business.id, message.id);
    return 'budget';
  }
  const last4 = message.from_e164.slice(-4);
  // The sms_log row keeps NO copy of the customer's words (they are only in the inbox row): privacy export and erasure of the customer cover every copy.
  const alert = await alertOwner(business, ownerForwardText(business, { last4 }, message.body, { possibleOptOut }), { class: 'notice', logBody: ownerForwardLogText(business, { last4 }) });
  if (!alert.notified) {
    await unstampForwarded(business.id, message.id);
    return alert.reason === 'owner_unverified' ? 'owner_unverified' : alert.reason === 'no_owner_phone' ? 'no_owner_phone' : 'failed';
  }
  return 'sent';
}

async function autoReply(business: Business, message: InboundMessage, e164: string, now: Date): Promise<NonNullable<InboundTextOutcome['autoReply']>> {
  if (message.auto_replied_at) return 'skipped_duplicate';
  if (!e164Eligible(e164)) return 'skipped_ineligible';
  // Caribbean / Pacific-territory / premium NANP numbers (the SMS-pumping destinations): an inbound text from one is stored and forwarded, never answered.
  if (highRateNanpDestination(e164)) return 'skipped_high_rate';
  const country = countryForBusiness(business);
  if (await isOptedOut(business.id, e164, country)) return 'skipped_opted_out';
  // Serialise the check-then-send for one sender (two texts arriving together must get one reply).
  const claim = `${business.id}:${e164}`;
  if (!(await claimEvent('inbox-autoreply', claim, 60_000))) return 'skipped_recent';
  try {
    const recent = await prisma.smsLog.findFirst({
      where: { businessId: business.id, kind: 'inbox_autoreply', toE164: e164, createdAt: { gte: new Date(now.getTime() - DAY_MS) }, status: { in: mockSmsAllowed() ? ['sent', 'mock'] : ['sent'] } },
      select: { id: true },
    });
    if (recent) return 'skipped_recent';
    if (!(await markInboundAutoReplied(business.id, message.id, now))) return 'skipped_duplicate';
    const { sms, blocked } = await sendAndLog({
      business_id: business.id, to: e164, body: autoReplyText(business, message.body), kind: 'inbox_autoreply', consent_basis: 'customer_initiated_reply', now,
    });
    if (blocked) return 'blocked';
    return smsDelivered(sms.status) ? 'sent' : 'failed';
  } catch (err) {
    log.error('inbound.autoreply_failed', { business: business.id, err });
    return 'failed';
  } finally {
    await releaseEvent('inbox-autoreply', claim);
  }
}
