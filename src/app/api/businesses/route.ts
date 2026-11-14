import { ok, fail, readJson } from '@/lib/http';
import { listBusinesses, createBusiness } from '@/lib/db';
import type { ApiResult, Business } from '@/lib/types';

export async function GET(): Promise<ReturnType<typeof ok<Business[]>> | ReturnType<typeof fail>> {
  try {
    return ok<Business[]>(listBusinesses());
  } catch (err) {
    return fail(err, 500);
  }
}

export async function POST(req: Request): Promise<ReturnType<typeof ok<Business>> | ReturnType<typeof fail>> {
  try {
    const body = await readJson<{ name?: string; url?: string; owner_phone?: string; owner_name?: string }>(req);
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      return fail('missing "name" in body');
    }
    const business = createBusiness({
      name: body.name.trim(),
      url: body.url?.trim() || null,
      owner_phone: body.owner_phone?.trim() || null,
      owner_name: body.owner_name?.trim() || null,
    });
    return ok<Business>(business, 201);
  } catch (err) {
    return fail(err, 400);
  }
}
