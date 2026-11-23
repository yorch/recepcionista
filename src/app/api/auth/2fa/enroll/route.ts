import { NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { beginTotpEnrollment, getTotpState, recordAudit } from '@/lib/db';
import { auditIp } from '@/lib/account-flows';
import { reauthWithPassword } from '@/lib/mfa';
import { authenticate } from '@/lib/session';
import { encryptSecret, generateTotpSecret, otpauthUri, SecretKeyError } from '@/lib/totp';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/2fa/enroll');

/**
 * Start 2FA enrolment: `{ password }` -> a fresh secret (stored encrypted, inactive until /confirm), its
 * otpauth URI and the QR code as server-rendered SVG. Calling it again before confirming replaces the pending secret.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = 'user' in auth.principal ? auth.principal.user : undefined;
  if (!user) return NextResponse.json({ ok: false, error: 'two-factor needs a personal account (the break-glass token has none)' }, { status: 400 });
  try {
    const body = (await req.json().catch(() => ({}))) as { password?: unknown };
    const denied = await reauthWithPassword(req, user.email, body.password);
    if (denied) return denied;
    if ((await getTotpState(user.id))?.enabled_at) return NextResponse.json({ ok: false, error: 'two-factor is already on' }, { status: 409 });

    const secret = generateTotpSecret();
    if (!(await beginTotpEnrollment(user.id, encryptSecret(secret, user.id)))) {
      return NextResponse.json({ ok: false, error: 'two-factor is already on' }, { status: 409 });
    }
    const uri = otpauthUri({ secret, account: user.email, issuer: 'Recepcionista' });
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    await recordAudit({ actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.2fa_enroll_started', target: `user:${user.id}`, ip: auditIp(req) });
    return NextResponse.json({ ok: true, data: { secret, otpauth_uri: uri, qr_svg: svg } }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof SecretKeyError) {
      log.error('secret_key', { error: err.message });
      return NextResponse.json({ ok: false, error: 'two-factor is not configured on this server (APP_SECRET_KEY)' }, { status: 503 });
    }
    log.error('error', { err });
    return NextResponse.json({ ok: false, error: 'service temporarily unavailable' }, { status: 503 });
  }
}
