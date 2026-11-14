import { ok, fail, readJson } from '@/lib/http';
import { getBusiness, updateBusiness, getKnowledgeBase, listCalls, listBookings } from '@/lib/db';
import type { ApiResult, Business, KnowledgeBase } from '@/lib/types';

export interface BusinessDetail {
  business: Business;
  knowledge_base: KnowledgeBase | null;
  stats: { calls_today: number; bookings_upcoming: number; revenue_month: number };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ReturnType<typeof ok<BusinessDetail>> | ReturnType<typeof fail>> {
  try {
    const { id } = await params;
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const monthPrefix = now.toISOString().slice(0, 7);

    const calls = await listCalls(id);
    const bookings = await listBookings(id);

    const stats = {
      calls_today: (await listCalls(id, today)).length,
      bookings_upcoming: bookings.filter((b) => b.scheduled_at > now.toISOString() && b.status !== 'cancelled').length,
      revenue_month: bookings
        .filter((b) => b.created_at.startsWith(monthPrefix) && (b.status === 'confirmed' || b.status === 'completed'))
        .reduce((sum, b) => sum + (b.price_estimate ?? 0), 0),
    };
    void calls;

    return ok<BusinessDetail>({ business, knowledge_base: await getKnowledgeBase(id), stats });
  } catch (err) {
    return fail(err, 500);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ReturnType<typeof ok<Business>> | ReturnType<typeof fail>> {
  try {
    const { id } = await params;
    const body = await readJson<Partial<Business>>(req);
    const updated = await updateBusiness(id, body);
    if (!updated) return fail('business not found', 404);
    return ok<Business>(updated);
  } catch (err) {
    return fail(err, 400);
  }
}
