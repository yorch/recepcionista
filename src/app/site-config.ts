/** Public-site constants (server side). Nothing here reads tenant data. */
import { setting } from '@/lib/config';
import { makeT } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n/core';
import { baseUrlOrigin, DEFAULT_DEV_BASE_URL } from '@/lib/base-url';

/** Canonical public origin for metadata, sitemap and robots. */
export function siteUrl(): string {
  return baseUrlOrigin() ?? DEFAULT_DEV_BASE_URL;
}

const text = (v: string | null | undefined): string => (v ?? '').trim();

/**
 * Annual plan price text (registry billing.price_display_annual_es / _en; env NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL[_ES] pins them), e.g. "$1,490/year (2 months free)"; null when unset.
 * Read at REQUEST time from the config snapshot (Phase 6): never inlined at build time, so the console changes it without a rebuild.
 */
export function planPriceDisplayAnnual(locale: Locale = 'en'): string | null {
  return (locale === 'es' ? text(setting('billing.price_display_annual_es')) : '') || text(setting('billing.price_display_annual_en')) || null;
}

/** Plan price as shown to customers (marketing + onboarding). Free text. Spanish: billing.price_display_es when set, else the English text (operator-written), else a localized default. Request time (config snapshot). */
export function planPriceDisplay(locale: Locale = 'en'): string {
  return (locale === 'es' ? text(setting('billing.price_display_es')) : '') || text(setting('billing.price_display_en')) || makeT(locale)('site.priceDefault');
}
