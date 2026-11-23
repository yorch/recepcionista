import { fail, ok, readJson } from '@/lib/http';
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
  const limited = limitRequest(req, 'briefings/generate', 5);
  if (limited) return limited;
  try {
    const body = await readJson<{ business_id?: string; date?: string }>(req);
    if (!body.business_id) return fail('business_id is required', 422);
    if (body.date !== undefined && !isValidDate(body.date)) return fail('date must be YYYY-MM-DD', 422);
    const briefing = await generateBriefing(body.business_id, body.date);
    return ok(briefing);
  } catch (err) {
    return fail(err, 500);
  }
}
