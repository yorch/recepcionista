import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, auditActorOf, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBooking } from '@/lib/db';
import { refundDeposit } from '@/lib/refund-service';
import { limitRequest } from '@/lib/ratelimit';
import type { NoticeResult } from '@/lib/booking-changes';
import type { Eligibility } from '@/lib/refunds';
import type { Booking } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface RefundRouteResult {
  booking: Booking;
  amount_cents: number;
  /** 'refunded' once Stripe confirmed; 'pending' while it processes (the webhook completes it). */
  status: 'refunded' | 'pending';
  /** True when this exact refund had already been made: nothing new moved. */
  replayed: boolean;
  /** The owner refunded although the policy (or the booking's state) did not call for it. */
  override: boolean;
  partial: boolean;
  policy: Eligibility;
  notice: NoticeResult | null;
}

/**
 * POST /api/bookings/:id/refund   { amount_cents?: number, override?: boolean }   OWNER (or admin), step-up (recent password / 2FA): it moves money.
 * Refunds the paid deposit through Stripe (full when `amount_cents` is omitted, or part of it; never more than was paid). A booking the refund
 * policy does not refund needs `override: true` (audited). Idempotent per booking + amount (Stripe Idempotency-Key): repeating it never refunds
 * twice. Answers 502 `outcome_unknown` when Stripe did not answer (safe to retry), 502 `provider_refused` when it refused.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'bookings/refund', 10);
  if (limited) return limited;
  try {
    const { id } = await params;
    const booking = await getBooking(id);
    requireBusinessAccess(auth.principal, booking?.business_id);
    if (!booking) return fail('booking not found', 404);
    const denied = requireRecentAuth(auth);
    if (denied) return denied;
    const body = await readJson<Record<string, unknown>>(req).catch(() => ({} as Record<string, unknown>));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    for (const k of Object.keys(body)) if (k !== 'amount_cents' && k !== 'override') return fail(`field "${k}" cannot be set here`, 422);
    if (body.override !== undefined && typeof body.override !== 'boolean') return fail('override must be true or false', 422);
    const actor = auditActorOf(auth.principal);
    const out = await refundDeposit({
      businessId: booking.business_id, bookingId: id, amount_cents: body.amount_cents, override: body.override === true,
      actor: { kind: actor.actor_kind, user_id: actor.actor_user_id, ip: clientKey(req), meta: { ...actor.meta } },
    });
    if (!out.ok) {
      return Response.json({ ok: false, error: out.error, code: out.code, ...(out.policy ? { policy: out.policy } : {}) }, { status: out.status, headers: { 'cache-control': 'no-store' } });
    }
    return ok<RefundRouteResult>({ booking: out.booking, amount_cents: out.amount_cents, status: out.status, replayed: out.replayed, override: out.override, partial: out.partial, policy: out.policy, notice: out.notice });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
