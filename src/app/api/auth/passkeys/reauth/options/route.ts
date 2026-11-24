import { NextResponse } from 'next/server';
import { countPasskeys } from '@/lib/db';
import { accountOf, configOr503, pkFail } from '@/lib/passkey-http';
import { rateLimit } from '@/lib/ratelimit';
import { authenticate } from '@/lib/session';
import { beginAuthentication } from '@/lib/webauthn';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/passkeys/reauth/options');

/** POST: options for a step-up with one of the signed-in account's own passkeys (allowCredentials = its credentials, user verification required). */
export async function POST(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = accountOf(auth.principal);
  if (!user || !auth.sessionId) return pkFail(403, 'passkeys belong to personal accounts');
  const conf = configOr503(req);
  if ('response' in conf) return conf.response;
  const gate = await rateLimit(`auth/passkeys/reauth-options:${user.id}`, 30, 15 * 60_000, { failClosed: true });
  if (!gate.allowed) return pkFail(gate.error ? 503 : 429, gate.error ? 'service temporarily unavailable' : 'too many attempts; try again later');
  try {
    if ((await countPasskeys(user.id)) === 0) return pkFail(409, 'this account has no passkeys', 'no_passkey');
    return NextResponse.json({ ok: true, data: { options: await beginAuthentication(conf.cfg, 'reauth', user.id) } }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    log.error('error', { err });
    return pkFail(503, 'service temporarily unavailable');
  }
}
