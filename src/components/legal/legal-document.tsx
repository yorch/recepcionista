import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MarkdownView } from '@/components/legal/markdown-view';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
import { Logo } from '@/components/ui/logo';
import { getPublishedLegal } from '@/lib/admin/legal';
import { intlTag, type MessageKey } from '@/lib/i18n/core';
import { getLocale, getT } from '@/lib/i18n/server';
import { LegalFooterLinks } from './footer-links';
import type { LegalSlugName } from '@/lib/legal-links';

const SLUG_PATH: Record<LegalSlugName, string> = { terms: '/terms', privacy: '/privacy', sms_terms: '/sms-terms' };

async function published(slug: LegalSlugName) {
  const locale = await getLocale();
  const doc = await getPublishedLegal(slug, locale).catch(() => null);
  return { locale, doc };
}

export async function legalMetadata(slug: LegalSlugName): Promise<Metadata> {
  const t = await getT();
  const { doc } = await published(slug);
  // An unpublished page answers 404; its metadata is then irrelevant.
  if (!doc) return { robots: { index: false, follow: false } };
  return { title: t(`ac.legal.public.title.${slug}` as MessageKey), alternates: { canonical: SLUG_PATH[slug] }, robots: { index: true, follow: true } };
}

/**
 * A public legal page (/terms, /privacy, /sms-terms): the PUBLISHED version of the page in the visitor's language (English when that language has none), with its
 * version and last-updated date. 404 when nothing is published. The body is operator-written markdown rendered by the safe renderer (no raw HTML, no javascript: links).
 */
export async function LegalDocument({ slug }: { slug: LegalSlugName }) {
  const t = await getT();
  const { locale, doc } = await published(slug);
  if (!doc) notFound();
  const when = new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(doc.published_at));
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex items-center justify-between gap-3"><Logo /><LocaleSwitcher compact /></header>
      <main id="main-content" className="mt-10 text-[15px] leading-relaxed text-body">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-white">{t(`ac.legal.public.title.${slug}` as MessageKey)}</h1>
        <p className="mt-2 text-xs text-dim">{t('ac.legal.public.meta', { version: doc.version, date: when })}</p>
        {doc.locale !== locale ? <p role="note" lang="en" className="mt-3 rounded-xl border border-line bg-panel px-4 py-2.5 text-[13px] text-mute">{t('ac.legal.public.fallback')}</p> : null}
        <MarkdownView source={doc.body} className="mt-4" />
      </main>
      <footer className="mt-auto flex flex-wrap items-center gap-x-5 pt-12 text-xs text-dim">
        <Link href="/" className="inline-flex min-h-11 items-center hover:text-soft">{t('ref.home')}</Link>
        <LegalFooterLinks />
      </footer>
    </div>
  );
}
