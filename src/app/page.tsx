import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { buttonClass } from '@/components/ui/button';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
import { planPriceDisplay } from '@/app/site-config';
import { getLocale, getT } from '@/lib/i18n/server';

/** Public marketing page: static copy only. It never reads or renders any tenant's data. */
export const dynamic = 'force-dynamic'; // plan price and language come from the request

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: { absolute: t('land.title') }, description: t('land.description'), alternates: { canonical: '/' } };
}

const STEPS = [
  { n: '1', t: 'land.step1.t', d: 'land.step1.d' },
  { n: '2', t: 'land.step2.t', d: 'land.step2.d' },
  { n: '3', t: 'land.step3.t', d: 'land.step3.d' },
] as const;

const FEATURES = [
  { t: 'land.f1.t', d: 'land.f1.d' },
  { t: 'land.f2.t', d: 'land.f2.d' },
  { t: 'land.f3.t', d: 'land.f3.d' },
  { t: 'land.f4.t', d: 'land.f4.d' },
  { t: 'land.f5.t', d: 'land.f5.d' },
  { t: 'land.f6.t', d: 'land.f6.d' },
] as const;

export default async function Home() {
  const t = await getT();
  const locale = await getLocale();
  const price = planPriceDisplay(locale);
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex items-center justify-between gap-3">
        <Logo />
        <nav aria-label={t('land.nav.account')} className="flex items-center gap-2">
          <LocaleSwitcher compact className="mr-1" />
          <Link href="/login" className={buttonClass('ghost', 'px-3.5 text-[13px]')}>{t('land.signIn')}</Link>
          <Link href="/signup" className={buttonClass('primary', 'px-4 text-[13px]')}>{t('land.startTrial')}</Link>
        </nav>
      </header>

      <main id="main-content">
        <section className="rise mt-14 max-w-3xl sm:mt-20" aria-labelledby="hero-title">
          <p className="inline-flex items-center gap-2 rounded-full border border-line-2 bg-[#0d131b] px-3 py-1 text-xs text-body">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-mint live-dot" />
            {t('land.pill')}
          </p>
          <h1 id="hero-title" className="mt-6 text-[40px] font-semibold leading-[1.06] tracking-[-0.03em] text-white sm:text-[60px]">
            {t('land.h1.a')}
            <br />
            <span className="bg-gradient-to-r from-brand via-brand-soft to-[#ffc9a8] bg-clip-text text-transparent">
              {t('land.h1.b')}
            </span>
            <br />
            {t('land.h1.c')}
          </h1>
          <p className="mt-6 max-w-xl text-[16px] leading-relaxed text-mute">{t('land.lead')}</p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link href="/signup" className={buttonClass('primary', 'px-6 py-3 text-sm font-semibold shadow-[0_16px_40px_-16px_rgba(255,107,53,.9)]')}>
              {t('land.cta')}
            </Link>
            <Link href="/login" className={buttonClass('outline', 'px-6 py-3')}>{t('land.signIn')}</Link>
          </div>
          <p className="mt-3 text-xs text-dim">{price}</p>
        </section>

        <section className="mt-20" aria-labelledby="how-title">
          <h2 id="how-title" className="text-[24px] font-semibold tracking-[-0.02em] text-white">{t('land.how')}</h2>
          <ol className="mt-5 grid gap-4 md:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-2xl border border-line bg-panel/80 p-5">
                <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-full bg-brand text-sm font-bold text-on-brand">{s.n}</span>
                <h3 className="mt-3 text-[15px] font-semibold text-white">{t(s.t)}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-mute">{t(s.d)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-16" aria-labelledby="features-title">
          <h2 id="features-title" className="sr-only">{t('land.features')}</h2>
          <ul className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <li key={f.t} className="bg-[#0b0f15] p-5">
                <h3 className="text-[14px] font-semibold text-white">{t(f.t)}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-mute">{t(f.d)}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-16" aria-labelledby="pricing-title">
          <div className="rounded-2xl border border-line-3 bg-panel p-6 text-center sm:p-10">
            <h2 id="pricing-title" className="text-[24px] font-semibold tracking-[-0.02em] text-white">{t('land.pricing')}</h2>
            <p className="mx-auto mt-3 max-w-xl text-[18px] text-soft">{price}</p>
            <p className="mx-auto mt-2 max-w-xl text-[13px] text-dim">{t('land.pricingNote')}</p>
            <Link href="/signup" className={buttonClass('primary', 'mt-6 px-8 py-3 font-semibold')}>{t('land.startTrial')}</Link>
          </div>
        </section>
      </main>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-16 text-xs text-dim">
        <span>{t('land.copyright', { year: new Date().getFullYear() })}</span>
        <nav aria-label={t('land.footerNav')} className="flex flex-wrap items-center gap-4">
          <Link href="/login" className="inline-flex min-h-11 items-center hover:text-soft">{t('land.signIn')}</Link>
          <Link href="/signup" className="inline-flex min-h-11 items-center hover:text-soft">{t('land.signUp')}</Link>
          <Link href="/refunds" className="inline-flex min-h-11 items-center hover:text-soft">{t('land.refunds')}</Link>
          <LocaleSwitcher compact />
        </nav>
      </footer>
    </div>
  );
}
