'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import { useJson } from './use-json';
import { ErrorPanel, formatWhen, LoadingBlock } from './ui';

interface Row { id: string; at: string; actor_kind: string; actor_user_id: string | null; action: string; target: string; meta: unknown }
interface Page { items: Row[]; next_cursor: string | null }

const metaText = (m: unknown): string => {
  if (!m || typeof m !== 'object') return '';
  const o = m as Record<string, unknown>;
  const reason = typeof o.reason === 'string' ? o.reason : typeof o.note === 'string' ? o.note : '';
  const rest = Object.entries(o).filter(([k, v]) => k !== 'reason' && k !== 'note' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')).slice(0, 6).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`);
  return [reason, ...rest].filter(Boolean).join(' · ');
};

/** The business's audit trail (newest first, keyset paging through /api/admin/audit?business_id=). */
export function TenantAudit({ businessId }: { businessId: string }) {
  const t = useT();
  const locale = useLocale();
  const base = `/api/admin/audit?business_id=${encodeURIComponent(businessId)}&limit=25`;
  const first = useJson<Page>(base);
  const [more, setMore] = useState<{ items: Row[]; cursor: string | null | undefined; busy: boolean; error: unknown }>({ items: [], cursor: undefined, busy: false, error: null });
  if (first.loading && !first.data) return <LoadingBlock rows={4} />;
  if (first.error && !first.data) return <ErrorPanel error={first.error} onRetry={first.reload} />;
  const items = [...(first.data?.items ?? []), ...more.items];
  const cursor = more.cursor === undefined ? first.data?.next_cursor ?? null : more.cursor;
  async function loadMore() {
    setMore((m) => ({ ...m, busy: true, error: null }));
    try {
      const p = await apiRequest<Page>(`${base}&before=${encodeURIComponent(cursor ?? '')}`);
      setMore((m) => ({ items: [...m.items, ...p.items], cursor: p.next_cursor, busy: false, error: null }));
    } catch (error) { setMore((m) => ({ ...m, busy: false, error })); }
  }
  return (
    <Card>
      <CardHead title={t('at.audit.title')} subtitle={t('at.audit.sub')} />
      <div className="p-5">
        {items.length === 0 ? <p className="text-[13px] text-mute">{t('at.audit.empty')}</p> : (
          <ol className="flex flex-col gap-2">
            {items.map((r) => (
              <li key={r.id} className="rounded-lg border border-line px-3 py-2 text-[13px]">
                <p className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-mono text-xs text-white">{r.action}</span><time dateTime={r.at} className="text-xs text-dim">{formatWhen(r.at, locale)}</time></p>
                <p className="text-xs text-mute">{r.actor_kind}{r.actor_user_id ? ` ${r.actor_user_id.slice(0, 8)}` : ''}{r.target ? ` · ${r.target}` : ''}</p>
                {metaText(r.meta) ? <p className="mt-0.5 break-words text-xs text-soft">{metaText(r.meta)}</p> : null}
              </li>
            ))}
          </ol>
        )}
        {more.error ? <div className="mt-3"><ErrorPanel error={more.error} onRetry={() => void loadMore()} /></div> : null}
        {cursor ? <Button variant="outline" className="mt-3" onClick={() => void loadMore()} disabled={more.busy}>{more.busy ? t('common.loading') : t('at.tenants.loadMore')}</Button> : null}
      </div>
    </Card>
  );
}
