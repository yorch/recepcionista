'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookingPanel } from './booking-panel';
import { DayList } from './day-list';
import { MonthGrid } from './month-grid';
import { StatusLegend } from './status';
import { TimeGrid } from './time-grid';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { groupByDay, monthGrid, nextDate, previousDate, rangeFor, type CalendarView, type WeekStart } from '@/lib/calendar';
import { addDaysToDateKey, isDateKey } from '@/lib/time';
import type { BookingsRangeResult } from '@/app/api/bookings/route';
import type { Booking, Hours } from '@/lib/types';

const VIEWS: { id: CalendarView; label: string }[] = [{ id: 'week', label: 'Week' }, { id: 'day', label: 'Day' }, { id: 'month', label: 'Month' }];
const dateLabel = (key: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));

function titleFor(view: CalendarView, date: string, days: string[]): string {
  if (view === 'day') return dateLabel(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (view === 'month') return dateLabel(date, { month: 'long', year: 'numeric' });
  const a = days[0];
  const b = days[days.length - 1];
  const start = dateLabel(a, { month: 'short', day: 'numeric' });
  if (a.slice(0, 4) !== b.slice(0, 4)) return `${start}, ${a.slice(0, 4)} to ${dateLabel(b, { month: 'short', day: 'numeric' })}, ${b.slice(0, 4)}`;
  const end = a.slice(0, 7) === b.slice(0, 7) ? String(Number(b.slice(8))) : dateLabel(b, { month: 'short', day: 'numeric' });
  return `${start} to ${end}, ${b.slice(0, 4)}`;
}

export interface CalendarProps {
  businessId: string;
  canManage: boolean;
  hours: Hours;
  /** Today's date in the business zone, computed on the server so the first paint matches. */
  todayKey: string;
  initial: BookingsRangeResult;
}

export function Calendar({ businessId, canManage, hours, todayKey, initial }: CalendarProps) {
  const tz = initial.timezone;
  const [view, setView] = useState<CalendarView>(initial.view);
  const [date, setDate] = useState(initial.date);
  const [ws, setWs] = useState<WeekStart>(initial.week_start);
  const [data, setData] = useState<BookingsRangeResult>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Booking | null>(null);
  const [mobileDay, setMobileDay] = useState(initial.view === 'day' ? initial.date : (initial.days.includes(todayKey) ? todayKey : initial.days[0]));
  const [now, setNow] = useState<number | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const first = useRef(true);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const t0 = setTimeout(tick, 0); // after mount, from a callback: the server render never reads the clock
    const t = setInterval(tick, 60_000);
    return () => { clearTimeout(t0); clearInterval(t); };
  }, []);

  // Remember a viewer's week-start choice (a per-viewer convenience only: the server default is the business's country).
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const saved = window.localStorage.getItem('rc_week_start');
        if ((saved === '0' || saved === '1') && Number(saved) !== initial.week_start && !new URL(window.location.href).searchParams.has('ws')) setWs(Number(saved) as WeekStart);
      } catch { /* storage unavailable: keep the default */ }
    }, 0);
    return () => clearTimeout(t);
  }, [initial.week_start]);

  const local = useMemo(() => rangeFor(view, date, tz, ws), [view, date, tz, ws]);
  const fetchKey = `${view}|${date}|${ws}`;

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ view, date, ws: String(ws), business_id: businessId });
      const r = await apiRequest<BookingsRangeResult>(`/api/bookings?${q}`, { signal });
      setData(r);
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof ApiError ? err.message : 'Could not load the calendar.');
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [view, date, ws, businessId]);

  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
    // `fetchKey` is the real dependency; `retry` re-runs after an error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey, retry]);

  // Keep the address bar shareable without a server round trip.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('view', view);
      url.searchParams.set('date', date);
      window.history.replaceState(null, '', url);
    } catch { /* non-browser */ }
  }, [view, date]);

  const go = (v: CalendarView, d: string) => {
    if (!isDateKey(d)) return;
    setView(v);
    setDate(d);
    if (v === 'day') setMobileDay(d);
    else setMobileDay((cur) => (rangeFor(v, d, tz, ws).days.includes(cur) ? cur : rangeFor(v, d, tz, ws).days.includes(todayKey) ? todayKey : rangeFor(v, d, tz, ws).days[0]));
  };

  const open = useCallback((b: Booking, el: HTMLElement) => { openerRef.current = el; setSelected(b); }, []);
  const close = useCallback(() => {
    setSelected(null);
    const el = openerRef.current;
    if (el && document.contains(el)) setTimeout(() => el.focus(), 0);
  }, []);
  const changed = useCallback((b: Booking) => {
    setSelected(b);
    setData((d) => ({ ...d, items: d.items.map((x) => (x.id === b.id ? b : x)) }));
  }, []);

  const items = data.items;
  const weeks = useMemo(() => (view === 'month' ? monthGrid(date, ws) : []), [view, date, ws]);
  const mobileDays = useMemo(() => (view === 'day' ? [date] : local.days), [view, date, local.days]);
  const byDay = useMemo(() => groupByDay(items, mobileDays, tz), [items, mobileDays, tz]);
  const gridDays = view === 'month' ? [] : local.days;
  const empty = !loading && !error && items.length === 0;

  const nav = 'min-h-11 min-w-11';
  return (
    <section aria-label="Booking calendar">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Button variant="outline" className={nav} aria-label={`Previous ${view}`} onClick={() => go(view, previousDate(view, date))}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 6l-6 6 6 6" /></svg>
          </Button>
          <Button variant="outline" onClick={() => go(view, todayKey)} disabled={local.days.includes(todayKey) && (view !== 'month' || date.slice(0, 7) === todayKey.slice(0, 7)) && date === todayKey}>Today</Button>
          <Button variant="outline" className={nav} aria-label={`Next ${view}`} onClick={() => go(view, nextDate(view, date))}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg>
          </Button>
        </div>
        <h2 aria-live="polite" className="min-w-0 flex-1 basis-48 text-[16px] font-semibold tracking-tight text-white">{titleFor(view, date, local.days)}</h2>
        <label className="flex items-center gap-2 text-xs text-mute">
          <span className="sr-only sm:not-sr-only">Go to</span>
          <input
            type="date"
            value={date}
            onChange={(e) => { if (isDateKey(e.target.value)) go(view, e.target.value); }}
            aria-label="Go to date"
            className="min-h-11 rounded-xl border border-line-3 bg-sunken px-2.5 text-[13px] text-soft [color-scheme:dark]"
          />
        </label>
        <div role="group" aria-label="Calendar view" className="inline-flex overflow-hidden rounded-xl border border-line-3">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={view === v.id}
              onClick={() => go(v.id, date)}
              className={cn('min-h-11 px-3.5 text-[13px] font-medium transition-colors', view === v.id ? 'bg-raised text-white' : 'text-mute hover:bg-hover hover:text-soft')}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <StatusLegend />
        <div className="flex items-center gap-3 text-xs text-dim">
          <label className="flex items-center gap-1.5">
            Week starts
            <select
              value={ws}
              onChange={(e) => {
                const v = Number(e.target.value) as WeekStart;
                setWs(v);
                try { window.localStorage.setItem('rc_week_start', String(v)); } catch { /* ignore */ }
              }}
              className="min-h-9 rounded-lg border border-line-3 bg-sunken px-1.5 text-[12px] text-soft"
            >
              <option value={0}>Sunday</option>
              <option value={1}>Monday</option>
            </select>
          </label>
          <span>Times in {tz.replace('_', ' ')}</span>
        </div>
      </div>

      {error ? (
        <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger-line bg-danger-bg px-4 py-3 text-[13px] text-danger">
          <span>{error}</span>
          <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>Try again</Button>
        </div>
      ) : null}
      {data.truncated ? <p role="status" className="mt-3 text-xs text-warn">This view has more jobs than can be shown. Switch to a shorter range to see them all.</p> : null}

      <div className="mt-4">
        {loading && !error && data.items.length === 0 ? <Skeleton className="h-72 w-full" /> : null}
        {view === 'month' ? (
          <MonthGrid
            weeks={weeks} month={date.slice(0, 7)} bookings={items} tz={tz} todayKey={todayKey} weekStart={ws}
            loading={loading} onOpenDay={(d) => go('day', d)}
          />
        ) : (
          <>
            <div className="hidden md:block">
              <TimeGrid
                days={gridDays} bookings={items} hours={hours} tz={tz} todayKey={todayKey} now={now} loading={loading}
                selectedId={selected?.id ?? null} onOpen={open} onOpenDay={(d) => go('day', d)}
              />
            </div>
            <div className="md:hidden">
              {view === 'week' ? (
                <div role="group" aria-label="Day of the week" className="mb-3 grid grid-cols-7 gap-1">
                  {mobileDays.map((d) => {
                    const n = byDay.get(d)?.length ?? 0;
                    const sel = d === mobileDay;
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={sel}
                        aria-label={`${dateLabel(d, { weekday: 'long', month: 'long', day: 'numeric' })}, ${n} ${n === 1 ? 'job' : 'jobs'}`}
                        onClick={() => setMobileDay(d)}
                        className={cn('flex min-h-14 flex-col items-center justify-center rounded-xl border text-xs', sel ? 'border-brand bg-brand-bg text-white' : 'border-line text-mute', d === todayKey && !sel && 'border-brand-line')}
                      >
                        <span className="uppercase">{dateLabel(d, { weekday: 'short' }).slice(0, 2)}</span>
                        <span className="text-[15px] font-semibold text-white">{Number(d.slice(8))}</span>
                        <span aria-hidden="true" className={cn('mt-0.5 h-1 w-1 rounded-full', n > 0 ? 'bg-brand-soft' : 'bg-transparent')} />
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-dim">{dateLabel(mobileDay, { weekday: 'long', month: 'long', day: 'numeric' })}{mobileDay === todayKey ? ' (today)' : ''}</p>
              <DayList items={byDay.get(mobileDay) ?? []} tz={tz} selectedId={selected?.id ?? null} loading={loading} onOpen={open} />
              {view === 'day' ? (
                <div className="mt-3 flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => go('day', addDaysToDateKey(date, -1))}>Previous day</Button>
                  <Button variant="outline" className="flex-1" onClick={() => go('day', addDaysToDateKey(date, 1))}>Next day</Button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>

      {empty ? (
        <p className="mt-4 rounded-2xl border border-line bg-panel/60 px-5 py-6 text-center text-[13px] leading-relaxed text-mute">
          Nothing booked {view === 'month' ? 'this month' : view === 'week' ? 'this week' : 'this day'}. Jobs the receptionist books show up here on your business hours.
        </p>
      ) : null}

      {selected ? <BookingPanel key={selected.id} booking={selected} tz={tz} canManage={canManage} onClose={close} onChanged={changed} /> : null}
    </section>
  );
}
