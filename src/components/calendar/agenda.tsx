'use client';
import { useState } from 'react';
import { StatusIcon } from './status';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { STATUS_META } from '@/lib/calendar';
import { dayET, money, timeET } from '@/lib/format';
import { ApiError, apiRequest } from '@/hooks/use-api';
import type { Page } from '@/lib/db/paging';
import type { Booking } from '@/lib/types';

type Direction = 'upcoming' | 'past';

/** The list view ("Agenda"): upcoming jobs soonest first, or past jobs newest first, with cursor "Load more". */
export function Agenda({ businessId, tz, initial }: { businessId: string; tz: string; initial: Page<Booking> }) {
  const [direction, setDirection] = useState<Direction>('upcoming');
  const [state, setState] = useState<Record<Direction, Page<Booking> | null>>({ upcoming: initial, past: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const page = state[direction];

  async function fetchPage(dir: Direction, cursor: string | null) {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ agenda: dir, business_id: businessId, limit: '25' });
      if (cursor) q.set('cursor', cursor);
      const next = await apiRequest<Page<Booking>>(`/api/bookings?${q}`);
      setState((s) => ({ ...s, [dir]: { items: [...(cursor ? s[dir]?.items ?? [] : []), ...next.items], next_cursor: next.next_cursor } }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load bookings.');
    } finally {
      setLoading(false);
    }
  }

  function pick(dir: Direction) {
    setDirection(dir);
    if (!state[dir]) void fetchPage(dir, null);
  }

  return (
    <section aria-label="Agenda">
      <div role="group" aria-label="Which jobs" className="inline-flex overflow-hidden rounded-xl border border-line-3">
        {(['upcoming', 'past'] as const).map((d) => (
          <button key={d} type="button" aria-pressed={direction === d} onClick={() => pick(d)} className={cn('min-h-11 px-4 text-[13px] font-medium capitalize', direction === d ? 'bg-raised text-white' : 'text-mute hover:bg-hover')}>
            {d}
          </button>
        ))}
      </div>

      {error ? <p role="alert" className="mt-4 rounded-2xl border border-danger-line bg-danger-bg px-4 py-3 text-[13px] text-danger">{error}</p> : null}

      <ul aria-busy={loading} className="mt-4 overflow-hidden rounded-2xl border border-line bg-panel/80 divide-y divide-line">
        {(page?.items ?? []).map((b) => {
          const meta = STATUS_META[b.status];
          return (
            <li key={b.id} className="flex items-center gap-3 px-4 py-3.5 sm:gap-4 sm:px-5">
              <div className="w-[92px] shrink-0">
                <p className="text-xs font-medium text-brand-soft">{dayET(b.scheduled_at, tz)}</p>
                <p className="font-mono text-[13px] text-white">{timeET(b.scheduled_at, tz)}</p>
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-white">{b.customer_name}</p>
                <p className="truncate text-xs text-dim">{b.service}{b.address ? ` · ${b.address}` : ''}</p>
              </div>
              <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs', meta.tone.replace('line-through', ''))}>
                <StatusIcon status={b.status} />{meta.label}
              </span>
              <div className="hidden w-20 shrink-0 text-right sm:block">
                <p className="tabular-nums text-[13px] text-soft">{money(b.price_estimate)}</p>
                {b.deposit_amount ? <p className={cn('text-xs', b.deposit_paid ? 'text-mint-text' : 'text-warn')}>{b.deposit_paid ? 'deposit paid' : `deposit ${money(b.deposit_amount)}`}</p> : null}
                {b.dispute_status && b.dispute_status !== 'none' ? <p className={cn('text-xs', b.dispute_status === 'won' ? 'text-mint-text' : 'text-warn')}>{`dispute ${b.dispute_status}`}</p> : null}
              </div>
            </li>
          );
        })}
        {page && page.items.length === 0 && !loading ? (
          <li className="px-5 py-10 text-center text-[13px] text-dim">{direction === 'upcoming' ? 'No upcoming jobs.' : 'No past jobs yet.'}</li>
        ) : null}
        {!page && loading ? <li className="px-5 py-10 text-center text-[13px] text-dim">Loading…</li> : null}
      </ul>

      {page?.next_cursor ? (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" disabled={loading} onClick={() => fetchPage(direction, page.next_cursor)}>{loading ? 'Loading…' : 'Load more'}</Button>
        </div>
      ) : null}
    </section>
  );
}
