import { fail, ok } from '@/lib/http';
import { runGratitudeSweep } from '@/lib/gratitude';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    // Body is optional: the sweep defaults to every business.
    const body = (await req.json().catch(() => ({}))) as { business_id?: string };
    const result = await runGratitudeSweep(body.business_id);
    return ok(result);
  } catch (err) {
    return fail(err, 500);
  }
}
