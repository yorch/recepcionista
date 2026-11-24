import { NextResponse } from 'next/server';
import { checkSameOrigin } from '@/lib/auth';
import { limitIp } from '@/lib/account-flows';
import { configOr503, pkFail } from '@/lib/passkey-http';
import { beginAuthentication } from '@/lib/webauthn';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/passkeys/login/options');

/**
 * POST (public): options for a passwordless sign-in. There is no account hint and no allowCredentials list, so the answer is the same
 * for every caller (discoverable credentials: the browser lists the passkeys it holds for this site) and reveals nothing about which
 * addresses exist. The challenge is single use, purpose 'login', valid 5 minutes. Rate limited per client.
 */
export async function POST(req: Request) {
  if (!checkSameOrigin(req.headers)) return pkFail(403, 'cross-site request refused');
  const limited = await limitIp(req, 'auth/passkeys/login-options', 60, 5 * 60_000);
  if (limited) return limited;
  const conf = configOr503(req);
  if ('response' in conf) return conf.response;
  try {
    return NextResponse.json({ ok: true, data: { options: await beginAuthentication(conf.cfg, 'login') } }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    log.error('error', { err });
    return pkFail(503, 'service temporarily unavailable');
  }
}
