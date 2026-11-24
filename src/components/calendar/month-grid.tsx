'use client';
import { useRef } from 'react';
import { StatusIcon } from './status';
import { cn } from '@/components/ui/cn';
import { countsByDay, STATUS_META, STATUS_ORDER, weekdayName, type WeekStart } from '@/lib/calendar';
import { useLocale, useT } from '@/lib/i18n/client';
import { intlTag } from '@/lib/i18n/core';
import type { Booking } from '@/lib/types';

/** Month overview: one cell per day with how many jobs start that day, by status (icon + number). Enter opens the day. */
export function MonthGrid({
  weeks, month, bookings, tz, todayKey, weekStart, loading, onOpenDay,
}: {
  weeks: string[][];
  /** YYYY-MM of the month being viewed (neighbour days are dimmed). */
  month: string;
  bookings: Booking[];
  tz: string;
  todayKey: string;
  weekStart: WeekStart;
  loading: boolean;
  onOpenDay: (day: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const counts = countsByDay(bookings, tz);
  const flat = weeks.flat();
  const heads = Array.from({ length: 7 }, (_, i) => weekdayName((weekStart + i) % 7, locale));

  function onKeyDown(e: React.KeyboardEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    if (!el) return;
    const i = flat.indexOf(el.dataset.day!);
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 7 : e.key === 'ArrowUp' ? -7 : 0;
    if (!step) return;
    const target = flat[i + step];
    if (!target) return;
    e.preventDefault();
    rootRef.current?.querySelector<HTMLElement>(`[data-cell][data-day="${target}"]`)?.focus();
  }

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} role="group" aria-label={t('cal.monthOverview')} aria-busy={loading} className={cn('overflow-hidden rounded-2xl border border-line bg-panel/80', loading && 'opacity-70')}>
      <div className="grid grid-cols-7 border-b border-line text-center text-[11px] uppercase tracking-wider text-dim">
        {heads.map((h) => <div key={h} className="py-2"><span className="hidden sm:inline">{h}</span><span aria-hidden="true" className="sm:hidden">{h[0]}</span><span className="sr-only sm:hidden">{h}</span></div>)}
      </div>
      {weeks.map((w) => (
        <div key={w[0]} className="grid grid-cols-7">
          {w.map((d) => {
            const c = counts.get(d);
            const inMonth = d.startsWith(month);
            const isToday = d === todayKey;
            const dayNum = Number(d.slice(8));
            const summary = c ? STATUS_ORDER.filter((s) => c[s] > 0).map((s) => `${c[s]} ${t(`booking.status.${s}` as const).toLowerCase()}`).join(', ') : t('cal.nothingBooked');
            return (
              <button
                key={d}
                type="button"
                data-cell
                data-day={d}
                onClick={() => onOpenDay(d)}
                aria-label={`${new Intl.DateTimeFormat(intlTag(locale), { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))}: ${summary}`}
                aria-current={isToday ? 'date' : undefined}
                className={cn('flex min-h-[72px] flex-col items-start gap-1 border-b border-r border-line p-1.5 text-left hover:bg-hover sm:min-h-[92px] sm:p-2', !inMonth && 'bg-sunken/50 text-dim')}
              >
                <span className={cn('grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs font-semibold', isToday ? 'bg-brand text-on-brand' : inMonth ? 'text-white' : 'text-dim')}>{dayNum}</span>
                {c ? (
                  <span className="flex flex-wrap gap-1">
                    {STATUS_ORDER.filter((s) => c[s] > 0).map((s) => (
                      <span key={s} className={cn('inline-flex items-center gap-0.5 rounded-md border px-1 py-px text-[10.5px] font-medium', STATUS_META[s].tone.replace('line-through', ''))}>
                        <StatusIcon status={s} className="h-2.5 w-2.5" />{c[s]}
                      </span>
                    ))}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
