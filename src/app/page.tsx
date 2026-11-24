import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { buttonClass } from '@/components/ui/button';
import { planPriceDisplay } from '@/app/site-config';

/** Public marketing page: static copy only. It never reads or renders any tenant's data. */
export const dynamic = 'force-dynamic'; // plan price comes from runtime env

export const metadata: Metadata = {
  title: { absolute: 'Recepcionista — Your bilingual AI front desk' },
  description:
    'An AI receptionist that answers your business phone in English and Spanish, books jobs, collects deposits and briefs you every evening. Set up in minutes from your website.',
  alternates: { canonical: '/' },
};

const STEPS = [
  { n: '1', t: 'Paste your website', d: 'She reads your services, prices, hours and service area. You review and fix anything.' },
  { n: '2', t: 'Get her phone number', d: 'Forward your business line to it. Your phone still rings first; she catches what you miss.' },
  { n: '3', t: 'Run your day', d: 'Jobs land on your calendar, deposits get collected, and you get a short voice briefing each evening.' },
];

const FEATURES = [
  { t: 'Spanglish native', d: 'Switches mid-sentence and replies in the language the caller actually uses.' },
  { t: 'Books the job', d: 'Checks your hours and calendar, then texts the customer a confirmation.' },
  { t: 'Triages emergencies', d: 'Asks about leaks, heat and vulnerable people first, and alerts you by text.' },
  { t: 'Collects deposits', d: 'Sends a secure payment link by text. She never takes card numbers over the phone.' },
  { t: 'Reports back', d: 'A short evening briefing on calls, bookings, money and anything that needs you.' },
  { t: 'You stay in control', d: 'Pause her or forward calls to your own phone with one switch. Edit every price and answer she knows, see your week on a calendar and read every call.' },
];

export default function Home() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex items-center justify-between gap-3">
        <Logo />
        <nav aria-label="Account" className="flex items-center gap-2">
          <Link href="/login" className={buttonClass('ghost', 'px-3.5 text-[13px]')}>Sign in</Link>
          <Link href="/signup" className={buttonClass('primary', 'px-4 text-[13px]')}>Start free trial</Link>
        </nav>
      </header>

      <main id="main-content">
        <section className="rise mt-14 max-w-3xl sm:mt-20" aria-labelledby="hero-title">
          <p className="inline-flex items-center gap-2 rounded-full border border-line-2 bg-[#0d131b] px-3 py-1 text-xs text-body">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-mint live-dot" />
            Answers in English, Spanish, y todo entre medio
          </p>
          <h1 id="hero-title" className="mt-6 text-[40px] font-semibold leading-[1.06] tracking-[-0.03em] text-white sm:text-[60px]">
            Paste your website.
            <br />
            <span className="bg-gradient-to-r from-brand via-brand-soft to-[#ffc9a8] bg-clip-text text-transparent">
              Get a bilingual employee
            </span>
            <br />
            in minutes.
          </h1>
          <p className="mt-6 max-w-xl text-[16px] leading-relaxed text-mute">
            She answers the phone, triages emergencies, books the job, texts the customer, takes the deposit,
            and tells you how the day went. No dispatcher. No hold music. No lost calls.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link href="/signup" className={buttonClass('primary', 'px-6 py-3 text-sm font-semibold shadow-[0_16px_40px_-16px_rgba(255,107,53,.9)]')}>
              Set up my front desk
            </Link>
            <Link href="/login" className={buttonClass('outline', 'px-6 py-3')}>Sign in</Link>
          </div>
          <p className="mt-3 text-xs text-dim">{planPriceDisplay()}</p>
        </section>

        <section className="mt-20" aria-labelledby="how-title">
          <h2 id="how-title" className="text-[24px] font-semibold tracking-[-0.02em] text-white">How it works</h2>
          <ol className="mt-5 grid gap-4 md:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-2xl border border-line bg-panel/80 p-5">
                <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-full bg-brand text-sm font-bold text-on-brand">{s.n}</span>
                <h3 className="mt-3 text-[15px] font-semibold text-white">{s.t}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-mute">{s.d}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-16" aria-labelledby="features-title">
          <h2 id="features-title" className="sr-only">What she does</h2>
          <ul className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <li key={f.t} className="bg-[#0b0f15] p-5">
                <h3 className="text-[14px] font-semibold text-white">{f.t}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-mute">{f.d}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-16" aria-labelledby="pricing-title">
          <div className="rounded-2xl border border-line-3 bg-panel p-6 text-center sm:p-10">
            <h2 id="pricing-title" className="text-[24px] font-semibold tracking-[-0.02em] text-white">Pricing</h2>
            <p className="mx-auto mt-3 max-w-xl text-[18px] text-soft">{planPriceDisplay()}</p>
            <p className="mx-auto mt-2 max-w-xl text-[13px] text-dim">
              One plan with your own phone number, calls, texts and briefings. Cancel any time.
            </p>
            <Link href="/signup" className={buttonClass('primary', 'mt-6 px-8 py-3 font-semibold')}>Start free trial</Link>
          </div>
        </section>
      </main>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-16 text-xs text-dim">
        <span>© {new Date().getFullYear()} Recepcionista</span>
        <nav aria-label="Footer" className="flex gap-4">
          <Link href="/login" className="inline-flex min-h-11 items-center hover:text-soft">Sign in</Link>
          <Link href="/signup" className="inline-flex min-h-11 items-center hover:text-soft">Sign up</Link>
        </nav>
      </footer>
    </div>
  );
}
