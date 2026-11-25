import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, recordAudit } from '@/lib/db';
import { sendManualText } from '@/lib/messaging/manual';
import { manualFailure } from '@/lib/messaging/manual-http';

export const dynamic = 'force-dynamic';

/** POST { to, body }  A free-form text to one customer of this business (known from a booking, call or inbox message). Owner or staff; logged and audited. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);
    const input = await readJson<{ to?: unknown; body?: unknown }>(req);
    if (typeof input?.to !== 'string' || typeof input?.body !== 'string') return fail('to and body are required', 422);
    const actor = auditActorOf(auth.principal);
    const res = await sendManualText({ business, to: input.to, body: input.body, kind: 'manual' });
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'sms.manual_sent', target: `business:${id}`, ip: clientKey(req),
      meta: { ...actor.meta, result: res.ok ? 'sent' : res.reason, to_last4: input.to.replace(/\D/g, '').slice(-4), chars: input.body.length },
    });
    if (!res.ok) return manualFailure(res.reason);
    return ok({ status: res.sms.status, sms_id: res.sms.id });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
