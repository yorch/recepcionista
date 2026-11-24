import { NextResponse } from 'next/server';
import { listPasskeys } from '@/lib/db';
import { accountOf, pkFail } from '@/lib/passkey-http';
import { authenticate } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The caller's own passkeys (names, dates, device type; never key material). */
export async function GET(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = accountOf(auth.principal);
  if (!user) return pkFail(403, 'passkeys belong to personal accounts');
  const passkeys = await listPasskeys(user.id);
  return NextResponse.json({ ok: true, data: { passkeys: passkeys.map(({ user_id: _u, ...p }) => (void _u, p)) } });
}
