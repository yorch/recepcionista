/**
 * Legal links for the synchronous, pure e-mail templates (no I/O here): the URL settings (`legal.*_url`) plus the built-in pages that a database read elsewhere
 * (`legalLinks()` in legal-links.ts, warmed by every page footer) has noted as published. Before the first note a deployment only has its URL settings: best effort.
 */
import { setting } from '@/lib/config';

export type LegalSlugName = 'terms' | 'privacy' | 'sms_terms';
export const LEGAL_PATHS: Record<LegalSlugName, string> = { terms: '/terms', privacy: '/privacy', sms_terms: '/sms-terms' };
export const LEGAL_URL_KEYS = { terms: 'legal.terms_url', privacy: 'legal.privacy_url', sms_terms: 'legal.sms_terms_url' } as const;
export type LegalLinks = Record<LegalSlugName, string | null>;

const KEY = Symbol.for('rc.legal.published');
const box = (): { slugs: Set<string> } => ((globalThis as unknown as Record<symbol, { slugs: Set<string> }>)[KEY] ??= { slugs: new Set() });

/** Remember which built-in pages have a published version (called by the database reader). */
export const noteLegalPublished = (slugs: Iterable<string>): void => { box().slugs = new Set(slugs); };

export function pickLegalLink(slug: LegalSlugName): string | null {
  const url = setting(LEGAL_URL_KEYS[slug]);
  if (typeof url === 'string' && url.trim()) return url.trim();
  return box().slugs.has(slug) ? LEGAL_PATHS[slug] : null;
}

export const legalFooterLinks = (): LegalLinks => ({ terms: pickLegalLink('terms'), privacy: pickLegalLink('privacy'), sms_terms: pickLegalLink('sms_terms') });

/** Absolute form for e-mail and SMS: a built-in path gets the public origin. */
export function absoluteLegalUrl(link: string | null, base: string): string | null {
  if (!link) return null;
  return link.startsWith('/') ? `${base.replace(/\/+$/, '')}${link}` : link;
}
