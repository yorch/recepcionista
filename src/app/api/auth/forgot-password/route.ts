import { NextResponse } from 'next/server';
import { checkSameOrigin } from '@/lib/auth';
import { afterResponse, allowPerEmail, auditIp, limitIp, sendPasswordResetEmail } from '@/lib/account-flows';
import { getUserByEmail, normalizeEmail, recordAudit } from '@/lib/db';
import { validatePublicEmail } from '@/lib/user-policy';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/forgot-password');
const generic = () => NextResponse.json({ ok: true, data: { sent: true } });
const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

/**
 * Request a password-reset link. ALWAYS the same 200 for known, unknown, disabled and badly-throttled
 * addresses (the mail goes out after the response, so timing does not tell either). Per-IP and per-address limits.
 */
export async function POST(req: Request) {
  if (!checkSameOrigin(req.headers)) return fail(403, 'cross-site request refused');
  const limited = await limitIp(req, 'auth/forgot-password', 10);
  if (limited) return limited;

  const body = (await req.json().catch(() => ({}))) as { email?: unknown };
  if (validatePublicEmail(body.email)) return generic();
  const email = normalizeEmail(body.email as string);
  if (!(await allowPerEmail('auth/forgot-password', email, 3))) return generic();
  try {
    const user = await getUserByEmail(email);
    if (user && !user.disabled_at) {
      await afterResponse('forgot.reset_mail', async () => {
        await recordAudit({
          actor_kind: 'system', actor_user_id: user.id, business_id: user.business_id, action: 'auth.password_reset_requested',
          target: `user:${user.id}`, ip: auditIp(req),
        });
        await sendPasswordResetEmail(user);
      });
    }
  } catch (err) {
    log.error('error', { err });
  }
  return generic();
}
