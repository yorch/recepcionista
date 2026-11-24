import { ok, fail, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, scopeBusinessId } from '@/lib/session';
import { extractFromUrl, ExtractionError } from '@/lib/extraction';
import { limitRequest, rateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/log';
import type { ExtractionResult } from '@/lib/types';

const log = logger('api/extract');

export async function POST(req: Request): Promise<ReturnType<typeof ok<ExtractionResult>> | ReturnType<typeof fail>> {
  // Fetches arbitrary URLs (SSRF-guarded in safeFetchText) and spends LLM budget: owners (onboarding / knowledge editor) and admins only.
  const auth = await authenticate(req, { role: 'owner', verifiedEmail: true });
  if (!auth.ok) return auth.response as ReturnType<typeof fail>;
  const limited = await limitRequest(req, 'extract', 10, 60_000, { globalLimit: 300 });
  if (limited) return limited as ReturnType<typeof fail>;
  let requested = '';
  try {
    const { url, business_id } = await readJson<{ url?: string; business_id?: unknown }>(req);
    // Tenant scoping: a user is pinned to their own business (another id is a 404); the per-tenant budget does not depend on client IP.
    const scoped = scopeBusinessId(auth.principal, typeof business_id === 'string' && business_id ? business_id : null);
    if (scoped && auth.principal.kind === 'user') {
      const t = await rateLimit(`extract:biz:${scoped}`, 15, 10 * 60_000);
      if (!t.allowed) {
        return Response.json({ ok: false, error: 'rate limit exceeded' }, { status: 429, headers: { 'retry-after': String(t.retryAfterS) } }) as ReturnType<typeof fail>;
      }
    }
    requested = typeof url === 'string' ? url : '';
    if (!url || typeof url !== 'string') {
      log.warn('rejected', { reason: 'missing url' });
      return fail('missing "url" in body');
    }
    const result = await extractFromUrl(url);
    log.info('done', {
      url,
      name: result.name,
      services: result.services.length,
      confidence: result.confidence,
      source: result.source,
    });
    return ok<ExtractionResult>(result);
  } catch (err) {
    const denied = authErrorResponse(err);
    if (denied) return denied as ReturnType<typeof fail>;
    if (err instanceof ExtractionError) {
      log.warn('rejected', { url: requested, reason: err.message });
      return fail(err.message, 422);
    }
    log.error('failed', { url: requested, err });
    return fail(err, 400);
  }
}
