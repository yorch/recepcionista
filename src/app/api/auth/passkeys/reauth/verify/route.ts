import { NextResponse } from 'next/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { auditIp } from '@/lib/account-flows';
import { markSessionSudo, recordAudit } from '@/lib/db';
import { accountOf, auditBusinessOf, configOr503, handleClonedPasskey, pkFail } from '@/lib/passkey-http';
import { rateLimit } from '@/lib/ratelimit';
import { authenticate } from '@/lib/session';
import { finishAuthentication } from '@/lib/webauthn';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/passkeys/reauth/verify');

/**
 * POST { response }: step-up with a passkey. Counts exactly like a password re-entry: on success the CALLER'S session is stamped with
 * `sudo_at = now` (valid 5 minutes for requireRecentAuth). The credential must belong to the signed-in account and carry user
 * verification. Wrong attempts share the budget of /api/auth/reauth (8 per 15 minutes per account).
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = accountOf(auth.principal);
  if (!user || !auth.sessionId) return pkFail(403, 'passkeys belong to personal accounts');
  const conf = configOr503(req);
  if ('response' in conf) return conf.response;
  const gate = await rateLimit(`auth/reauth:${user.id}`, 8, 15 * 60_000, { failClosed: true });
  if (!gate.allowed) return pkFail(gate.error ? 503 : 429, gate.error ? 'service temporarily unavailable' : 'too many attempts; try again later');
  const body = (await req.json().catch(() => ({}))) as { response?: unknown };
  if (!body.response || typeof body.response !== 'object') return pkFail(422, 'response is required');
  const ip = auditIp(req);
  try {
    const r = await finishAuthentication(conf.cfg, 'reauth', body.response as AuthenticationResponseJSON, { expectUserId: user.id });
    if (!r.ok) {
      if (r.reason === 'clone_suspected' && r.passkey) {
        await handleClonedPasskey(req, user, r.passkey);
        return pkFail(401, 'passkey check failed');
      }
      await recordAudit({ actor_kind: 'user', actor_user_id: user.id, business_id: auditBusinessOf(auth.principal), action: 'auth.reauth_failed', target: `user:${user.id}`, ip, meta: { method: 'passkey', reason: r.reason } });
      return pkFail(401, 'passkey check failed');
    }
    await markSessionSudo(auth.sessionId);
    await recordAudit({ actor_kind: 'user', actor_user_id: user.id, business_id: auditBusinessOf(auth.principal), action: 'auth.reauth', target: `user:${user.id}`, ip, meta: { method: 'passkey' } });
    return NextResponse.json({ ok: true, data: { reauthenticated: true, valid_for_s: 300 } });
  } catch (err) {
    log.error('error', { err });
    return pkFail(503, 'service temporarily unavailable');
  }
}
