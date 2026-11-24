'use client';
import { StatusIcon } from './status';
import { cn } from '@/components/ui/cn';
import { STATUS_META } from '@/lib/calendar';
import { money, timeET } from '@/lib/format';
import type { DaySegment } from '@/lib/calendar';
import type { Booking } from '@/lib/types';

/** One day's jobs as cards (phones, below md): time, customer, service, status icon + label, price. */
export function DayList({
  items, tz, selectedId, loading, onOpen,
}: {
  items: { booking: Booking; segment: DaySegment }[];
  tz: string;
  selectedId: string | null;
  loading: boolean;
  onOpen: (b: Booking, el: HTMLElement) => void;
}) {
  if (items.length === 0) {
    return <p className="rounded-2xl border border-line bg-panel/80 px-4 py-8 text-center text-[13px] text-dim">{loading ? 'Loading…' : 'Nothing booked this day.'}</p>;
  }
  return (
    <ul aria-busy={loading} className={cn('flex flex-col gap-2.5', loading && 'opacity-70')}>
      {items.map(({ booking: b }) => {
        const meta = STATUS_META[b.status];
        return (
          <li key={b.id}>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label={`${b.customer_name}, ${b.service}, ${timeET(b.scheduled_at, tz)}, ${meta.label}`}
              onClick={(e) => onOpen(b, e.currentTarget)}
              className={cn('flex min-h-14 w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left', meta.tone, selectedId === b.id && 'ring-2 ring-brand-soft')}
            >
              <span className="w-[64px] shrink-0 font-mono text-[13px] font-medium">{timeET(b.scheduled_at, tz)}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[14px] font-semibold"><StatusIcon status={b.status} /><span className="truncate">{b.customer_name}</span></span>
                <span className="block truncate text-xs opacity-90">{b.service}{b.address ? ` · ${b.address}` : ''}</span>
              </span>
              <span className="shrink-0 text-right text-xs">
                <span className="block font-medium">{meta.label}</span>
                <span className="block tabular-nums opacity-90">{money(b.price_estimate)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
