import { NextResponse } from 'next/server';
import { authConfig, sessionValue, tokensMatch, SESSION_COOKIE, SESSION_MAX_AGE_S } from '@/lib/auth';
import { limitRequest } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const limited = limitRequest(req, 'auth/login', 10, 5 * 60_000);
  if (limited) return limited;

  const cfg = authConfig();
  if (cfg.mode === 'misconfigured') {
    return NextResponse.json({ ok: false, error: 'server auth not configured' }, { status: 503 });
  }
  const body = (await req.json().catch(() => ({}))) as { token?: unknown };
  const candidate = typeof body.token === 'string' ? body.token : '';
  if (cfg.mode === 'enforce' && !(await tokensMatch(candidate, cfg.token))) {
    return NextResponse.json({ ok: false, error: 'invalid credentials' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, data: { authenticated: true } });
  if (cfg.mode === 'enforce') {
    res.cookies.set(SESSION_COOKIE, await sessionValue(cfg.token), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_MAX_AGE_S,
    });
  }
  return res;
}
