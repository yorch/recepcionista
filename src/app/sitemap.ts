import type { MetadataRoute } from 'next';
import { siteUrl } from '@/app/site-config';

export const dynamic = 'force-static';

/** Public marketing routes only; never app routes. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return [
    { url: `${base}/`, changeFrequency: 'monthly', priority: 1 },
    { url: `${base}/signup`, changeFrequency: 'yearly', priority: 0.8 },
    { url: `${base}/login`, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
