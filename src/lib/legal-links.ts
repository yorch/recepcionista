/**
 * Where the public legal pages live (Terms, Privacy, SMS terms). A URL set in the console (`legal.*_url`) wins; with the field empty the built-in page
 * (/terms, /privacy, /sms-terms) is used, but only when a version is published there (an unpublished page answers 404, so it is never linked).
 * `legalLinks()` is the async answer (60 s cache of the published pages) and warms the in-memory note the synchronous e-mail templates read (legal-footer.ts).
 */
import { prisma } from '@/lib/db/client';
import { legalFooterLinks, noteLegalPublished, type LegalLinks } from './legal-footer';

export { LEGAL_PATHS, absoluteLegalUrl } from './legal-footer';
export type { LegalLinks, LegalSlugName } from './legal-footer';

const TTL_MS = 60_000;
let at = 0;
let inflight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  try {
    const rows = await prisma.legalPage.findMany({ where: { publishedVersion: { not: null } }, select: { slug: true } });
    noteLegalPublished(rows.map((r) => r.slug));
  } catch {
    // a database error never breaks a page: keep what we knew
  }
  at = Date.now();
}

function warm(): Promise<void> {
  if (Date.now() - at < TTL_MS) return Promise.resolve();
  inflight ??= refresh().finally(() => { inflight = null; });
  return inflight;
}

/** Drop the cache (publishing a page, tests). */
export function resetLegalLinksCache(): void { at = 0; }

export async function legalLinks(): Promise<LegalLinks> {
  await warm();
  return legalFooterLinks();
}
