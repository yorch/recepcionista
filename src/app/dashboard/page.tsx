import Link from 'next/link';
import {
  getLatestBriefing, listBookings, listBusinesses, listCalls, listSms,
} from '@/lib/db';
import { money, relative, seconds, timeET, whenET } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Card, CardHead } from '@/components/ui/card';
import { VoicePlayer } from '@/components/ui/audio';

export const dynamic = 'force-dynamic';

export default async function TodayPage() {
  const biz = (await listBusinesses())[0];
  if (!biz) return null;

  const calls = await listCalls(biz.id);
  const bookings = await listBookings(biz.id);
  const briefing = await getLatestBriefing(biz.id);
  const sms = await listSms(biz.id);

  // Read the clock once so the render stays pure and every value below agrees.
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const callsToday = calls.filter((c) => c.started_at.slice(0, 10) === today);
  const upcoming = bookings
    .filter((b) => new Date(b.scheduled_at).getTime() > now.getTime() - 3600_000 && b.status !== 'cancelled')
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  const deposits = bookings.reduce((s, b) => s + (b.deposit_paid ? b.deposit_amount ?? 0 : 0), 0);
  const needsYou = calls.filter((c) => c.flagged_reason);

  const hour = now.getHours();
  const greeting = hour < 12 ? 'Buenos días' : hour < 18 ? 'Buenas tardes' : 'Buenas noches';

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">
            {new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' }).format(new Date())}
          </p>
          <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.02em]">
            {greeting}, {biz.owner_name ?? 'Jorge'}.
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[#1c4635] bg-[#10291f] px-2.5 py-1 text-[11px] text-[#6ee7b0]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#3ddc97] live-dot" />
            {biz.phone ?? 'no number'}
          </span>
        </div>
      </header>

      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Calls today" value={String(callsToday.length)} sub={`${calls.filter((c) => c.language === 'es' || c.language === 'mixed').length} bilingual`} />
        <Stat label="Booked" value={String(upcoming.length)} sub="upcoming jobs" />
        <Stat label="Deposits" value={money(deposits)} sub="collected" />
        <Stat label="Needs you" value={String(needsYou.length)} sub="flagged" tone={needsYou.length ? 'warn' : undefined} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card>
            <CardHead
              title="Your briefing"
              subtitle={briefing ? `${briefing.date} · ${briefing.stats.calls} calls, ${briefing.stats.bookings} booked` : 'Not generated yet'}
              right={<Link href="/dashboard/briefings" className="text-[11px] text-[#ff8f5e] hover:underline">All briefings</Link>}
            />
            <div className="p-4">
              <VoicePlayer src={briefing?.audio_url} label={briefing ? `Evening note · ${briefing.date}` : 'No briefing yet'} />
              {briefing ? (
                <p className="mt-4 max-h-40 overflow-y-auto rounded-xl bg-[#080b10] p-3.5 text-[12.5px] leading-relaxed text-[#9fb0c5]">
                  {briefing.transcript}
                </p>
              ) : (
                <p className="mt-3 text-[12px] text-[#6b7b91]">Generate one from the briefings page.</p>
              )}
            </div>
          </Card>

          <Card className="mt-4">
            <CardHead title="Next up" subtitle="Booked by her, no one called you" right={<Link href="/dashboard/bookings" className="text-[11px] text-[#ff8f5e] hover:underline">Calendar</Link>} />
            <ul className="divide-y divide-[#171f2a]">
              {upcoming.slice(0, 4).map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="w-[86px] shrink-0">
                    <p className="text-[11px] font-medium text-[#ff8f5e]">{whenET(b.scheduled_at).split(' at ')[0]}</p>
                    <p className="font-mono text-[13px] text-white">{timeET(b.scheduled_at)}</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-white">{b.customer_name}</p>
                    <p className="truncate text-[11px] text-[#6b7b91]">{b.service}</p>
                  </div>
                  <span className="tabular-nums text-[12px] text-[#9fb0c5]">{money(b.price_estimate)}</span>
                </li>
              ))}
              {upcoming.length === 0 ? (
                <li className="px-5 py-8 text-center text-[12px] text-[#5a6b80]">Nothing on the books yet.</li>
              ) : null}
            </ul>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card>
            <CardHead title="Needs your call" subtitle="She flagged these" />
            <ul className="divide-y divide-[#171f2a]">
              {needsYou.slice(0, 3).map((c) => (
                <li key={c.id} className="px-5 py-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[13px] text-white">{c.caller_name ?? c.caller_phone}</p>
                    <Badge tone={c.urgency}>{c.urgency}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-[#7b8b9f]">{c.flagged_reason}</p>
                  <p className="mt-1.5 font-mono text-[10.5px] text-[#5a6b80]">{c.caller_phone}</p>
                </li>
              ))}
              {needsYou.length === 0 ? (
                <li className="px-5 py-8 text-center text-[12px] text-[#5a6b80]">All clear.</li>
              ) : null}
            </ul>
          </Card>

          <Card className="mt-4">
            <CardHead title="Recent calls" right={<Link href="/dashboard/calls" className="text-[11px] text-[#ff8f5e] hover:underline">All</Link>} />
            <ul className="divide-y divide-[#171f2a]">
              {calls.slice(0, 4).map((c) => (
                <li key={c.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[12.5px] text-white">{c.caller_name ?? c.caller_phone}</p>
                    <span className="shrink-0 text-[10.5px] text-[#5a6b80]">{relative(c.started_at)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge tone={c.language === 'es' ? 'brand' : c.language === 'mixed' ? 'sky' : 'neutral'}>
                      {c.language === 'mixed' ? 'EN/ES' : c.language?.toUpperCase() ?? 'EN'}
                    </Badge>
                    <span className="text-[10.5px] text-[#5a6b80]">{seconds(c.duration_sec)}</span>
                    <span className="truncate text-[10.5px] text-[#7b8b9f]">{c.summary}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="mt-4">
            <CardHead title="Texts sent" subtitle={`${sms.length} total`} />
            <ul className="divide-y divide-[#171f2a]">
              {sms.slice(0, 2).map((s) => (
                <li key={s.id} className="px-5 py-3">
                  <p className="line-clamp-2 text-[11.5px] leading-relaxed text-[#9fb0c5]">{s.body}</p>
                  <p className="mt-1 font-mono text-[10px] text-[#5a6b80]">{s.to_phone} · {s.status}</p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </main>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'warn' }) {
  return (
    <div className="rounded-xl border border-[#1f2937] bg-[#0d1117]/80 p-4">
      <p className="text-[10.5px] uppercase tracking-wider text-[#6b7b91]">{label}</p>
      <p className={`mt-1.5 text-[22px] font-semibold tabular-nums tracking-tight ${tone === 'warn' ? 'text-[#f2c86b]' : 'text-white'}`}>{value}</p>
      <p className="text-[10.5px] text-[#5a6b80]">{sub}</p>
    </div>
  );
}
