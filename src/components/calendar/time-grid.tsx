'use client';
import { useMemo, useRef } from 'react';
import { StatusIcon } from './status';
import { BusyLayer, useBusyBlocks } from './busy-layer';
import { cn } from '@/components/ui/cn';
import { axisFor, blockBox, groupByDay, hourLabel, layoutLanes, nowLine, STATUS_META, type Axis } from '@/lib/calendar';
import { timeET } from '@/lib/format';
import { useLocale, useT } from '@/lib/i18n/client';
import { intlTag, type Locale } from '@/lib/i18n/core';
import type { Booking, Hours } from '@/lib/types';

const PX_PER_HOUR = 64;

const dayHeading = (key: string, locale: Locale) => {
  const d = new Date(`${key}T12:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat(intlTag(locale), { weekday: 'short', timeZone: 'UTC' }).format(d),
    long: new Intl.DateTimeFormat(intlTag(locale), { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d),
    num: d.getUTCDate(),
  };
};

export interface TimeGridProps {
  days: string[];
  bookings: Booking[];
  hours: Hours;
  tz: string;
  todayKey: string;
  /** `Date.now()` once mounted (null during server render so there is no hydration mismatch). */
  now: number | null;
  loading: boolean;
  selectedId: string | null;
  onOpen: (b: Booking, el: HTMLElement) => void;
  onOpenDay: (day: string) => void;
  /** Owner only: a click on an empty part of a day column (day key, wall-clock minutes from midnight, rounded down to the half hour). Keyboard users use the "New booking" button. */
  onEmptySlot?: (day: string, minutes: number) => void;
}

/** Week / day time grid (md and up): hour rows on the business's open hours, blocks sized by duration. */
export function TimeGrid({ days, bookings, hours, tz, todayKey, now, loading, selectedId, onOpen, onOpenDay, onEmptySlot }: TimeGridProps) {
  const t = useT();
  const locale = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const busyBlocks = useBusyBlocks(days, tz);
  const grouped = useMemo(() => groupByDay(bookings, days, tz), [bookings, days, tz]);
  const axis: Axis = useMemo(() => axisFor(hours, days, tz, [...grouped.values()].flat().map((x) => x.segment)), [hours, days, tz, grouped]);
  const hourMarks = useMemo(() => {
    const out: number[] = [];
    for (let m = axis.startMin; m < axis.endMin; m += 60) out.push(m);
    return out;
  }, [axis]);
  const height = ((axis.endMin - axis.startMin) / 60) * PX_PER_HOUR;
  const cols = `56px repeat(${days.length}, minmax(0, 1fr))`;

  // Arrow keys: left/right between days (a day header or the nearest job in the next day), up/down within a day. Enter opens (native button).
  function onKeyDown(e: React.KeyboardEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
    if (!el || !rootRef.current) return;
    const day = el.dataset.day!;
    const idx = days.indexOf(day);
    const jobsOf = (d: string) => [...rootRef.current!.querySelectorAll<HTMLElement>(`[data-nav="booking"][data-day="${d}"]`)];
    const headerOf = (d: string) => rootRef.current!.querySelector<HTMLElement>(`[data-nav="day"][data-day="${d}"]`);
    let next: HTMLElement | null | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const nd = days[idx + (e.key === 'ArrowRight' ? 1 : -1)];
      if (!nd) return;
      if (el.dataset.nav === 'booking') {
        const start = Number(el.dataset.start);
        next = jobsOf(nd).sort((a, b) => Math.abs(Number(a.dataset.start) - start) - Math.abs(Number(b.dataset.start) - start))[0] ?? headerOf(nd);
      } else next = headerOf(nd);
    } else if (e.key === 'ArrowDown') {
      const jobs = jobsOf(day);
      next = el.dataset.nav === 'day' ? jobs[0] : jobs[jobs.indexOf(el) + 1];
    } else if (e.key === 'ArrowUp') {
      const jobs = jobsOf(day);
      const i = jobs.indexOf(el);
      next = el.dataset.nav === 'booking' ? (i > 0 ? jobs[i - 1] : headerOf(day)) : undefined;
    } else return;
    if (next) { e.preventDefault(); next.focus(); }
  }

  const totalJobs = bookings.length;

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      role="group"
      aria-label={t('cal.grid')}
      aria-busy={loading}
      className={cn('overflow-x-auto rounded-2xl border border-line bg-panel/80', loading && 'opacity-70')}
    >
      <div className="min-w-[720px]">
        <div className="sticky top-0 z-10 grid border-b border-line bg-panel" style={{ gridTemplateColumns: cols }}>
          <div aria-hidden="true" />
          {days.map((d) => {
            const h = dayHeading(d, locale);
            const isToday = d === todayKey;
            return (
              <button
                key={d}
                type="button"
                data-nav="day"
                data-day={d}
                onClick={() => onOpenDay(d)}
                aria-label={t('cal.openDay', { long: h.long, today: isToday ? ` ${t('cal.todayParen')}` : '' })}
                aria-current={isToday ? 'date' : undefined}
                className="flex min-h-14 flex-col items-center justify-center gap-0.5 border-l border-line py-2 text-xs text-mute hover:bg-hover"
              >
                <span className="uppercase tracking-wider">{h.weekday}</span>
                <span className={cn('grid h-7 min-w-7 place-items-center rounded-full px-1 text-[14px] font-semibold', isToday ? 'bg-brand text-on-brand' : 'text-white')}>{h.num}</span>
              </button>
            );
          })}
        </div>

        <div className="relative grid" style={{ gridTemplateColumns: cols, height }}>
          <div aria-hidden="true" className="relative">
            {hourMarks.map((m) => (
              <span key={m} className={cn('absolute right-2 text-[11px] text-dim', m === axis.startMin ? 'translate-y-0.5' : '-translate-y-1/2')} style={{ top: `${((m - axis.startMin) / (axis.endMin - axis.startMin)) * 100}%` }}>
                {hourLabel(m, locale)}
              </span>
            ))}
          </div>
          {days.map((d) => {
            const items = grouped.get(d) ?? [];
            const lanes = new Map(layoutLanes(items.map((i) => ({ bookingId: i.booking.id, startMin: i.segment.startMin, endMin: i.segment.endMin }))).map((l) => [l.bookingId, l]));
            const line = d === todayKey && now !== null ? nowLine(new Date(now), tz, axis) : null;
            return (
              <div
                key={d}
                className={cn('relative border-l border-line', d === todayKey && 'bg-brand/[0.03]', onEmptySlot && 'cursor-cell')}
                onClick={onEmptySlot ? (e) => {
                  if ((e.target as HTMLElement).closest('button')) return; // a booking block opens its own panel
                  const rect = e.currentTarget.getBoundingClientRect();
                  if (rect.height <= 0) return;
                  const span = axis.endMin - axis.startMin;
                  const minutes = axis.startMin + Math.min(span - 30, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * span / 30) * 30));
                  onEmptySlot(d, minutes);
                } : undefined}
              >
                {hourMarks.map((m) => (
                  <div key={m} aria-hidden="true" className="absolute inset-x-0 border-t border-line/70" style={{ top: `${((m - axis.startMin) / (axis.endMin - axis.startMin)) * 100}%` }} />
                ))}
                <BusyLayer blocks={busyBlocks} day={d} tz={tz} axis={axis} />
                {line !== null ? <div aria-hidden="true" className="absolute inset-x-0 z-[5] border-t-2 border-brand" style={{ top: `${line}%` }}><span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-brand" /></div> : null}
                {items.map(({ booking: b, segment }) => {
                  const box = blockBox(segment, axis);
                  const lane = lanes.get(b.id) ?? { lane: 0, lanes: 1 };
                  const meta = STATUS_META[b.status];
                  const compact = (box.height / 100) * height < 44;
                  const statusLabel = t(`booking.status.${b.status}` as const);
                  const label = `${b.customer_name}, ${b.service}, ${timeET(b.scheduled_at, tz, locale)}, ${statusLabel}`;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      data-nav="booking"
                      data-day={d}
                      data-start={segment.startMin}
                      data-booking-id={b.id}
                      aria-label={label}
                      aria-haspopup="dialog"
                      aria-pressed={selectedId === b.id}
                      onClick={(e) => onOpen(b, e.currentTarget)}
                      className={cn(
                        'absolute z-[6] flex flex-col overflow-hidden rounded-lg border px-1.5 py-1 text-left text-[11.5px] leading-tight shadow-sm transition-[filter] hover:brightness-125',
                        meta.tone, b.status === 'cancelled' && 'opacity-75', selectedId === b.id && 'ring-2 ring-brand-soft',
                      )}
                      style={{ top: `calc(${box.top}% + 1px)`, height: `calc(${box.height}% - 2px)`, left: `calc(${(lane.lane / lane.lanes) * 100}% + 2px)`, width: `calc(${100 / lane.lanes}% - 4px)` }}
                    >
                      <span className="flex items-center gap-1 font-semibold">
                        <StatusIcon status={b.status} className="h-3 w-3" />
                        <span className="truncate">{b.customer_name}</span>
                      </span>
                      {!compact ? <span className="truncate opacity-90">{timeET(b.scheduled_at, tz, locale)} · {b.service}</span> : null}
                      {!compact && height * (box.height / 100) > 70 ? <span className="mt-auto truncate text-[10.5px] opacity-80">{statusLabel}</span> : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {totalJobs === 0 && !loading ? (
        <p className="border-t border-line px-4 py-3 text-center text-[13px] text-dim">{days.length === 1 ? t('cal.nothingInDay') : t('cal.nothingInWeek')}</p>
      ) : null}
    </div>
  );
}
