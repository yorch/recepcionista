import { NextResponse } from 'next/server';
import { countPasskeys, MAX_PASSKEYS_PER_USER } from '@/lib/db';
import { accountOf, configOr503, pkFail } from '@/lib/passkey-http';
import { rateLimit } from '@/lib/ratelimit';
import { authenticate, requireRecentAuth } from '@/lib/session';
import { beginRegistration } from '@/lib/webauthn';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/passkeys/register/options');

/**
 * POST: start registering a passkey for the signed-in account. Needs a RECENT proof of identity (a stolen cookie must not be able to plant a
 * persistent credential): 403 `reauth_required` otherwise. At most 20 passkeys per account; the account's existing credentials are excluded.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true, verifiedEmail: true });
  if (!auth.ok) return auth.response;
  const user = accountOf(auth.principal);
  if (!user) return pkFail(403, 'passkeys belong to personal accounts');
  const stale = requireRecentAuth(auth);
  if (stale) return stale;
  const conf = configOr503(req);
  if ('response' in conf) return conf.response;
  const gate = await rateLimit(`auth/passkeys/register:${user.id}`, 20, 10 * 60_000, { failClosed: true });
  if (!gate.allowed) return pkFail(gate.error ? 503 : 429, gate.error ? 'service temporarily unavailable' : 'too many attempts; try again later');
  try {
    if ((await countPasskeys(user.id)) >= MAX_PASSKEYS_PER_USER) return pkFail(409, `you can have at most ${MAX_PASSKEYS_PER_USER} passkeys`, 'passkey_limit');
    return NextResponse.json({ ok: true, data: { options: await beginRegistration(conf.cfg, user) } });
  } catch (err) {
    log.error('error', { err });
    return pkFail(503, 'service temporarily unavailable');
  }
}
