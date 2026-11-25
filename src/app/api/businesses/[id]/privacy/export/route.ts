import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { countryForBusiness, getBusiness, recordAudit } from '@/lib/db';
import { exportCustomerData } from '@/lib/privacy';
import { checkPhone, privacyBudget } from '@/lib/messaging/privacy-api';

export const dynamic = 'force-dynamic';

/**
 * POST { phone }  Everything stored about one customer number, as JSON (the dashboard saves it as a file). Owner only, step-up (recent
 * sign-in proof), rate limited, audited (last 4 digits and counts only). POST, so the number never lands in a URL or a log.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);
    const body = await readJson<{ phone?: unknown }>(req);
    const phone = checkPhone(business, body?.phone);
    if (!phone.ok) return phone.response;
    const denied = requireRecentAuth(auth);
    if (denied) return denied;
    const limited = await privacyBudget(id, 'export');
    if (limited) return limited;
    const data = await exportCustomerData(id, phone.e164, countryForBusiness(business));
    const actor = auditActorOf(auth.principal);
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'privacy.export', target: `customer:...${phone.last4}`, ip: clientKey(req),
      meta: { ...actor.meta, calls: data.calls.length, bookings: data.bookings.length, sms: data.sms.length, inbound_messages: data.inbound_messages.length },
    });
    return ok(data);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
