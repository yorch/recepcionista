/**
 * Server-side locale for the current request (server components, route handlers via request headers).
 * user.locale -> rc_locale cookie -> business.locale_default -> Accept-Language -> en.
 */
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { BUSINESS_COOKIE } from '@/lib/auth';
import { getBusiness } from '@/lib/db';
import { getServerPrincipal } from '@/lib/session';
import { LOCALE_COOKIE, makeT, normalizeLocale, resolveLocale, MESSAGES, type Locale, type Messages, type TFunction } from './index';

export const getLocale = cache(async (): Promise<Locale> => {
  let cookie: string | undefined;
  let acceptLanguage: string | null = null;
  try {
    cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
    acceptLanguage = (await headers()).get('accept-language');
  } catch {
    /* outside a request (build-time rendering): fall through to the default */
  }
  let user: string | undefined;
  let business: string | undefined;
  try {
    const principal = await getServerPrincipal();
    if (principal) {
      user = principal.user?.locale;
      if (principal.kind === 'user') {
        business = (await getBusiness(principal.business_id))?.locale_default;
      } else {
        const selected = (await cookies()).get(BUSINESS_COOKIE)?.value;
        if (selected) business = (await getBusiness(selected))?.locale_default;
      }
    }
  } catch {
    /* no database / no session: anonymous resolution */
  }
  return resolveLocale({ user, cookie, business, acceptLanguage });
});

export async function getT(): Promise<TFunction> {
  return makeT(await getLocale());
}

export async function getMessages(): Promise<{ locale: Locale; messages: Messages }> {
  const locale = await getLocale();
  return { locale, messages: MESSAGES[locale] };
}

/**
 * Language of a page for a CUSTOMER (the /pay page): their explicit choice (rc_locale cookie) first, then the language of the call that
 * booked the job, then the business's default, then the browser's Accept-Language. Anonymous: it never reads a session.
 */
export async function getCustomerLocale(opts: { callLanguage?: string | null; business?: string | null }): Promise<Locale> {
  let cookie: string | undefined;
  let acceptLanguage: string | null = null;
  try {
    cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
    acceptLanguage = (await headers()).get('accept-language');
  } catch { /* outside a request */ }
  const call = normalizeLocale(opts.callLanguage);
  return resolveLocale({ cookie, business: call ?? opts.business, acceptLanguage });
}
