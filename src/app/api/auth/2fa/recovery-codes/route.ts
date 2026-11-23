import { NextResponse } from 'next/server';
import { recordAudit, replaceRecoveryCodes } from '@/lib/db';
import { auditIp } from '@/lib/account-flows';
import { accountId, checkPair, clearFailures, mfaPairKey, recordFailure, verdictResponse } from '@/lib/login-throttle';
import { verifySecondFactor } from '@/lib/mfa';
import { authenticate } from '@/lib/session';
import { generateRecoveryCodes, hashRecoveryCode } from '@/lib/totp';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/2fa/recovery-codes');

/** `{ code }` (a current authenticator code; a recovery code is not accepted here): replace all recovery codes. Shown once. */
export async function POST(req: Request) {
  const auth = await authenticate(req, { allowEnrollment: true });
  if (!auth.ok) return auth.response;
  const user = 'user' in auth.principal ? auth.principal.user : undefined;
  if (!user) return NextResponse.json({ ok: false, error: 'two-factor needs a personal account' }, { status: 400 });
  try {
    const key = mfaPairKey(user.id, req);
    const gate = await checkPair(key);
    if (!gate.ok) return verdictResponse(gate);
    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    const result = await verifySecondFactor(user.id, { code: body.code }, { allowRecovery: false, account: { email: user.email, businessId: user.business_id, ip: auditIp(req) } });
    if (!result.ok && result.locked) return verdictResponse(result.locked);
    if (!result.ok) {
      await recordFailure(key, accountId(user.id));
      return NextResponse.json({ ok: false, error: 'invalid code' }, { status: 400 });
    }
    await clearFailures(key);
    const codes = generateRecoveryCodes();
    await replaceRecoveryCodes(user.id, codes.map(hashRecoveryCode));
    await recordAudit({ actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.recovery_codes_regenerated', target: `user:${user.id}`, ip: auditIp(req) });
    return NextResponse.json({ ok: true, data: { recovery_codes: codes } }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    log.error('error', { err });
    return NextResponse.json({ ok: false, error: 'service temporarily unavailable' }, { status: 503 });
  }
}
