import type { Metadata } from 'next';
import Link from 'next/link';
import { getDashboardContext } from '@/lib/dashboard-context';
import { getT } from '@/lib/i18n/server';
import { hasRole } from '@/lib/session';
import { countryForBusiness, listAllBookingsInRange, listBookingsPage } from '@/lib/db';
import { PageHeader } from '@/components/ui/page-header';
import { Calendar } from '@/components/calendar/calendar';
import { Agenda } from '@/components/calendar/agenda';
import { cn } from '@/components/ui/cn';
import { defaultWeekStart, isCalendarDateKey, isCalendarView, parseWeekStart, rangeFor } from '@/lib/calendar';
import { localDateKey, tzOf } from '@/lib/time';
import type { BookingsRangeResult } from '@/app/api/bookings/route';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('booking.pageTitle') };
}

export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const t = await getT();
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const tz = tzOf(biz);
  const q = await searchParams;
  const tab = one(q.tab) === 'agenda' ? 'agenda' : 'calendar';
  const canManage = hasRole(ctx.principal, 'owner');
  const todayKey = localDateKey(new Date(), tz);

  const tabClass = (active: boolean) => cn('inline-flex min-h-11 items-center rounded-xl px-4 text-[13px] font-medium', active ? 'bg-raised text-white' : 'text-mute hover:bg-hover hover:text-soft');

  let body: React.ReactNode;
  if (tab === 'agenda') {
    const initial = await listBookingsPage(biz.id, { direction: 'upcoming', limit: 25 });
    body = <Agenda businessId={biz.id} tz={tz} initial={initial} />;
  } else {
    const view = isCalendarView(one(q.view)) ? (one(q.view) as 'week' | 'day' | 'month') : 'week';
    const rawDate = one(q.date);
    const date = rawDate && isCalendarDateKey(rawDate) ? rawDate : todayKey;
    const ws = parseWeekStart(one(q.ws), defaultWeekStart({ country: countryForBusiness(biz), timezone: tz }));
    const range = rangeFor(view, date, tz, ws);
    const { items, truncated } = await listAllBookingsInRange(biz.id, range.from, range.to);
    const initial: BookingsRangeResult = {
      view, date, days: range.days, from: range.from.toISOString(), to: range.to.toISOString(), timezone: tz, week_start: ws, items, truncated,
    };
    body = <Calendar businessId={biz.id} canManage={canManage} hours={biz.hours} todayKey={todayKey} initial={initial} />;
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title={t('booking.pageTitle')}
        subtitle={t('booking.pageSubtitle')}
        right={
          <nav aria-label={t('booking.tabsLabel')} className="inline-flex gap-1 rounded-2xl border border-line p-1">
            <Link href="/dashboard/bookings" aria-current={tab === 'calendar' ? 'page' : undefined} className={tabClass(tab === 'calendar')}>{t('booking.tab.calendar')}</Link>
            <Link href="/dashboard/bookings?tab=agenda" aria-current={tab === 'agenda' ? 'page' : undefined} className={tabClass(tab === 'agenda')}>{t('booking.tab.agenda')}</Link>
          </nav>
        }
      />
      <div className="mt-6">{body}</div>
    </main>
  );
}
