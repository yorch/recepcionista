'use client';
import Link from 'next/link';
import { useT } from '@/lib/i18n/client';

function A({ href, children }: { href: string; children: React.ReactNode }) {
  const cls = 'underline underline-offset-2 hover:text-white';
  return href.startsWith('/') ? <Link href={href} className={cls}>{children}</Link> : <a href={href} rel="noopener noreferrer" className={cls}>{children}</a>;
}

/** "By creating an account you agree to the Terms and the Privacy Policy": only the documents that exist are linked; nothing is rendered when neither does. */
export function LegalConsentLine({ terms, privacy, className }: { terms: string | null; privacy: string | null; className?: string }) {
  const t = useT();
  if (!terms && !privacy) return null;
  const template = terms && privacy ? t('ac.legal.consent.both') : terms ? t('ac.legal.consent.terms') : t('ac.legal.consent.privacy');
  const parts = template.split(/(\{terms\}|\{privacy\})/);
  return (
    <p className={className ?? 'mt-3 text-center text-[12px] text-[#8394a9]'}>
      {parts.map((p, i) => p === '{terms}' && terms ? <A key={i} href={terms}>{t('ac.legal.footer.terms')}</A> : p === '{privacy}' && privacy ? <A key={i} href={privacy}>{t('ac.legal.footer.privacy')}</A> : <span key={i}>{p}</span>)}
    </p>
  );
}
