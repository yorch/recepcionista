/** Public-site constants (server side). Nothing here reads tenant data. */
import { makeT } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n/core';

/** Canonical public origin for metadata, sitemap and robots. */
export function siteUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL || process.env.APP_URL || 'http://localhost:3000';
  try {
    return new URL(raw).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

/** Annual plan price text (NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL[_ES]), e.g. "$1,490/year (2 months free)"; null when unset. */
export function planPriceDisplayAnnual(locale: Locale = 'en'): string | null {
  return (locale === 'es' ? process.env.NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL_ES?.trim() : '') || process.env.NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL?.trim() || null;
}

/** Plan price as shown to customers (marketing + onboarding). Free text. Spanish: NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ES when set, else the English text (operator-written), else a localized default. */
export function planPriceDisplay(locale: Locale = 'en'): string {
  return (locale === 'es' ? process.env.NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ES?.trim() : '') || process.env.NEXT_PUBLIC_PLAN_PRICE_DISPLAY?.trim() || makeT(locale)('site.priceDefault');
}
