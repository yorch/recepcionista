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
export function planPriceDisplay(): string {
  return process.env.NEXT_PUBLIC_PLAN_PRICE_DISPLAY?.trim() || 'Simple monthly pricing, with a free trial';
}
