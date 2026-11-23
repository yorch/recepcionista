import { ok, fail, readJson } from '@/lib/http';
import { authenticate } from '@/lib/session';
import { extractFromUrl, ExtractionError } from '@/lib/extraction';
import { limitRequest } from '@/lib/ratelimit';
import { logger } from '@/lib/log';
import type { ExtractionResult } from '@/lib/types';

const log = logger('api/extract');

export async function POST(req: Request): Promise<ReturnType<typeof ok<ExtractionResult>> | ReturnType<typeof fail>> {
  const auth = await authenticate(req, { role: 'admin' }); // fetches arbitrary URLs + LLM spend; only used by admin onboarding
  if (!auth.ok) return auth.response as ReturnType<typeof fail>;
  const limited = await limitRequest(req, 'extract', 10);
  if (limited) return limited as ReturnType<typeof fail>;
  let requested = '';
  try {
    const { url } = await readJson<{ url?: string }>(req);
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
    if (err instanceof ExtractionError) {
      log.warn('rejected', { url: requested, reason: err.message });
      return fail(err.message, 422);
    }
    log.error('failed', { url: requested, err });
    return fail(err, 400);
  }
}
