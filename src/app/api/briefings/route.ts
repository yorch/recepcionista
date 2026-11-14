import { fail, ok } from '@/lib/http';
import { getBusiness, listBriefings } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const businessId = new URL(req.url).searchParams.get('business_id');
    if (!businessId) return fail('business_id is required', 422);
    if (!getBusiness(businessId)) return fail('business not found', 404);
    return ok(listBriefings(businessId));
  } catch (err) {
    return fail(err, 500);
  }
}
