import { NextResponse } from 'next/server';
import { checkSameOrigin } from '@/lib/auth';
import { auditIp, limitIp } from '@/lib/account-flows';
import { consumeEmailToken, getUserById, markEmailVerified, recordAudit } from '@/lib/db';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/verify-email');
const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

/**
 * Consume a verification token (POST only: opening the emailed link merely renders a page, so mail scanners
 * that prefetch links cannot burn it). Single use; marks the address verified. Does not sign anyone in.
 */
export async function POST(req: Request) {
  if (!checkSameOrigin(req.headers)) return fail(403, 'cross-site request refused');
  const limited = await limitIp(req, 'auth/verify-email', 20, 15 * 60_000);
  if (limited) return limited;
  try {
    const body = (await req.json().catch(() => ({}))) as { token?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';
    const rec = await consumeEmailToken('verify', token);
    if (!rec || !rec.user_id) return fail(400, 'this link is invalid or has expired');
    const user = await getUserById(rec.user_id);
    // The address on the token must still be the account's address (it cannot change today, but never assume).
    if (!user || user.email !== rec.email || user.disabled_at) return fail(400, 'this link is invalid or has expired');
    await markEmailVerified(user.id);
    await recordAudit({
      actor_kind: 'user', actor_user_id: user.id, business_id: user.business_id, action: 'auth.email_verified', target: `user:${user.id}`, ip: auditIp(req),
    });
    return NextResponse.json({ ok: true, data: { verified: true, next: user.role === 'owner' ? '/onboarding' : '/dashboard' } });
  } catch (err) {
    log.error('error', { err });
    return fail(503, 'service temporarily unavailable');
  }
}
