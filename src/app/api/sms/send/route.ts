import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { sendAndLog } from '@/lib/messaging';
import { getBusiness, isKnownContact } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import { validateRecipient } from '@/lib/messaging/recipient';

export const dynamic = 'force-dynamic';

const MAX_BODY_CHARS = 480;

/**
 * Owner free text to a known contact of THEIR business, still logged. The caller picks only `to` and `body`:
 * the message kind and consent basis are fixed server-side (`manual`: customer policy, opt-outs honoured,
 * STOP footer, quiet hours enforced). `kind` / `consent_basis` in the body are rejected, never honoured, so a
 * tenant cannot label a text `owner_alert` (opt-out exempt) or assert a marketing consent.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'owner' }); // free-text SMS: owner+, known contacts of THEIR business only
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'sms/send', 10, 60_000, { globalLimit: 500 });
  if (limited) return limited;
  try {
    const body = await readJson<{ business_id?: string; to: string; body: string; kind?: unknown; consent_basis?: unknown }>(req);
    if (body.kind !== undefined || body.consent_basis !== undefined) {
      return fail('kind and consent_basis are decided by the server and cannot be set', 422);
    }
    if (typeof body.to !== 'string' || typeof body.body !== 'string' || !body.to || !body.body.trim()
      || (body.business_id !== undefined && typeof body.business_id !== 'string')) {
      return fail('to and body are required (business_id optional for tenant users)', 422);
    }
    if (body.body.length > MAX_BODY_CHARS) return fail(`body must be at most ${MAX_BODY_CHARS} characters`, 422);

    const check = validateRecipient(body.to);
    if (!check.ok) return fail(check.error, 422);
    const to = check.to;

    const businessId = scopeBusinessId(auth.principal, body.business_id);
    if (!businessId) return fail('business_id is required', 422);
    requireBusinessAccess(auth.principal, businessId);
    const business = await getBusiness(businessId);
    if (!business) return fail('business not found', 404);

    // Only known contacts: the owner, a booking customer, or a past caller (indexed E.164 lookups, not a scan of the history).
    if (!(await isKnownContact(business.id, to))) return fail('recipient is not a known contact of this business', 403);

    const { sms } = await sendAndLog({ business_id: business.id, to, body: body.body, kind: 'manual' });
    return ok(sms);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
