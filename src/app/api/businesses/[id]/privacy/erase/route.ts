import { fail, ok, readJson } from '@/lib/http';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess, requireRecentAuth } from '@/lib/session';
import { clientKey } from '@/lib/auth';
import { countryForBusiness, eraseCustomerData, getBusiness, recordAudit } from '@/lib/db';
import { checkPhone, ERASE_CONFIRM_WORD, privacyBudget } from '@/lib/messaging/privacy-api';

export const dynamic = 'force-dynamic';

/**
 * POST { phone, confirm: 'ERASE' }  Permanently erase one customer's data from this business (right to erasure). Owner only, step-up,
 * typed confirmation, rate limited. The audit row is written whatever the outcome and holds only the last 4 digits and the counts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);
    const body = await readJson<{ phone?: unknown; confirm?: unknown }>(req);
    const phone = checkPhone(business, body?.phone);
    if (!phone.ok) return phone.response;
    if (body?.confirm !== ERASE_CONFIRM_WORD) return fail(`type ${ERASE_CONFIRM_WORD} to confirm`, 422);
    const denied = requireRecentAuth(auth);
    if (denied) return denied;
    const limited = await privacyBudget(id, 'erase');
    if (limited) return limited;
    const actor = auditActorOf(auth.principal);
    try {
      const counts = await eraseCustomerData(id, phone.e164, countryForBusiness(business));
      await recordAudit({
        actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'privacy.erase', target: `customer:...${phone.last4}`, ip: clientKey(req),
        meta: { ...actor.meta, ...counts },
      });
      return ok(counts);
    } catch (err) {
      await recordAudit({
        actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: id, action: 'privacy.erase_failed', target: `customer:...${phone.last4}`, ip: clientKey(req), meta: { ...actor.meta },
      });
      throw err;
    }
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
