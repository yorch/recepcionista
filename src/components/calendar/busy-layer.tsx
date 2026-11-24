'use client';
import { useEffect, useState } from 'react';
import { apiRequest } from '@/hooks/use-api';
import { dayRange } from '@/lib/time';
import type { Axis } from '@/lib/calendar';
import { partsInTz } from '@/lib/time';

interface Block { starts_at: string; ends_at: string; all_day: boolean }

/** Read-only hatched overlay of the owner's Google Calendar busy time for a set of local days. Times only; nothing is clickable. */
export function useBusyBlocks(days: string[], tz: string): Block[] {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const key = `${days[0]}|${days[days.length - 1]}|${tz}`;
  useEffect(() => {
    if (days.length === 0) return;
    const ctrl = new AbortController();
    const from = dayRange(days[0], tz).gte.toISOString();
    const to = dayRange(days[days.length - 1], tz).lt.toISOString();
    apiRequest<{ blocks: Block[] }>(`/api/integrations/google/busy?${new URLSearchParams({ from, to })}`, { signal: ctrl.signal })
      .then((r) => setBlocks(r.blocks)).catch(() => setBlocks([]));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return blocks;
}

const minutesOfDay = (iso: string, tz: string) => { const p = partsInTz(iso, tz); return p.hour * 60 + p.minute; };

/** Absolutely-positioned stripes inside one day column (the column must be `relative`). */
export function BusyLayer({ blocks, day, tz, axis }: { blocks: Block[]; day: string; tz: string; axis: Axis }) {
  const { gte, lt } = dayRange(day, tz);
  const span = axis.endMin - axis.startMin;
  return (
    <>
      {blocks.filter((b) => new Date(b.ends_at) > gte && new Date(b.starts_at) < lt).map((b, i) => {
        const startMin = new Date(b.starts_at) <= gte ? 0 : minutesOfDay(b.starts_at, tz);
        const endMin = new Date(b.ends_at) >= lt ? 24 * 60 : minutesOfDay(b.ends_at, tz);
        const top = Math.max(0, ((startMin - axis.startMin) / span) * 100);
        const bottom = Math.min(100, ((endMin - axis.startMin) / span) * 100);
        if (bottom <= top) return null;
        return (
          <div
            key={`${b.starts_at}-${i}`} aria-hidden="true" title="Busy on your Google Calendar"
            className="pointer-events-none absolute inset-x-0 z-[1] border-y border-line-3/60"
            style={{ top: `${top}%`, height: `${bottom - top}%`, backgroundImage: 'repeating-linear-gradient(135deg, rgba(139,152,171,.28) 0 4px, transparent 4px 9px)' }}
          />
        );
      })}
    </>
  );
}
