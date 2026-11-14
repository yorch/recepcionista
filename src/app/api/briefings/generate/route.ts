import { fail, ok, readJson } from '@/lib/http';
import { generateBriefing } from '@/lib/briefing';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = await readJson<{ business_id?: string; date?: string }>(req);
    if (!body.business_id) return fail('business_id is required', 422);
    const briefing = await generateBriefing(body.business_id, body.date);
    return ok(briefing);
  } catch (err) {
    return fail(err, 500);
  }
}
