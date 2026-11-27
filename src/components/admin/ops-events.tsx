'use client';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { Stat } from '@/components/ui/stat';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { STUCK_CLAIM_MINUTES, type EventOverview } from '@/lib/admin/ops-model';
import { EmptyStateInline } from './empty-inline';
import { DataTable, OpsPage, Td, useFormat } from './ops-ui';
import { ErrorPanel, LoadingBlock } from './ui';
import { useJson } from './use-json';

const HOURS = [1, 24, 72, 168] as const;

export function EventsPage() {
  const t = useT();
  const fmt = useFormat();
  const [hours, setHours] = useState<number>(24);
  const { data, error, loading, reload } = useJson<EventOverview>(`/api/admin/deliveries/events?hours=${hours}`);
  return (
    <OpsPage title={t('ao.events.title')} subtitle={t('ao.events.sub')} right={<Button variant="outline" onClick={reload} disabled={loading}>{loading ? t('common.loading') : t('ao.refresh')}</Button>}>
      <div className="max-w-xs"><SelectField label={t('ao.events.window')} value={String(hours)} onChange={(e) => setHours(Number(e.target.value))}>{HOURS.map((h) => <option key={h} value={h}>{t('ao.events.lastHours', { n: h })}</option>)}</SelectField></div>
      {loading && !data ? <LoadingBlock /> : error && !data ? <ErrorPanel error={error} onRetry={reload} /> : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('ao.events.statTotal')} value={fmt.n(data.totals.total)} sub={t('ao.events.statTotalSub', { n: hours })} />
            <Stat label={t('ao.events.statDone')} value={fmt.n(data.totals.done)} sub={t('ao.events.statDoneSub')} />
            <Stat label={t('ao.events.statProcessing')} value={fmt.n(data.totals.processing)} sub={t('ao.events.statProcessingSub')} />
            <Stat label={t('ao.events.statStuck')} value={fmt.n(data.totals.stuck)} sub={t('ao.events.statStuckSub', { n: STUCK_CLAIM_MINUTES })} tone={data.totals.stuck > 0 ? 'warn' : undefined} />
          </div>
          {data.sources.length === 0 ? <EmptyStateInline title={t('ao.events.emptyTitle')} body={t('ao.events.emptyBody')} /> : (
            <DataTable caption={t('ao.events.bySource')} min={760} head={[{ label: t('ao.events.col.source') }, { label: t('ao.events.col.kind') }, { label: t('ao.events.col.total'), right: true }, { label: t('ao.events.col.done'), right: true }, { label: t('ao.events.col.processing'), right: true }, { label: t('ao.events.col.stuck'), right: true }, { label: t('ao.events.col.last') }]}>
              {data.sources.map((s) => (
                <tr key={s.source} className="border-b border-line last:border-0">
                  <Td mono>{s.source}</Td>
                  <Td><Badge tone={s.kind === 'webhook' ? 'brand' : 'neutral'}>{t(`ao.events.kind.${s.kind}` as MessageKey)}</Badge></Td>
                  <Td right>{fmt.n(s.total)}</Td><Td right>{fmt.n(s.done)}</Td><Td right>{fmt.n(s.processing)}</Td>
                  <Td right>{s.stuck > 0 ? <Badge tone="emergency">{fmt.n(s.stuck)}</Badge> : 0}</Td>
                  <Td className="whitespace-nowrap">{fmt.when(s.last_at)}</Td>
                </tr>
              ))}
            </DataTable>
          )}
          <section aria-labelledby="stuck-h" className="flex flex-col gap-3">
            <h2 id="stuck-h" className="text-[15px] font-semibold text-white">{t('ao.events.stuckTitle')}</h2>
            <p className="text-[13px] text-mute">{t('ao.events.stuckHelp', { n: STUCK_CLAIM_MINUTES })}</p>
            {data.stuck.length === 0 ? <p className="text-[13px] text-mint-text">{t('ao.events.noStuck')}</p> : (
              <DataTable caption={t('ao.events.stuckTitle')} min={560} head={[{ label: t('ao.events.col.source') }, { label: t('ao.events.col.id') }, { label: t('ao.events.col.claimed') }, { label: t('ao.events.col.age'), right: true }]}>
                {data.stuck.map((r) => (
                  <tr key={`${r.source}-${r.id}`} className="border-b border-line last:border-0">
                    <Td mono>{r.source}</Td><Td mono className="break-all">{r.id}</Td><Td className="whitespace-nowrap">{fmt.when(r.claimed_at)}</Td><Td right>{t('ao.events.minutes', { n: r.age_minutes })}</Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>
          <Card className="p-4"><p className="text-[13px] text-mute">{t('ao.events.retention', { n: data.retention_days })}</p></Card>
        </>
      ) : null}
    </OpsPage>
  );
}
