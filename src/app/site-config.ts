/** Public-site constants (server side). Nothing here reads tenant data. */

/** Canonical public origin for metadata, sitemap and robots. */
export function siteUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL || process.env.APP_URL || 'http://localhost:3000';
  try {
    return new URL(raw).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

/** Plan price as shown to customers (marketing + onboarding). Free text, e.g. "$149/month after a 7-day free trial". */
/** Annual plan price text (NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL), e.g. "$1,490/year (2 months free)"; null when unset. */
export function planPriceDisplayAnnual(): string | null {
  return process.env.NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL?.trim() || null;
}

export function planPriceDisplay(): string {
  return process.env.NEXT_PUBLIC_PLAN_PRICE_DISPLAY?.trim() || 'Simple monthly pricing, with a free trial';
}
