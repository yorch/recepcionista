import { NextResponse } from 'next/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { afterResponse, auditIp, sendPasskeyNotice } from '@/lib/account-flows';
import { addPasskey, PasskeyExistsError, PasskeyLimitError, recordAudit } from '@/lib/db';
import { accountOf, auditBusinessOf, configOr503, pkFail } from '@/lib/passkey-http';
import { rateLimit } from '@/lib/ratelimit';
import { authenticate } from '@/lib/session';
import { finishRegistration } from '@/lib/webauthn';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/passkeys/register/verify');

/**
 * POST { response, name? }: finish a registration started at register/options. The challenge is single use and bound to this account;
 * origin, rpID and user verification are enforced. Stores the credential, audits it and emails the account a notice.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = accountOf(auth.principal);
  if (!user) return pkFail(403, 'passkeys belong to personal accounts');
  const conf = configOr503(req);
  if ('response' in conf) return conf.response;
  const gate = await rateLimit(`auth/passkeys/register-verify:${user.id}`, 20, 10 * 60_000, { failClosed: true });
  if (!gate.allowed) return pkFail(gate.error ? 503 : 429, gate.error ? 'service temporarily unavailable' : 'too many attempts; try again later');
  const body = (await req.json().catch(() => ({}))) as { response?: unknown; name?: unknown };
  if (!body.response || typeof body.response !== 'object') return pkFail(422, 'response is required');
  const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 80) : '';
  try {
    const r = await finishRegistration(conf.cfg, user.id, body.response as RegistrationResponseJSON);
    if (!r.ok) {
      await recordAudit({ actor_kind: 'user', actor_user_id: user.id, business_id: auditBusinessOf(auth.principal), action: 'auth.passkey_register_failed', target: `user:${user.id}`, ip: auditIp(req) });
      return pkFail(400, 'the passkey could not be verified', 'passkey_invalid');
    }
    const passkey = await addPasskey({
      user_id: user.id, credential_id: r.credential_id, public_key: r.public_key, counter: r.counter, transports: r.transports,
      device_type: r.device_type, backed_up: r.backed_up, name: name || 'Passkey',
    });
    await recordAudit({
      actor_kind: 'user', actor_user_id: user.id, business_id: auditBusinessOf(auth.principal), action: 'auth.passkey_added', target: `passkey:${passkey.id}`,
      ip: auditIp(req), meta: { device_type: passkey.device_type, backed_up: passkey.backed_up },
    });
    await afterResponse('passkey.added_notice', () => sendPasskeyNotice(user.email, 'added', passkey.name, user.locale));
    const { user_id: _u, ...safe } = passkey;
    void _u;
    return NextResponse.json({ ok: true, data: { passkey: safe } }, { status: 201 });
  } catch (err) {
    if (err instanceof PasskeyExistsError) return pkFail(409, 'this passkey is already registered', 'passkey_exists');
    if (err instanceof PasskeyLimitError) return pkFail(409, 'you can have at most 20 passkeys', 'passkey_limit');
    log.error('error', { err });
    return pkFail(503, 'service temporarily unavailable');
  }
}
