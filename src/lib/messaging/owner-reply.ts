/**
 * Owner voice replies, the SEND side. A reply is drafted on the private owner line (voice/owner/reply-tools.ts) and recorded as 'proposed'; it goes to
 * the customer ONLY here, when the owner texts `YES <code>` from the verified owner phone (voice/owner/reply-sms.ts). Everything that can stop a
 * customer text is decided at this moment, from the database and the clock, never from what the model said earlier:
 *
 *  - single use: the 'proposed' -> 'sending' claim is one atomic UPDATE, so a replayed code, a Twilio retry or two racing YES texts send at most once
 *    (a crash after the claim leaves 'sending': the text is NEVER retried, the owner is not told it was sent; the reconcile job moves a stale
 *    'sending' row to 'uncertain', and the dashboard shows it as such);
 *  - the per-business daily cap and the identical-text guard are decided in the SAME transaction as the claim, under an advisory lock, and count
 *    sent | sending | uncertain rows, so racing YES texts cannot overrun them;
 *  - once the provider accepted the text it is SENT: a failure afterwards (the sms_log write, the status update) never turns it into "failed", and
 *    an unknown provider outcome (timeout) is 'uncertain', which the duplicate guard also covers;
 *  - 30 minute expiry, recipient re-derived from the lead row of THIS business (erased / anonymised / foreign rows refuse), never the owner phone or
 *    the business line;
 *  - the usual outbound policy through sendAndLog (opt-out list, quiet hours 9 PM - 8 AM in the business zone, plan SMS cap, STOP footer), plus a
 *    per-business daily cap, a per-customer hourly cap and an identical-text guard.
 * Quiet hours REFUSE (nothing is queued): a deferred text would outlive the confirmation the owner just gave.
 */
import { countryForBusiness, isOptedOut, prisma, recordAudit } from '@/lib/db';
import { logSms } from '@/lib/db';
import { SentNotLoggedError, sendAndLog } from '@/lib/messaging';
import { isQuietHour } from '@/lib/messaging/policy';
import { rateLimit } from '@/lib/ratelimit';
import { tzOf } from '@/lib/time';
import { logger } from '@/lib/log';
import { ownerReplyDailyLimit, ownerReplyEnabled, OWNER_REPLY_LEAD_WINDOW_MS, OWNER_REPLY_PER_CUSTOMER_HOUR } from '@/lib/voice/owner/reply-config';
import { customerReplyText } from '@/lib/voice/owner/reply-text';
import type { Business } from '@/lib/types';
import type { OwnerReply } from '@prisma/client';

const log = logger('owner-reply');

export type ReplyRefusal =
  | 'disabled' | 'lead_gone' | 'self' | 'daily_limit' | 'duplicate' | 'opted_out' | 'quiet_hours' | 'customer_limit' | 'too_long' | 'no_consent' | 'cap' | 'blocked';

export type ReplyOutcome =
  | { kind: 'sent'; name: string | null; segments: number }
  | { kind: 'refused'; reason: ReplyRefusal; name: string | null }
  | { kind: 'failed'; name: string | null }
  | { kind: 'uncertain'; name: string | null }
  | { kind: 'expired' }
  | { kind: 'already'; status: string };

export const CONSENT_BASIS = 'owner_voice_reply';

export async function auditReply(action: string, businessId: string, reply: Pick<OwnerReply, 'id'> | null, meta: Record<string, unknown> = {}): Promise<void> {
  await recordAudit({
    actor_kind: 'system', actor_user_id: null, business_id: businessId, action: `owner_reply.${action}`,
    target: reply ? `owner_reply:${reply.id}` : `business:${businessId}`, ip: null, meta, // never the message, the number or the name
  }).catch(() => {});
}

const finish = async (id: string, data: { status: 'refused' | 'failed' | 'sent' | 'expired' | 'cancelled' | 'uncertain'; refuseReason?: string | null; smsLogId?: string | null; segments?: number; sentAt?: Date; decidedAt?: Date }) =>
  prisma.ownerReply.update({ where: { id }, data: { ...data, decidedAt: data.decidedAt ?? new Date() } });

/** The lead row the recipient came from must still exist, belong to this business and still carry the SAME number (erasure nulls / deletes it). */
async function leadStillValid(reply: OwnerReply, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - 2 * OWNER_REPLY_LEAD_WINDOW_MS); // a reply drafted on day 7 may still be confirmed (30 min), so allow slack
  if (reply.leadKind === 'call' && reply.leadCallId) {
    const c = await prisma.call.findFirst({ where: { id: reply.leadCallId, businessId: reply.businessId, kind: 'customer', callerE164: reply.toE164, startedAt: { gte: since } }, select: { id: true } });
    return c !== null;
  }
  if (reply.leadKind === 'booking' && reply.leadBookingId) {
    const b = await prisma.booking.findFirst({ where: { id: reply.leadBookingId, businessId: reply.businessId, phoneE164: reply.toE164, anonymizedAt: null, createdAt: { gte: since } }, select: { id: true } });
    return b !== null;
  }
  return false;
}

/** Rows that may have put (or are putting) a text in front of the customer: they count toward the daily cap and the duplicate guard. */
const SENT_LIKE = ['sent', 'sending', 'uncertain'] as const;

type ClaimResult = { kind: 'claimed' } | { kind: 'refused'; reason: ReplyRefusal } | { kind: 'not_claimed' };

/**
 * The claim, the daily cap and the duplicate guard in ONE transaction under a per-business advisory lock: two YES texts racing for different
 * drafts see each other's 'sending' rows, so the cap cannot be overrun. A refusal is written in the same transaction.
 */
async function claimReply(business: Business, replyId: string, now: Date): Promise<ClaimResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`owner-reply-send:${business.id}`}))`;
    const row = await tx.ownerReply.findFirst({ where: { id: replyId, businessId: business.id, status: 'proposed', expiresAt: { gt: now } } });
    if (!row) return { kind: 'not_claimed' } as const;
    const day = new Date(now.getTime() - 24 * 3600_000);
    const sentToday = await tx.ownerReply.count({ where: { businessId: business.id, status: { in: [...SENT_LIKE] }, decidedAt: { gte: day } } });
    const hourAgo = new Date(now.getTime() - 3600_000);
    const dup = sentToday >= ownerReplyDailyLimit() ? 0 : await tx.ownerReply.count({
      where: { businessId: business.id, toE164: row.toE164, body: row.body, id: { not: row.id }, status: { in: [...SENT_LIKE] }, decidedAt: { gte: hourAgo } },
    });
    const refuse = sentToday >= ownerReplyDailyLimit() ? 'daily_limit' : dup > 0 ? 'duplicate' : null;
    if (refuse) {
      await tx.ownerReply.update({ where: { id: row.id }, data: { status: 'refused', refuseReason: refuse, decidedAt: now } });
      return { kind: 'refused', reason: refuse } as const;
    }
    const claim = await tx.ownerReply.updateMany({ where: { id: row.id, status: 'proposed' }, data: { status: 'sending', decidedAt: now } });
    return claim.count === 1 ? ({ kind: 'claimed' } as const) : ({ kind: 'not_claimed' } as const);
  });
}

/** Provider errors that say nothing about whether the text went out (the request may have reached the carrier before the timeout). */
const AMBIGUOUS_PROVIDER_ERROR = /timeout|timed out|abort|network|socket|reset|econn|fetch failed|terminated/i;

/** Confirm (YES): send the text if, and only if, every check still passes. Idempotent: a second call reports what already happened. */
export async function confirmOwnerReply(business: Business, replyId: string, now: Date = new Date()): Promise<ReplyOutcome> {
  const claimed = await claimReply(business, replyId, now);
  if (claimed.kind === 'refused') {
    const row = await prisma.ownerReply.findFirst({ where: { id: replyId, businessId: business.id } });
    await auditReply('refused', business.id, { id: replyId }, { reason: claimed.reason });
    return { kind: 'refused', reason: claimed.reason, name: row?.toName ?? null };
  }
  if (claimed.kind === 'not_claimed') {
    const row = await prisma.ownerReply.findFirst({ where: { id: replyId, businessId: business.id } });
    if (row && row.status === 'proposed') { // past its 30 minutes
      const expired = await prisma.ownerReply.updateMany({ where: { id: row.id, status: 'proposed' }, data: { status: 'expired', decidedAt: now } });
      if (expired.count === 1) await auditReply('expired', business.id, row);
      return { kind: 'expired' };
    }
    return { kind: 'already', status: row?.status ?? 'unknown' };
  }
  const reply = await prisma.ownerReply.findUniqueOrThrow({ where: { id: replyId } });
  const name = reply.toName;
  const refuse = async (reason: ReplyRefusal): Promise<ReplyOutcome> => {
    await finish(reply.id, { status: 'refused', refuseReason: reason });
    await auditReply('refused', business.id, reply, { reason });
    log.info('refused', { business: business.id, reason });
    return { kind: 'refused', reason, name };
  };
  let accepted = false; // the provider took the text: from here on it is SENT, whatever else fails
  let smsId: string | null = null;
  let segments = reply.segments;
  const markSent = async (): Promise<void> => {
    // Best effort, a few tries: the text is out, so the row must say so even when the database is flaky.
    for (let i = 0; i < 3; i++) {
      try { await finish(reply.id, { status: 'sent', smsLogId: smsId, segments, sentAt: new Date() }); break; } catch (e) { log.error('mark_sent_failed', { reply: reply.id, try: i, err: e }); }
    }
    await auditReply('sent', business.id, reply, { sms: smsId, segments });
  };
  try {
    if (!ownerReplyEnabled()) return await refuse('disabled');
    if (!(await leadStillValid(reply, now))) return await refuse('lead_gone');
    if (reply.toE164 === business.owner_phone_e164 || (business.phone_e164 && reply.toE164 === business.phone_e164)) return await refuse('self');
    const country = countryForBusiness(business);
    // The opt-out list always wins (sendAndLog checks it again; checked here to say so honestly and to burn no budget).
    if (await isOptedOut(business.id, reply.toE164, country)) return await refuse('opted_out');
    if (isQuietHour(now, tzOf(business))) return await refuse('quiet_hours');
    const text = customerReplyText(business.name, reply.body);
    if (!text.ok) return await refuse('too_long');
    segments = text.segments;
    const hour = await rateLimit(`owner-reply:cust:${business.id}:${reply.toE164}`, OWNER_REPLY_PER_CUSTOMER_HOUR, 3600_000, { failClosed: true });
    if (!hour.allowed) return await refuse('customer_limit');

    let sentOut: Awaited<ReturnType<typeof sendAndLog>>;
    try {
      sentOut = await sendAndLog({ business_id: business.id, to: reply.toE164, body: text.text, kind: 'manual', consent_basis: CONSENT_BASIS, now });
    } catch (err) {
      if (!(err instanceof SentNotLoggedError)) throw err;
      // The provider accepted the text; only the sms_log row is missing. It is sent. Try once more to write the log row, then say so.
      accepted = true;
      log.error('sent_not_logged', { business: business.id, reply: reply.id, err });
      try {
        const sms = await logSms({ business_id: business.id, to_phone: reply.toE164, body: text.text, kind: 'manual', booking_id: null, provider_id: err.result.id || null, status: err.result.status === 'mock' ? 'mock' : 'sent', consent_basis: CONSENT_BASIS }, { country });
        smsId = sms.id;
      } catch { /* best effort */ }
      await markSent();
      return { kind: 'sent', name, segments };
    }
    const { sms, result, blocked } = sentOut;
    smsId = sms.id;
    if (blocked) {
      const reason: ReplyRefusal = blocked === 'blocked_opt_out' ? 'opted_out' : blocked === 'blocked_quiet_hours' ? 'quiet_hours' : blocked === 'blocked_no_consent' ? 'no_consent' : blocked === 'blocked_cap' ? 'cap' : 'blocked';
      await finish(reply.id, { status: 'refused', refuseReason: reason, smsLogId: sms.id });
      await auditReply('refused', business.id, reply, { reason, sms: sms.id });
      return { kind: 'refused', reason, name };
    }
    if (result.status === 'failed') {
      if (AMBIGUOUS_PROVIDER_ERROR.test(result.error ?? '')) { // a timeout: the carrier may still have taken it. Never retried, never called "not sent".
        accepted = true;
        await finish(reply.id, { status: 'uncertain', refuseReason: 'provider_unknown', smsLogId: sms.id });
        await auditReply('uncertain', business.id, reply, { sms: sms.id });
        return { kind: 'uncertain', name };
      }
      await finish(reply.id, { status: 'failed', refuseReason: 'provider', smsLogId: sms.id });
      await auditReply('failed', business.id, reply, { sms: sms.id });
      return { kind: 'failed', name };
    }
    accepted = true;
    await markSent();
    return { kind: 'sent', name, segments };
  } catch (err) {
    log.error('send_failed', { business: business.id, reply: reply.id, accepted, err });
    if (accepted) { // the text is out; only the bookkeeping failed. Never "failed": that would invite a second copy.
      await markSent().catch(() => {});
      return { kind: 'sent', name, segments };
    }
    // Failure before the provider was reached: nothing went out, nothing was charged to the customer.
    await prisma.ownerReply.updateMany({ where: { id: reply.id, status: 'sending' }, data: { status: 'failed', refuseReason: 'error' } }).catch(() => {});
    await auditReply('failed', business.id, reply, { error: true });
    return { kind: 'failed', name };
  }
}

/**
 * Rows stuck in 'sending' (a crash between the claim and the outcome) become 'uncertain' after a grace period: the text may or may not have gone
 * out, it is never retried, and the owner is told to check. Called by the reconcile job. Returns how many rows moved.
 */
export const STALE_SENDING_MS = 10 * 60_000;
export async function sweepStaleOwnerReplies(now: Date = new Date()): Promise<number> {
  const res = await prisma.ownerReply.updateMany({
    where: { status: 'sending', decidedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    data: { status: 'uncertain', refuseReason: 'stalled' },
  });
  return res.count;
}

/** Cancel (NO): only while the reply is still waiting. */
export async function cancelOwnerReply(business: Business, replyId: string, now: Date = new Date()): Promise<{ cancelled: boolean; status: string; name: string | null }> {
  const res = await prisma.ownerReply.updateMany({ where: { id: replyId, businessId: business.id, status: 'proposed' }, data: { status: 'cancelled', decidedAt: now } });
  const row = await prisma.ownerReply.findFirst({ where: { id: replyId, businessId: business.id }, select: { id: true, status: true, toName: true } });
  if (res.count === 1 && row) await auditReply('cancelled', business.id, row);
  return { cancelled: res.count === 1, status: row?.status ?? 'unknown', name: row?.toName ?? null };
}
