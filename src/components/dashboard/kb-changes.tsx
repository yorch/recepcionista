'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { relative } from '@/lib/format';
import type { Page } from '@/lib/db/paging';
import type { PublicKbChange } from '@/lib/voice/owner/view';

const TONE: Record<PublicKbChange['status'], BadgeTone> = { proposed: 'unsure', applied: 'routine', reverted: 'neutral', rejected: 'neutral' };

/**
 * "Voice changes": what the owner asked the assistant to change by phone or text, and what happened to it. A change from a call stays
 * "waiting for confirmation" until the owner replies YES to the text (or presses Apply here); Undo restores the previous values unless
 * someone edited those fields since.
 */
export function KbChanges({ businessId, initial, nowMs }: { businessId: string; initial: Page<PublicKbChange>; nowMs: number }) {
  const t = useT();
  const locale = useLocale();
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
      toast.success(action === 'apply' ? t('kbc.toastApplied') : action === 'reject' ? t('kbc.toastRejected') : t('kbc.toastUndone'));
      router.refresh();
    } catch (err) {
      toast.error(errorText(t, err));
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
      toast.error(errorText(t, err, 'kbc.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHead title={t('kbc.title')} subtitle={t('kbc.subtitle')} />
      {items.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-dim">{t('kbc.empty')}</p>
      ) : (
        <ul className="divide-y divide-[#171f2a]">
          {items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-[13px] text-white">{c.summary}</p>
                <p className="mt-0.5 text-xs text-dim">
                  {t(`kbc.source.${c.source}` as const)} · <time dateTime={c.created_at}>{relative(c.created_at, nowMs, locale)}</time>
                  {c.touches.length ? ` · ${c.touches.join(', ')}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={TONE[c.status]}>{t(`kbc.status.${c.status}` as const)}</Badge>
                {c.status === 'proposed' ? (
                  <>
                    <Button disabled={busy === c.id} onClick={() => act(c, 'apply')}>{t('kbc.apply')}</Button>
                    <Button variant="outline" disabled={busy === c.id} onClick={() => act(c, 'reject')}>{t('kbc.reject')}</Button>
                  </>
                ) : null}
                {c.status === 'applied' ? <Button variant="outline" disabled={busy === c.id} onClick={() => act(c, 'undo')}>{t('kbc.undo')}</Button> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <div className="border-t border-line px-5 py-3">
          <Button variant="ghost" disabled={loading} onClick={more}>{loading ? t('common.loading') : t('kbc.showOlder')}</Button>
        </div>
      ) : null}
    </Card>
  );
}
