import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBooking, recordAudit } from '@/lib/db';
import { ActionError, sendConfirmation } from '@/lib/messaging/actions';
import type { Lang } from '@/lib/messaging/templates';
import type { SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface ResendResult {
  sms: SmsLog;
  /** True when the same booking was already texted in the last two minutes (nothing new was sent). */
  deduped: boolean;
  /** 'sent' | 'mock' | 'failed' | 'blocked_opt_out' | ...: what really happened to the text. */
  status: SmsLog['status'];
}

/**
 * POST /api/bookings/:id/resend-confirmation   { language?: 'en' | 'es' }   OWNER (or admin) only.
 * Goes through the one outbound path (sendConfirmation -> sendAndLog), so opt-outs, quiet hours, the country allow-list and the
 * plan's SMS cap all apply; the answer reports the real status and never claims a blocked text was sent.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    const booking = await getBooking(id);
    requireBusinessAccess(auth.principal, booking?.business_id);
    if (!booking) return fail('booking not found', 404);
    if (booking.status === 'cancelled' || booking.status === 'completed') return fail(`a ${booking.status} booking is not confirmed again`, 409);
    if (booking.anonymized_at) return fail('this booking was anonymised: there is no number to text', 409);
    const body = await readJson<{ language?: unknown }>(req).catch(() => ({} as { language?: unknown }));
    const language: Lang = body.language === 'es' ? 'es' : 'en';
    const out = await sendConfirmation(id, language);
    await recordAudit({
      actor_kind: auth.principal.kind === 'user' ? 'user' : 'admin_token',
      actor_user_id: auth.principal.user?.id ?? null,
      business_id: booking.business_id, action: 'booking.confirmation_resent', target: `booking:${id}`, ip: clientKey(req),
      meta: { status: out.sms.status, deduped: out.deduped },
    });
    return ok<ResendResult>({ sms: out.sms, deduped: out.deduped, status: out.sms.status });
  } catch (err) {
    if (err instanceof ActionError) return fail(err.message, err.status);
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
