import Link from 'next/link';
import { getLatestBriefing, listBusinesses, listCalls, listBookings } from '@/lib/db';
import { money } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const businesses = listBusinesses();
  const demo = businesses[0];
  const calls = demo ? listCalls(demo.id) : [];
  const bookings = demo ? listBookings(demo.id) : [];
  const briefing = demo ? getLatestBriefing(demo.id) : null;
  const revenue = bookings.reduce((sum, b) => sum + (b.deposit_paid ? b.deposit_amount ?? 0 : 0), 0);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#ff6b35] text-[15px] font-bold text-[#150800]">R</span>
          <span className="text-[15px] font-semibold tracking-tight">Recepcionista</span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard"
            className="rounded-xl px-3.5 py-2 text-[13px] text-[#a8b6c8] transition-colors hover:bg-[#131a24] hover:text-white"
          >
            See a live business
          </Link>
          <Link
            href="/onboarding"
            className="rounded-xl bg-[#ff6b35] px-4 py-2 text-[13px] font-medium text-[#150800] transition-colors hover:bg-[#ff8558]"
          >
            Hire yours →
          </Link>
        </div>
      </header>

      <section className="rise mt-20 max-w-3xl">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#26313f] bg-[#0d131b] px-3 py-1 text-[11px] text-[#9fb0c5]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#3ddc97] live-dot" />
          Answers in English, Spanish, y todo entre medio
        </div>

        <h1 className="mt-6 text-[44px] font-semibold leading-[1.06] tracking-[-0.03em] sm:text-[60px]">
          Paste your website.
          <br />
          <span className="bg-gradient-to-r from-[#ff6b35] via-[#ff8f5e] to-[#ffc9a8] bg-clip-text text-transparent">
            Get a bilingual employee
          </span>
          <br />
          in two minutes.
        </h1>

        <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-[#8b98ab]">
          She answers the phone, triages emergencies, books the job, texts the customer,
          takes the deposit, and calls you at the end of the day to tell you how it went.
          No dispatcher. No hold music. No lost calls.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Link
            href="/onboarding"
            className="rounded-xl bg-[#ff6b35] px-6 py-3 text-sm font-semibold text-[#150800] shadow-[0_16px_40px_-16px_rgba(255,107,53,.9)] transition hover:bg-[#ff8558]"
          >
            Set up my front desk
          </Link>
          <Link
            href="/dashboard"
            className="rounded-xl border border-[#2a3546] px-6 py-3 text-sm font-medium text-[#cbd7e6] transition hover:bg-[#131a24] hover:text-white"
          >
            Watch it work
          </Link>
        </div>
      </section>

      {demo ? (
        <section className="rise mt-20 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-[#1f2937] bg-[#0d1117]/80 p-5">
            <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Calls handled</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{calls.length}</p>
            <p className="mt-1 text-xs text-[#8b98ab]">{calls.filter((c) => c.language === 'mixed' || c.language === 'es').length} en español</p>
          </div>
          <div className="rounded-2xl border border-[#1f2937] bg-[#0d1117]/80 p-5">
            <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Jobs booked</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{bookings.length}</p>
            <p className="mt-1 text-xs text-[#8b98ab]">{money(revenue)} in deposits</p>
          </div>
          <div className="rounded-2xl border border-[#1f2937] bg-[#0d1117]/80 p-5">
            <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">Owner briefing</p>
            <p className="mt-2 text-3xl font-semibold">{briefing ? '1' : '0'}</p>
            <p className="mt-1 text-xs text-[#8b98ab]">{calls.filter((c) => c.flagged_reason).length} item needs you</p>
          </div>
        </section>
      ) : null}

      <section className="mt-20 grid gap-px overflow-hidden rounded-2xl border border-[#1f2937] bg-[#1f2937] sm:grid-cols-2 lg:grid-cols-4">
        {[
          { t: 'Spanglish native', d: 'Switches mid-sentence. Replies in the language the caller actually uses.' },
          { t: 'Books the job', d: 'Real availability, real confirmation text, real deposit link.' },
          { t: 'Triages', d: 'Asks about leaks, heat, and vulnerable people before she quotes anything.' },
          { t: 'Reports back', d: 'A 45-second voice note at 6 PM. You can answer it while driving home.' },
        ].map((f) => (
          <div key={f.t} className="bg-[#0b0f15] p-5">
            <p className="text-[13px] font-semibold text-white">{f.t}</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[#7b8b9f]">{f.d}</p>
          </div>
        ))}
      </section>

      <footer className="mt-auto pt-16 text-[11px] text-[#5a6b80]">
        Built at Buildersgiving · Miami AI Hackathon · ElevenLabs voice · Mel multi-agent
      </footer>
    </main>
  );
}
