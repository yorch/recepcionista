import { ok, fail, readJson } from '@/lib/http';
import { authenticate, authErrorResponse } from '@/lib/session';
import { limitRequest } from '@/lib/ratelimit';
import { createUser, EmailTakenError, getBusiness } from '@/lib/db';
import { hashPassword } from '@/lib/password';
import { validateEmail, validateNewPassword } from '@/lib/user-policy';
import type { User } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Admin-only: create an owner or staff login for a business. (Admin accounts are created with scripts/create-user.ts.) */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'admin/users', 20);
  if (limited) return limited;
  try {
    const body = await readJson<{ email?: unknown; password?: unknown; role?: unknown; business_id?: unknown }>(req);
    const bad = validateEmail(body.email) ?? validateNewPassword(body.password);
    if (bad) return fail(bad, 422);
    if (body.role !== 'owner' && body.role !== 'staff') return fail('role must be "owner" or "staff"', 422);
    if (typeof body.business_id !== 'string' || !body.business_id) return fail('business_id is required', 422);
    if (!(await getBusiness(body.business_id))) return fail('business not found', 404);

    const user = await createUser({
      email: body.email as string,
      password_hash: await hashPassword(body.password as string),
      role: body.role,
      business_id: body.business_id,
    });
    return ok<User>(user, 201); // User has no password_hash
  } catch (err) {
    if (err instanceof EmailTakenError) return fail('email already registered', 409);
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
