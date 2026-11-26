import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { getBusiness, getInboundMessage, recordAudit, setInboundStatus } from '@/lib/db';
import { sendManualText } from '@/lib/messaging/manual';
import { manualFailure } from '@/lib/messaging/manual-http';

export const dynamic = 'force-dynamic';

/**
 * POST { body }  Text the sender of an inbox message. The recipient is the stored sender of THAT message (never a number from the client).
 * Owner or staff; opt-out, plan cap, quiet hours and the STOP footer apply (messaging/manual). A delivered reply marks the message handled.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id, messageId } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    const message = business && /^[A-Za-z0-9_-]{1,64}$/.test(messageId) ? await getInboundMessage(id, messageId) : null;
    if (!business || !message) return fail('message not found', 404);
    const body = await readJson<{ body?: unknown }>(req);
    if (typeof body?.body !== 'string') return fail('body is required', 422);
    const actor = auditActorOf(auth.principal);
    const res = await sendManualText({ business, to: message.from_e164, body: body.body, kind: 'owner_inbox_reply', trustedRecipient: true, bookingId: message.booking_id });
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'inbox.reply_sent', target: `inbound_message:${messageId}`, ip: clientKey(req),
      meta: { ...actor.meta, result: res.ok ? 'sent' : res.reason, chars: body.body.length },
    });
    if (!res.ok) return manualFailure(res.reason);
    await setInboundStatus(id, messageId, 'handled', actor.actor_user_id ?? 'admin_token');
    return ok({ status: res.sms.status, sms_id: res.sms.id });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
