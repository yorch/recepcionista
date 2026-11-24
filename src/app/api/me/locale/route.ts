import { NextResponse } from 'next/server';
import { setUserLocale } from '@/lib/db/users';
import { LOCALE_COOKIE, LOCALES, isLocale } from '@/lib/i18n/core';
import { authenticate } from '@/lib/session';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = logger('me/locale');
const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

/**
 * PATCH /api/me/locale   { locale: "en" | "es" }
 * Persist the signed-in user's language (users.locale) and mirror it in the `rc_locale` cookie that anonymous pages read.
 * Cookie sessions are CSRF-checked by authenticate (same-origin required on state-changing requests). A break-glass admin
 * credential has no user row: nothing is stored, the cookie still switches that browser.
 */
export async function PATCH(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) as { locale?: unknown } | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid body');
  if (!isLocale(body.locale)) return fail(422, `locale must be one of: ${LOCALES.join(', ')}`);
  const user = auth.principal.user;
  try {
    if (user) await setUserLocale(user.id, body.locale);
  } catch (err) {
    log.error('error', { err });
    return fail(503, 'service temporarily unavailable');
  }
  const res = NextResponse.json({ ok: true, data: { locale: body.locale, persisted: Boolean(user) } });
  res.cookies.set(LOCALE_COOKIE, body.locale, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  return res;
}
