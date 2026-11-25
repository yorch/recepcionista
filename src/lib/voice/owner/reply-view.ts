/** What the dashboard sees of an owner voice reply: the words and the customer's first name + last 4 digits, never the full number. */
import type { OwnerReply } from '@prisma/client';

export type PublicReplyStatus = 'waiting' | 'sending' | 'sent' | 'uncertain' | 'cancelled' | 'expired' | 'refused' | 'failed';

/** A 'sending' row older than this is shown as 'uncertain' even before the reconcile job moves it (a crash between the claim and the outcome). */
export const STALE_SENDING_VIEW_MS = 5 * 60_000;

export interface PublicOwnerReply {
  id: string;
  status: PublicReplyStatus;
  /** Why it was refused / failed (a fixed word like opted_out, quiet_hours), or null. */
  reason: string | null;
  to_name: string | null;
  to_last4: string;
  body: string;
  segments: number;
  created_at: string;
  sent_at: string | null;
}

export const publicReplyStatus = (r: Pick<OwnerReply, 'status' | 'expiresAt'> & { decidedAt?: Date | null }, now: Date = new Date()): PublicReplyStatus => {
  if (r.status === 'proposed') return r.expiresAt.getTime() > now.getTime() ? 'waiting' : 'expired';
  if (r.status === 'sending') return r.decidedAt && now.getTime() - r.decidedAt.getTime() > STALE_SENDING_VIEW_MS ? 'uncertain' : 'sending';
  return r.status as PublicReplyStatus;
};

export const publicOwnerReply = (r: OwnerReply, now: Date = new Date()): PublicOwnerReply => ({
  id: r.id, status: publicReplyStatus(r, now), reason: r.refuseReason, to_name: r.toName, to_last4: r.toE164.replace(/\D/g, '').slice(-4),
  body: r.body, segments: r.segments, created_at: r.createdAt.toISOString(), sent_at: r.sentAt ? r.sentAt.toISOString() : null,
});
