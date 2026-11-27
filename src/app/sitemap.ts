import type { MetadataRoute } from 'next';
import { siteUrl } from '@/app/site-config';
import { LEGAL_PATHS, legalLinks, type LegalSlugName } from '@/lib/legal-links';

/** Rendered per request: the legal pages are listed only when a version is published (and no external URL replaces the built-in page). */
export const dynamic = 'force-dynamic';

/** Public marketing routes only; never app routes. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const links = await legalLinks().catch(() => null);
  const legal = (Object.keys(LEGAL_PATHS) as LegalSlugName[])
    .filter((slug) => links?.[slug] === LEGAL_PATHS[slug])
    .map((slug) => ({ url: `${base}${LEGAL_PATHS[slug]}`, changeFrequency: 'yearly' as const, priority: 0.3 }));
  return [
    { url: `${base}/`, changeFrequency: 'monthly', priority: 1 },
    { url: `${base}/signup`, changeFrequency: 'yearly', priority: 0.8 },
    { url: `${base}/refunds`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${base}/login`, changeFrequency: 'yearly', priority: 0.3 },
    ...legal,
  ];
}
