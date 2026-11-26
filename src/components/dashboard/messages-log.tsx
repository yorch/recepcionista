'use client';
import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { whenET } from '@/lib/format';
import type { LogItem } from '@/lib/messaging/inbox-view';
import { statusTone } from '@/components/dashboard/messages-shared';

/** The text log: every text the business sent (with its delivery or block status) and every text it received. Numbers show their last 4 digits only. */
export function MessagesLog({ businessId, tz, initial }: { businessId: string; tz: string; initial: { items: LogItem[]; next_cursor: string | null } }) {
  const t = useT();
  const locale = useLocale();
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [items, setItems] = useState<LogItem[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.next_cursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (dir: 'out' | 'in', after: string | null) => {
    setLoading(true);
    setFailed(false);
    try {
      const q = new URLSearchParams({ direction: dir });
      if (after) q.set('cursor', after);
      const page = await apiRequest<{ items: LogItem[]; next_cursor: string | null }>(`/api/businesses/${businessId}/messages/log?${q}`);
      setItems((prev) => (after ? [...prev, ...page.items] : page.items));
      setCursor(page.next_cursor);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  return (
    <div>
      <div role="group" aria-label={t('msg.log.direction')} className="flex gap-1">
        {(['out', 'in'] as const).map((d) => (
          <button key={d} type="button" aria-pressed={direction === d} onClick={() => { if (d === direction) return; setItems([]); setCursor(null); setDirection(d); void load(d, null); }}
            className={`inline-flex min-h-11 items-center rounded-xl px-3 text-[13px] font-medium ${direction === d ? 'bg-raised text-white' : 'text-mute hover:bg-hover hover:text-soft'}`}>
            {t(d === 'out' ? 'msg.log.out' : 'msg.log.in')}
          </button>
        ))}
      </div>
      {items.length === 0 && !loading && !failed ? <Card className="mt-3 px-5 py-8 text-center text-[13px] text-mute">{t('msg.log.empty')}</Card> : (
        <ul className="mt-3 flex flex-col gap-2" aria-live="polite">
          {items.map((m) => (
            <li key={m.id}>
              <Card className="p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs text-dim">{t('msg.log.who', { last4: m.who_last4 })}{m.kind ? ` · ${t(`msg.log.kind.${m.kind}` as MessageKey)}` : ''}</span>
                  <Badge tone={statusTone(m.status)}>{t((m.direction === 'in' ? `msg.status.${m.status}` : `msg.log.status.${m.status}`) as MessageKey)}</Badge>
                </div>
                <p className="mt-1.5 break-words whitespace-pre-wrap text-[13px] text-body">{m.body}</p>
                <p className="mt-1 text-xs text-dim">{whenET(m.at, tz, locale)}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {failed ? <p role="alert" className="mt-2 text-xs text-danger">{t('msg.loadFailed')}</p> : null}
      {cursor ? <div className="mt-3"><Button variant="outline" disabled={loading} onClick={() => void load(direction, cursor)}>{loading ? t('msg.loading') : t('msg.loadMore')}</Button></div> : null}
    </div>
  );
}
