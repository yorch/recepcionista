'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Stat } from '@/components/ui/stat';
import { apiRequest } from '@/hooks/use-api';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import type { SmsFailureClass, SmsOverview } from '@/lib/admin/ops-model';
import { EmptyStateInline } from './empty-inline';
import { BarList, DataTable, OpsPage, Td, useFormat } from './ops-ui';
import { ErrorPanel, LoadingBlock } from './ui';
import { useJson } from './use-json';

const DAYS = [1, 7, 30, 90] as const;
const CLASS_TONE: Record<SmsFailureClass, 'unsure' | 'emergency' | 'neutral' | 'brand' | 'sky'> = { number: 'unsure', optout: 'neutral', carrier: 'emergency', registration: 'emergency', account: 'emergency', transient: 'sky', unknown: 'neutral' };

export function DeliveriesPage() {
  const t = useT();
  const fmt = useFormat();
  const [days, setDays] = useState<number>(7);
  const [business, setBusiness] = useState('');
  const [code, setCode] = useState('');
  const [applied, setApplied] = useState({ business: '', code: '' });
  const q = (before?: string | null) => {
    const p = new URLSearchParams({ days: String(days), limit: '25' });
    if (applied.business.trim()) p.set('business_id', applied.business.trim());
    if (applied.code.trim()) p.set('code', applied.code.trim());
    if (before) p.set('before', before);
    return `/api/admin/deliveries/sms?${p.toString()}`;
  };
  const { data, error, loading, reload } = useJson<SmsOverview>(q());
  const [more, setMore] = useState<{ items: SmsOverview['recent']['items']; cursor: string | null | undefined; busy: boolean; error: unknown; key: string }>({ items: [], cursor: undefined, busy: false, error: null, key: '' });
  const key = q();
  const extra = more.key === key ? more : { items: [], cursor: undefined, busy: false, error: null, key };
  const cursor = extra.cursor === undefined ? data?.recent.next_cursor ?? null : extra.cursor;
  async function loadMore() {
    setMore({ ...extra, busy: true, error: null, key });
    try { const page = await apiRequest<SmsOverview>(q(cursor)); setMore({ items: [...extra.items, ...page.recent.items], cursor: page.recent.next_cursor, busy: false, error: null, key }); } catch (err) { setMore({ ...extra, busy: false, error: err, key }); }
  }
  const items = [...(data?.recent.items ?? []), ...extra.items];

  return (
    <OpsPage title={t('ao.sms.title')} subtitle={t('ao.sms.sub')} right={<Button variant="outline" onClick={reload} disabled={loading}>{loading ? t('common.loading') : t('ao.refresh')}</Button>}>
      <Card className="p-4">
        <form role="search" aria-label={t('ao.sms.filters')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); setApplied({ business, code }); }}>
          <SelectField label={t('ao.sms.window')} value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map((d) => <option key={d} value={d}>{t('ao.sms.lastDays', { n: d })}</option>)}
          </SelectField>
          <TextField label={t('ao.sms.business')} hint={t('ao.sms.businessHint')} value={business} onChange={(e) => setBusiness(e.target.value)} mono maxLength={64} autoComplete="off" />
          <TextField label={t('ao.sms.code')} hint={t('ao.sms.codeHint')} value={code} onChange={(e) => setCode(e.target.value)} mono maxLength={10} autoComplete="off" />
          <div className="flex items-end gap-2"><Button type="submit">{t('ao.audit.apply')}</Button><Button variant="outline" onClick={() => { setBusiness(''); setCode(''); setApplied({ business: '', code: '' }); }}>{t('ao.audit.reset')}</Button></div>
        </form>
      </Card>
      {loading && !data ? <LoadingBlock /> : error && !data ? <ErrorPanel error={error} onRetry={reload} /> : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('ao.sms.statSent')} value={fmt.n(data.totals.sent)} sub={t('ao.sms.statSentSub')} />
            <Stat label={t('ao.sms.statFailed')} value={fmt.n(data.totals.delivery_failures)} sub={t('ao.sms.statFailedSub')} tone={data.totals.delivery_failures > 0 ? 'warn' : undefined} />
            <Stat label={t('ao.sms.statRate')} value={fmt.pct(data.totals.failure_rate_pct)} sub={t('ao.sms.statRateSub')} />
            <Stat label={t('ao.sms.statSendFail')} value={`${fmt.n(data.totals.send_failures)} / ${fmt.n(data.totals.blocked)}`} sub={t('ao.sms.statSendFailSub')} />
          </div>
          {data.totals.delivery_failures === 0 && items.length === 0 ? <EmptyStateInline title={t('ao.sms.emptyTitle')} body={t('ao.sms.emptyBody')} /> : (
            <>
              <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
                <Card className="flex flex-col gap-3 p-4">
                  <h2 className="text-[15px] font-semibold text-white">{t('ao.sms.byCode')}</h2>
                  <ul className="flex flex-col gap-3">
                    {data.by_code.map((c) => (
                      <li key={c.code ?? 'none'} className="rounded-xl border border-line bg-panel/60 p-3">
                        <p className="flex flex-wrap items-center gap-2 text-sm text-white">
                          <span className="font-mono">{c.code ?? t('ao.sms.noCode')}</span>
                          <Badge tone={CLASS_TONE[c.failure_class]}>{t(`ao.sms.class.${c.failure_class}` as MessageKey)}</Badge>
                          <span className="ml-auto tabular-nums">{fmt.n(c.count)}</span>
                        </p>
                        <p className="mt-1 text-xs text-mute">{t(`ao.sms.guide.${c.failure_class}` as MessageKey)}</p>
                      </li>
                    ))}
                  </ul>
                </Card>
                <div className="flex flex-col gap-4">
                  <Card className="flex flex-col gap-3 p-4">
                    <h2 className="text-[15px] font-semibold text-white">{t('ao.sms.byTenant')}</h2>
                    <BarList label={t('ao.sms.byTenant')} rows={data.by_tenant.map((r) => ({ key: r.business_id ?? 'none', label: r.business_id ? <Link href={`/admin/tenants/${r.business_id}`} className="underline">{r.business_name ?? r.business_id.slice(0, 8)}</Link> : t('ao.sms.noTenant'), value: r.count }))} />
                  </Card>
                  <Card className="flex flex-col gap-3 p-4">
                    <h2 className="text-[15px] font-semibold text-white">{t('ao.sms.byDay')}</h2>
                    <BarList label={t('ao.sms.byDay')} rows={data.by_day.map((r) => ({ key: r.day, label: fmt.day(r.day), value: r.count }))} />
                  </Card>
                </div>
              </div>
              <section aria-labelledby="sms-recent" className="flex flex-col gap-3">
                <h2 id="sms-recent" className="text-[15px] font-semibold text-white">{t('ao.sms.recent')}</h2>
                <DataTable caption={t('ao.sms.recent')} min={720} head={[{ label: t('ao.audit.col.when') }, { label: t('ao.sms.col.business') }, { label: t('ao.sms.col.code') }, { label: t('ao.sms.col.class') }, { label: t('ao.sms.col.status') }, { label: t('ao.sms.col.kind') }]}>
                  {items.map((r) => (
                    <tr key={r.id} className="border-b border-line last:border-0">
                      <Td className="whitespace-nowrap">{fmt.when(r.at)}</Td>
                      <Td>{r.business_id ? <Link href={`/admin/tenants/${r.business_id}`} className="underline">{r.business_name ?? r.business_id.slice(0, 8)}</Link> : '-'}</Td>
                      <Td mono>{r.code ?? '-'}</Td>
                      <Td><Badge tone={CLASS_TONE[r.failure_class]}>{t(`ao.sms.class.${r.failure_class}` as MessageKey)}</Badge></Td>
                      <Td>{r.status}</Td>
                      <Td>{r.kind ?? '-'}</Td>
                    </tr>
                  ))}
                </DataTable>
                {extra.error ? <ErrorPanel error={extra.error} onRetry={() => void loadMore()} /> : null}
                {cursor ? <Button variant="outline" className="self-start" onClick={() => void loadMore()} disabled={extra.busy}>{extra.busy ? t('common.loading') : t('ao.loadMore')}</Button> : null}
              </section>
            </>
          )}
          <Card className="p-4">
            <h2 className="text-[15px] font-semibold text-white">{t('ao.sms.retryTitle')}</h2>
            <p className="mt-1 text-[13px] text-mute">{t('ao.sms.retryBody')}</p>
          </Card>
        </>
      ) : null}
    </OpsPage>
  );
}
