import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
import { LegalFooterLinks } from '@/components/legal/footer-links';
import { getT } from '@/lib/i18n/server';

/**
 * Public explanation of how deposits and refunds work on this platform (English and Spanish). It describes what the software does; it is
 * NOT legal advice and states nothing about any one business's terms (each business sets its own refund policy, shown on its payment page).
 * The operator must review this text (and have counsel review it where required) before launch: see docs/refunds.md.
 */
export const dynamic = 'force-dynamic'; // the language comes from the request (cookie / Accept-Language)

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('ref.metaTitle'), description: t('ref.metaDescription'), alternates: { canonical: '/refunds' } };
}

export default async function RefundsPage() {
  const t = await getT();
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex items-center justify-between gap-3"><Logo /><LocaleSwitcher compact /></header>
      <main id="main-content" className="mt-10 text-[15px] leading-relaxed text-body">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-white">{t('ref.h1')}</h1>
        <p className="mt-3 text-mute">{t('ref.lead')}</p>

        <h2 className="mt-8 text-[18px] font-semibold text-white">{t('ref.who.h')}</h2>
        <p className="mt-2">{t('ref.who.p')}</p>

        <h2 className="mt-8 text-[18px] font-semibold text-white">{t('ref.policy.h')}</h2>
        <p className="mt-2">{t('ref.policy.p')}</p>

        <h2 className="mt-8 text-[18px] font-semibold text-white">{t('ref.how.h')}</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>{t('ref.how.1')}</li>
          <li>{t('ref.how.2')}</li>
          <li>{t('ref.how.3')}</li>
          <li>{t('ref.how.4')}</li>
        </ul>

        <h2 className="mt-8 text-[18px] font-semibold text-white">{t('ref.questions.h')}</h2>
        <p className="mt-2">{t('ref.questions.p')}</p>

        <h2 className="mt-8 text-[18px] font-semibold text-white">{t('ref.sub.h')}</h2>
        <p className="mt-2">{t('ref.sub.p')}</p>

        <p className="mt-10 text-xs text-dim">{t('ref.disclaimer')}</p>
      </main>
      <footer className="mt-auto flex flex-wrap items-center gap-x-5 pt-12 text-xs text-dim"><Link href="/" className="inline-flex min-h-11 items-center hover:text-soft">{t('ref.home')}</Link><LegalFooterLinks /></footer>
    </div>
  );
}
