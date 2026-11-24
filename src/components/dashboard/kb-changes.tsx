'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { relative } from '@/lib/format';
import type { Page } from '@/lib/db/paging';
import type { PublicKbChange } from '@/lib/voice/owner/view';

const TONE: Record<PublicKbChange['status'], BadgeTone> = { proposed: 'unsure', applied: 'routine', reverted: 'neutral', rejected: 'neutral' };
const LABEL: Record<PublicKbChange['status'], string> = { proposed: 'waiting for confirmation', applied: 'applied', reverted: 'undone', rejected: 'cancelled' };
const WHO: Record<PublicKbChange['source'], string> = { owner_voice: 'phone call', owner_sms: 'text message', dashboard: 'dashboard' };

/**
 * "Voice changes": what the owner asked the assistant to change by phone or text, and what happened to it. A change from a call stays
 * "waiting for confirmation" until the owner replies YES to the text (or presses Apply here); Undo restores the previous values unless
 * someone edited those fields since.
 */
export function KbChanges({ businessId, initial, nowMs }: { businessId: string; initial: Page<PublicKbChange>; nowMs: number }) {
  const router = useRouter();
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.next_cursor);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function act(c: PublicKbChange, action: 'apply' | 'reject' | 'undo') {
    setBusy(c.id);
    try {
      const next = await apiRequest<PublicKbChange>(`/api/businesses/${encodeURIComponent(businessId)}/kb-changes/${encodeURIComponent(c.id)}`, { method: 'POST', body: { action } });
      setItems((cur) => cur.map((x) => (x.id === next.id ? next : x)));
      toast.success(action === 'apply' ? 'Applied. She knows it on the next call.' : action === 'reject' ? 'Cancelled.' : 'Undone.');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function more() {
    if (!cursor) return;
    setLoading(true);
    try {
      const q = new URLSearchParams({ cursor, limit: '25' });
      const page = await apiRequest<Page<PublicKbChange>>(`/api/businesses/${encodeURIComponent(businessId)}/kb-changes?${q}`);
      setItems((cur) => [...cur, ...page.items.filter((p) => !cur.some((x) => x.id === p.id))]);
      setCursor(page.next_cursor);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load more.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHead title="Voice changes" subtitle="Changes asked for by phone or text. Nothing from a call goes live until you confirm it." />
      {items.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-dim">No changes yet. Call your business line from your verified phone and say what to update.</p>
      ) : (
        <ul className="divide-y divide-[#171f2a]">
          {items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-[13px] text-white">{c.summary}</p>
                <p className="mt-0.5 text-xs text-dim">
                  {WHO[c.source]} · <time dateTime={c.created_at}>{relative(c.created_at, nowMs)}</time>
                  {c.touches.length ? ` · ${c.touches.join(', ')}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={TONE[c.status]}>{LABEL[c.status]}</Badge>
                {c.status === 'proposed' ? (
                  <>
                    <Button disabled={busy === c.id} onClick={() => act(c, 'apply')}>Apply</Button>
                    <Button variant="outline" disabled={busy === c.id} onClick={() => act(c, 'reject')}>Reject</Button>
                  </>
                ) : null}
                {c.status === 'applied' ? <Button variant="outline" disabled={busy === c.id} onClick={() => act(c, 'undo')}>Undo</Button> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <div className="border-t border-line px-5 py-3">
          <Button variant="ghost" disabled={loading} onClick={more}>{loading ? 'Loading…' : 'Show older'}</Button>
        </div>
      ) : null}
    </Card>
  );
}
