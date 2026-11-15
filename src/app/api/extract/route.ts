import { ok, fail, readJson } from '@/lib/http';
import { extractFromUrl, ExtractionError } from '@/lib/extraction';
import type { ExtractionResult } from '@/lib/types';

export async function POST(req: Request): Promise<ReturnType<typeof ok<ExtractionResult>> | ReturnType<typeof fail>> {
  try {
    const { url } = await readJson<{ url?: string }>(req);
    if (!url || typeof url !== 'string') return fail('missing "url" in body');
    const result = await extractFromUrl(url);
    return ok<ExtractionResult>(result);
  } catch (err) {
    if (err instanceof ExtractionError) return fail(err.message, 422);
    return fail(err, 400);
  }
}
