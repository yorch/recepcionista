import { splitAuto } from '@/lib/auto-label';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getDashboardContext } from '@/lib/dashboard-context';
import { getLocale, getT } from '@/lib/i18n/server';
import { formatPhoneDisplay } from '@/lib/i18n/core';
import { hasRole } from '@/lib/session';
import { countSms, getDashboardStats, getLatestBriefing, listBookingsPage, listCalls, listCallsPage, listSmsPage } from '@/lib/db';
import { dayLabelET, money, relative, seconds, timeET } from '@/lib/format';
import { callModeView } from '@/lib/voice/call-mode';
import { CallModeSwitch } from '@/components/dashboard/call-mode';
import { tzOf } from '@/lib/time';
import { listLiveCalls } from '@/lib/voice/live-transcript';
import { longDate, greetingFor } from '@/components/dashboard/dates';
import { Badge } from '@/components/ui/badge';
import { Card, CardHead } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty';
import { Stat } from '@/components/ui/stat';
import { VoicePlayer } from '@/components/ui/audio';
import { CalendarNotice } from '@/components/dashboard/calendar-notice';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('today.title') };
}

export const dynamic = 'force-dynamic';

export default async function TodayPage() {
  const t = await getT();
  const locale = await getLocale();
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
  const liveCalls = await listLiveCalls(biz.id, now).catch(() => []); // calls in progress right now (consented ones only)
  const calls = recent.items;
  const sms = smsPage.items;
  const upcoming = upcomingPage.items.filter((b) => b.status !== 'cancelled' && b.status !== 'completed');
  const needsYou = flagged;
  const isOwner = hasRole(ctx.principal, 'owner');
  const hasActivity = recent.items.length > 0 || upcomingPage.items.length > 0 || stats.calls_today > 0;
  const mode = callModeView(biz, { full: isOwner }, now);

  const greeting = greetingFor(now, tz, locale);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-dim">{longDate(now, tz, locale)}</p>
          <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.02em] text-white">
            {biz.owner_name ? t('today.greeting', { greeting, name: biz.owner_name }) : t('today.greetingAnon', { greeting })}
          </h1>
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          {biz.phone ? (
            <a
              href={`tel:${biz.phone}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-mint-line bg-mint-bg px-4 py-1.5 font-mono text-[13px] text-mint-text transition-colors hover:border-mint"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-mint live-dot" />
              <span className="sr-only">{t('today.frontDeskNumber')} </span>
              {formatPhoneDisplay(biz.phone)}
            </a>
          ) : null}
          {biz.phone ? <CallModeSwitch businessId={biz.id} initial={mode} canManage={isOwner} compact /> : null}
        </div>
      </header>

      <CalendarNotice business={biz} canManage={isOwner} />

      {!hasActivity ? (
        <div className="mt-6">
          <EmptyState
            title={biz.phone ? t('today.waitingTitle') : t('today.almostTitle')}
            body={biz.phone ? t('today.waitingBody') : t('today.almostBody')}
            cta={isOwner ? { href: '/onboarding', label: biz.phone ? t('today.testCall') : t('shell.finishSetup') } : undefined}
            secondary={{ href: '/dashboard/knowledge', label: t('today.reviewKnows') }}
          />
        </div>
      ) : null}

      {liveCalls.length > 0 ? (
        <section aria-label={t('today.liveNow')} className="mt-6 rounded-2xl border border-mint-line bg-mint-bg p-4">
          <h2 className="flex items-center gap-2 text-[13px] font-medium text-mint-text">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-mint live-dot" />{t('today.liveNow')}
          </h2>
          <ul className="mt-2 space-y-1">
            {liveCalls.map((c) => (
              <li key={c.id}>
                <Link href={`/dashboard/calls/${c.id}`} className="inline-flex min-h-11 items-center text-[13px] text-mint-text hover:underline">
                  {t('today.watch', { caller: c.caller_phone ? formatPhoneDisplay(c.caller_phone) : t('calls.unknownCaller') })}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('today.stat.callsToday')} value={String(stats.calls_today)} sub={t('today.stat.bilingualToday', { n: stats.bilingual_today })} />
        <Stat label={t('today.stat.booked')} value={String(stats.bookings_upcoming)} sub={t('today.stat.upcomingJobs')} />
        <Stat label={t('today.stat.deposits')} value={money(stats.deposits_month_cents, locale)} sub={t('today.stat.depositsSub')} />
        <Stat label={t('today.stat.needsYou')} value={String(stats.needs_attention)} sub={t('today.stat.needsYouSub')} tone={stats.needs_attention ? 'warn' : undefined} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <Card>
            <CardHead
              title={t('today.briefing.title')}
              subtitle={briefing ? t('today.briefing.sub', { date: briefing.date, calls: briefing.stats.calls, bookings: briefing.stats.bookings }) : t('today.briefing.none')}
              right={<Link href="/dashboard/briefings" className="text-xs text-brand-soft hover:underline">{t('today.briefing.all')}</Link>}
            />
            <div className="p-4">
              <VoicePlayer src={briefing?.audio_url} emptyLabel={briefing ? t('audio.unavailable') : undefined} label={briefing ? t('today.briefing.eveningNote', { date: briefing.date }) : t('today.briefing.noneLabel')} />
              {briefing?.stats.narration === 'automatic' ? <p role="note" className="mt-3 text-xs text-warn">{t('pd.br.automatic')}</p> : null}
              {briefing ? (
                <p className="mt-4 max-h-40 overflow-y-auto rounded-xl bg-sunken p-3.5 text-[13px] leading-relaxed text-body">
                  {briefing.transcript}
                </p>
              ) : (
                <p className="mt-3 text-[13px] text-dim">
                  {t('today.briefing.blurb')}{' '}
                  <Link href="/dashboard/briefings" className="text-brand-soft hover:underline">{t('today.briefing.generate')}</Link>.
                </p>
              )}
            </div>
          </Card>

          <Card className="mt-4">
            <CardHead title={t('today.next.title')} subtitle={t('today.next.sub')} right={<Link href="/dashboard/bookings" className="text-xs text-brand-soft hover:underline">{t('today.next.calendar')}</Link>} />
            <ul className="divide-y divide-[#171f2a]">
              {upcoming.slice(0, 4).map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="w-[86px] shrink-0">
                    <p className="text-xs font-medium text-brand-soft">{dayLabelET(b.scheduled_at, tz, now, locale)}</p>
                    <p className="font-mono text-[13px] text-white">{timeET(b.scheduled_at, tz, locale)}</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-white">{b.customer_name}</p>
                    <p className="truncate text-xs text-dim">{b.service}</p>
                  </div>
                  <span className="tabular-nums text-xs text-body">{money(b.price_estimate, locale)}</span>
                </li>
              ))}
              {upcoming.length === 0 ? (
                <li className="px-5 py-8 text-center text-[13px] text-dim">{t('today.next.empty')}</li>
              ) : null}
            </ul>
          </Card>
        </div>

        <div className="min-w-0 lg:col-span-2">
          <Card>
            <CardHead title={t('today.needs.title')} subtitle={t('today.needs.sub')} />
            <ul className="divide-y divide-[#171f2a]">
              {needsYou.slice(0, 3).map((c) => (
                <li key={c.id} className="px-5 py-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[13px] text-white">{c.caller_name ?? c.caller_phone}</p>
                    <Badge tone={c.urgency}>{t(`urgency.${c.urgency}` as const)}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-body">{c.flagged_reason}</p>
                  {c.caller_phone ? (
                    <a href={`tel:${c.caller_phone}`} className="mt-1.5 inline-flex min-h-11 items-center font-mono text-xs text-brand-soft hover:underline">
                      {t('today.needs.callBack', { phone: formatPhoneDisplay(c.caller_phone) })}
                    </a>
                  ) : null}
                </li>
              ))}
              {needsYou.length === 0 ? (
                <li className="px-5 py-8 text-center text-[13px] text-dim">{t('today.needs.empty')}</li>
              ) : null}
            </ul>
          </Card>

          <Card className="mt-4">
            <CardHead title={t('today.recent.title')} right={<Link href="/dashboard/calls" className="text-xs text-brand-soft hover:underline">{t('today.recent.all')}</Link>} />
            <ul className="divide-y divide-[#171f2a]">
              {calls.slice(0, 4).map((c) => (
                <li key={c.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[13px] text-white">{c.caller_name ?? c.caller_phone}</p>
                    <span className="shrink-0 text-xs text-dim">{relative(c.started_at, now.getTime(), locale)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge tone={c.language === 'es' ? 'brand' : c.language === 'mixed' ? 'sky' : 'neutral'}>
                      {c.language === 'mixed' ? 'EN/ES' : c.language?.toUpperCase() ?? '—'}
                    </Badge>
                    <span className="text-xs text-dim">{seconds(c.duration_sec)}</span>
                    <span className="truncate text-xs text-body">{splitAuto(c.summary).text}</span>
                  </div>
                </li>
              ))}
              {calls.length === 0 ? <li className="px-5 py-6 text-center text-[13px] text-dim">{t('today.recent.empty')}</li> : null}
            </ul>
          </Card>

          <Card className="mt-4">
            <CardHead title={t('today.sms.title')} subtitle={t('today.sms.total', { n: smsTotal })} />
            <ul className="divide-y divide-[#171f2a]">
              {sms.slice(0, 2).map((s) => (
                <li key={s.id} className="px-5 py-3">
                  <p className="line-clamp-2 text-xs leading-relaxed text-body">{s.body}</p>
                  <p className="mt-1 font-mono text-xs text-dim">{s.to_phone} · {s.status}</p>
                </li>
              ))}
              {sms.length === 0 ? <li className="px-5 py-6 text-center text-[13px] text-dim">{t('today.sms.empty')}</li> : null}
            </ul>
          </Card>
        </div>
      </div>
    </main>
  );
}
