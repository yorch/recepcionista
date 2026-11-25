import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, recordAudit, setInboundStatus } from '@/lib/db';
import { getInboxDetail, toInboxItem } from '@/lib/messaging/inbox-view';
import { INBOUND_STATUSES, type InboundStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** One message with the full sender number, the booking it is about and the conversation with that number. Owner or staff of this business. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id, messageId } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business || !ID_RE.test(messageId)) return fail('message not found', 404);
    const detail = await getInboxDetail(business, messageId);
    return detail ? ok(detail) : fail('message not found', 404);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/** PATCH { status: 'new'|'handled'|'ignored' }  Triage. Owner or staff; audited (no message text in the audit row). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id, messageId } = await params;
    requireBusinessAccess(auth.principal, id);
    if (!ID_RE.test(messageId)) return fail('message not found', 404);
    const body = await readJson<{ status?: unknown }>(req);
    if (typeof body?.status !== 'string' || !(INBOUND_STATUSES as readonly string[]).includes(body.status)) return fail('status must be new, handled or ignored', 422);
    const actor = auditActorOf(auth.principal);
    const updated = await setInboundStatus(id, messageId, body.status as InboundStatus, actor.actor_user_id ?? 'admin_token');
    if (!updated) return fail('message not found', 404);
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'inbox.status_changed', target: `inbound_message:${messageId}`, ip: clientKey(req),
      meta: { ...actor.meta, status: updated.status },
    });
    return ok(toInboxItem(updated));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
