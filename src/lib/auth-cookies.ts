/** Session cookie helpers shared by the auth routes. Node runtime only. */
import type { NextResponse } from 'next/server';
import { SESSION_COOKIE, USER_SESSION_COOKIE } from '@/lib/auth';

export const cookieBase = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
});

export function setSessionCookie(res: NextResponse, name: typeof SESSION_COOKIE | typeof USER_SESSION_COOKIE, token: string, maxAgeS: number): void {
  res.cookies.set(name, token, { ...cookieBase(), maxAge: maxAgeS });
}

export function clearSessionCookie(res: NextResponse, name: typeof SESSION_COOKIE | typeof USER_SESSION_COOKIE): void {
  res.cookies.set(name, '', { ...cookieBase(), maxAge: 0 });
}

export function clearAllSessionCookies(res: NextResponse): void {
  clearSessionCookie(res, SESSION_COOKIE);
  clearSessionCookie(res, USER_SESSION_COOKIE);
}
