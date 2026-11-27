import Link from 'next/link';
import { legalLinks } from '@/lib/legal-links';
import { getT } from '@/lib/i18n/server';

/** The links to the legal pages that exist: a URL set in the console, else the built-in page when a version is published there. Renders nothing when there are none. */
export async function LegalFooterLinks({ className }: { className?: string }) {
  const [t, links] = await Promise.all([getT(), legalLinks().catch(() => ({ terms: null, privacy: null, sms_terms: null }))]);
  const items = [
    { href: links.terms, label: t('ac.legal.footer.terms') },
    { href: links.privacy, label: t('ac.legal.footer.privacy') },
    { href: links.sms_terms, label: t('ac.legal.footer.sms_terms') },
  ].filter((i): i is { href: string; label: string } => Boolean(i.href));
  if (items.length === 0) return null;
  return (
    <>
      {items.map((i) => (
        i.href.startsWith('/')
          ? <Link key={i.href} href={i.href} className={className ?? 'inline-flex min-h-11 items-center hover:text-soft'}>{i.label}</Link>
          : <a key={i.href} href={i.href} rel="noopener noreferrer" className={className ?? 'inline-flex min-h-11 items-center hover:text-soft'}>{i.label}</a>
      ))}
    </>
  );
}
