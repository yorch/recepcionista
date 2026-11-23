import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess, scopeBusinessId } from '@/lib/session';
import { limitRequest } from '@/lib/ratelimit';
import { generateBriefing } from '@/lib/briefing';

function isValidDate(d: unknown): d is string {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'owner' }); // spends LLM/TTS budget: owner+
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'briefings/generate', 5);
  if (limited) return limited;
  try {
    const body = await readJson<{ business_id?: string; date?: string }>(req);
    const businessId = scopeBusinessId(auth.principal, body.business_id);
    if (!businessId) return fail('business_id is required', 422);
    requireBusinessAccess(auth.principal, businessId);
    if (body.date !== undefined && !isValidDate(body.date)) return fail('date must be YYYY-MM-DD', 422);
    const briefing = await generateBriefing(businessId, body.date);
    return ok(briefing);
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
