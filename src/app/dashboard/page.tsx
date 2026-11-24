import type { Metadata } from 'next';
import Link from 'next/link';
import { getDashboardContext } from '@/lib/dashboard-context';
import { hasRole } from '@/lib/session';
import { countSms, getDashboardStats, getLatestBriefing, listBookingsPage, listCalls, listCallsPage, listSmsPage } from '@/lib/db';
import { dayLabelET, money, relative, seconds, timeET } from '@/lib/format';
import { callModeView } from '@/lib/voice/call-mode';
import { CallModeSwitch } from '@/components/dashboard/call-mode';
import { tzOf } from '@/lib/time';
import { longDate, greetingFor } from '@/components/dashboard/dates';
import { Badge } from '@/components/ui/badge';
import { Card, CardHead } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty';
import { Stat } from '@/components/ui/stat';
import { VoicePlayer } from '@/components/ui/audio';

export const metadata: Metadata = { title: 'Today' };

export const dynamic = 'force-dynamic';

export default async function TodayPage() {
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const tz = tzOf(biz);

  // Read the clock once so the render stays pure and every value below agrees. "Today" is the BUSINESS's day.
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);

  // Bounded queries only: counts and sums come from SQL aggregates in the business zone, lists are the few rows shown.
  const [stats, recent, flagged, upcomingPage, briefing, smsPage, smsTotal] = await Promise.all([
    getDashboardStats(biz.id, tz, now),
    listCallsPage(biz.id, { limit: 4 }),
    listCalls(biz.id, undefined, undefined, { limit: 3, flaggedSince: weekAgo }),
    listBookingsPage(biz.id, { direction: 'upcoming', limit: 12, now }),
    getLatestBriefing(biz.id),
    listSmsPage(biz.id, { limit: 2 }),
    countSms(biz.id),
  ]);
  const calls = recent.items;
  const sms = smsPage.items;
  const upcoming = upcomingPage.items.filter((b) => b.status !== 'cancelled' && b.status !== 'completed');
  const needsYou = flagged;
  const isOwner = hasRole(ctx.principal, 'owner');
  const hasActivity = recent.items.length > 0 || upcomingPage.items.length > 0 || stats.calls_today > 0;
  const mode = callModeView(biz, { full: isOwner }, now);

  const greeting = greetingFor(now, tz);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-dim">{longDate(now, tz)}</p>
          <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.02em] text-white">
            {biz.owner_name ? `${greeting}, ${biz.owner_name}.` : `${greeting}.`}
          </h1>
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          {biz.phone ? (
            <a
              href={`tel:${biz.phone}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-mint-line bg-mint-bg px-4 py-1.5 font-mono text-[13px] text-mint-text transition-colors hover:border-mint"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-mint live-dot" />
              <span className="sr-only">Your front desk number: </span>
              {biz.phone}
            </a>
          ) : null}
          {biz.phone ? <CallModeSwitch businessId={biz.id} initial={mode} canManage={isOwner} compact /> : null}
        </div>
      </header>

      {!hasActivity ? (
        <div className="mt-6">
          <EmptyState
            title={biz.phone ? 'Waiting for your first call' : 'Your receptionist is almost ready'}
            body={biz.phone
              ? 'Call your number from another phone to hear her, then forward your business line to it so real customers reach her.'
              : 'Finish setup to get a phone number. Calls, bookings and deposits will show up here.'}
            cta={isOwner ? { href: '/onboarding', label: biz.phone ? 'Test call and forwarding' : 'Finish setup' } : undefined}
            secondary={{ href: '/dashboard/knowledge', label: 'Review what she knows' }}
          />
        </div>
      ) : null}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Calls today" value={String(stats.calls_today)} sub={`${stats.bilingual_today} bilingual today`} />
        <Stat label="Booked" value={String(stats.bookings_upcoming)} sub="upcoming jobs" />
        <Stat label="Deposits" value={money(stats.deposits_month_cents)} sub="paid, jobs this month" />
        <Stat label="Needs you" value={String(stats.needs_attention)} sub="flagged, last 7 days" tone={stats.needs_attention ? 'warn' : undefined} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <Card>
            <CardHead
              title="Your briefing"
              subtitle={briefing ? `${briefing.date} · ${briefing.stats.calls} calls, ${briefing.stats.bookings} booked` : 'Not generated yet'}
              right={<Link href="/dashboard/briefings" className="text-xs text-brand-soft hover:underline">All briefings</Link>}
            />
            <div className="p-4">
              <VoicePlayer src={briefing?.audio_url} label={briefing ? `Evening note · ${briefing.date}` : 'No briefing yet'} />
              {briefing ? (
                <p className="mt-4 max-h-40 overflow-y-auto rounded-xl bg-sunken p-3.5 text-[13px] leading-relaxed text-body">
                  {briefing.transcript}
                </p>
              ) : (
                <p className="mt-3 text-[13px] text-dim">
                  A short voice note about your day.{' '}
                  <Link href="/dashboard/briefings" className="text-brand-soft hover:underline">Generate your first one</Link>.
                </p>
              )}
            </div>
          </Card>

          <Card className="mt-4">
            <CardHead title="Next up" subtitle="Booked by her, no one called you" right={<Link href="/dashboard/bookings" className="text-xs text-brand-soft hover:underline">Calendar</Link>} />
            <ul className="divide-y divide-[#171f2a]">
              {upcoming.slice(0, 4).map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="w-[86px] shrink-0">
                    <p className="text-xs font-medium text-brand-soft">{dayLabelET(b.scheduled_at, tz, now)}</p>
                    <p className="font-mono text-[13px] text-white">{timeET(b.scheduled_at, tz)}</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-white">{b.customer_name}</p>
                    <p className="truncate text-xs text-dim">{b.service}</p>
                  </div>
                  <span className="tabular-nums text-xs text-body">{money(b.price_estimate)}</span>
                </li>
              ))}
              {upcoming.length === 0 ? (
                <li className="px-5 py-8 text-center text-[13px] text-dim">Nothing on the books yet. Bookings she makes will appear here.</li>
              ) : null}
            </ul>
          </Card>
        </div>

        <div className="min-w-0 lg:col-span-2">
          <Card>
            <CardHead title="Needs your call" subtitle="She flagged these" />
            <ul className="divide-y divide-[#171f2a]">
              {needsYou.slice(0, 3).map((c) => (
                <li key={c.id} className="px-5 py-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[13px] text-white">{c.caller_name ?? c.caller_phone}</p>
                    <Badge tone={c.urgency}>{c.urgency}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-body">{c.flagged_reason}</p>
                  {c.caller_phone ? (
                    <a href={`tel:${c.caller_phone}`} className="mt-1.5 inline-flex min-h-11 items-center font-mono text-xs text-brand-soft hover:underline">
                      Call back {c.caller_phone}
                    </a>
                  ) : null}
                </li>
              ))}
              {needsYou.length === 0 ? (
                <li className="px-5 py-8 text-center text-[13px] text-dim">All clear. Anything she cannot handle will show up here.</li>
              ) : null}
            </ul>
          </Card>

          <Card className="mt-4">
            <CardHead title="Recent calls" right={<Link href="/dashboard/calls" className="text-xs text-brand-soft hover:underline">All</Link>} />
            <ul className="divide-y divide-[#171f2a]">
              {calls.slice(0, 4).map((c) => (
                <li key={c.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[13px] text-white">{c.caller_name ?? c.caller_phone}</p>
                    <span className="shrink-0 text-xs text-dim">{relative(c.started_at)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge tone={c.language === 'es' ? 'brand' : c.language === 'mixed' ? 'sky' : 'neutral'}>
                      {c.language === 'mixed' ? 'EN/ES' : c.language?.toUpperCase() ?? 'EN'}
                    </Badge>
                    <span className="text-xs text-dim">{seconds(c.duration_sec)}</span>
                    <span className="truncate text-xs text-body">{c.summary}</span>
                  </div>
                </li>
              ))}
              {calls.length === 0 ? <li className="px-5 py-6 text-center text-[13px] text-dim">No calls yet.</li> : null}
            </ul>
          </Card>

          <Card className="mt-4">
            <CardHead title="Texts sent" subtitle={`${smsTotal} total`} />
            <ul className="divide-y divide-[#171f2a]">
              {sms.slice(0, 2).map((s) => (
                <li key={s.id} className="px-5 py-3">
                  <p className="line-clamp-2 text-xs leading-relaxed text-body">{s.body}</p>
                  <p className="mt-1 font-mono text-xs text-dim">{s.to_phone} · {s.status}</p>
                </li>
              ))}
              {sms.length === 0 ? <li className="px-5 py-6 text-center text-[13px] text-dim">No texts yet. Confirmations and deposit links appear here.</li> : null}
            </ul>
          </Card>
        </div>
      </div>
    </main>
  );
}
