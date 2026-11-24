import { fail, ok } from '@/lib/http';
import { authenticate, authErrorResponse, auditActorOf, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBooking, recordAudit } from '@/lib/db';
import { notifyBookingChange, type NoticeResult } from '@/lib/booking-changes';
import { limitRequest } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/bookings/:id/notify   OWNER (or admin): text the customer about the booking's latest change (cancelled, or moved), for when the
 * automatic text was blocked (quiet hours, cap) or skipped (`notify:false`). Same rules as the automatic one: opt-out, quiet hours (owner
 * initiated), SMS cap, segments. 409 when the customer was already told.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'bookings/notify', 20);
  if (limited) return limited;
  try {
    const { id } = await params;
    const booking = await getBooking(id);
    requireBusinessAccess(auth.principal, booking?.business_id);
    if (!booking) return fail('booking not found', 404);
    if (booking.customer_notified_at) return fail('the customer was already told about the latest change', 409);
    if (booking.status !== 'cancelled' && !(booking.reschedule_count && booking.reschedule_count > 0)) return fail('there is no change to tell the customer about', 409);
    const notice = await notifyBookingChange(id, { initiator: 'owner' });
    const actor = auditActorOf(auth.principal);
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: booking.business_id, action: 'booking.customer_notified',
      target: `booking:${id}`, ip: clientKey(req), meta: { ...actor.meta, status: notice.status, kind: notice.kind },
    });
    return ok<NoticeResult>({ status: notice.status, reason: notice.reason, delivered: notice.delivered });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
