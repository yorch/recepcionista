import { NextResponse } from 'next/server';
import { checkSameOrigin, SESSION_COOKIE, USER_SESSION_COOKIE, userSessionTokenFrom } from '@/lib/auth';
import { deleteSession } from '@/lib/db/users';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('auth/logout');

/** Deletes the server-side session (so a copied cookie is dead too) and clears both cookies. */
export async function POST(req: Request) {
  if (!checkSameOrigin(req.headers)) {
    return NextResponse.json({ ok: false, error: 'cross-site request refused' }, { status: 403 });
  }
  const token = userSessionTokenFrom(req.headers);
  if (token) {
    try {
      await deleteSession(token);
    } catch (err) {
      log.error('delete_failed', { err });
    }
  }
  const res = NextResponse.json({ ok: true, data: { authenticated: false } });
  for (const name of [SESSION_COOKIE, USER_SESSION_COOKIE]) {
    res.cookies.set(name, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });
  }
  return res;
}
