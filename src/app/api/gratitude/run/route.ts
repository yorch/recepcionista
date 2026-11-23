import { fail, ok } from '@/lib/http';
import { guardAdmin } from '@/lib/admin-guard';
import { limitRequest } from '@/lib/ratelimit';
import { runGratitudeSweep } from '@/lib/gratitude';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const denied = await guardAdmin();
  if (denied) return denied;
  const limited = limitRequest(req, 'gratitude/run', 3);
  if (limited) return limited;
  try {
    // Body is optional: the sweep defaults to every business.
    const body = (await req.json().catch(() => ({}))) as { business_id?: string };
    const result = await runGratitudeSweep(body.business_id);
    return ok(result);
  } catch (err) {
    return fail(err, 500);
  }
}
