import { fail, ok } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { countryForBusiness, getBusiness, getInboundMessage, recordAudit, recordOptOut, setInboundStatus } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST  Opt the sender of an inbox message out of this business's texts (a customer who asked in their own words to stop: "don't text me again").
 * The number is the stored sender of THAT message, never a value from the client. Owner or staff of this business; audited (last 4 digits only);
 * the message is marked handled. Opting back in is the customer's own START.
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
    await recordOptOut(id, message.from_e164, 'manual', countryForBusiness(business));
    const actor = auditActorOf(auth.principal);
    await setInboundStatus(id, messageId, 'handled', actor.actor_user_id ?? 'admin_token');
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'inbox.sender_opted_out', target: `inbound_message:${messageId}`, ip: clientKey(req),
      meta: { ...actor.meta, last4: message.from_e164.slice(-4) },
    });
    return ok({ opted_out: true });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
