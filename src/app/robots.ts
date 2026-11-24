import type { MetadataRoute } from 'next';
import { siteUrl } from '@/app/site-config';

/** Only the public marketing pages are crawlable. App, API, onboarding and pay routes are excluded. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: ['/', '/login', '/signup', '/refunds'], disallow: ['/dashboard', '/onboarding', '/pay/', '/api/', '/audio/'] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
