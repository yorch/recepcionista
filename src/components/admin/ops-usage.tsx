'use client';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Stat } from '@/components/ui/stat';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import type { CapUsage, UsageOverview } from '@/lib/admin/ops-model';
import { BarList, DataTable, OpsPage, Td, useFormat } from './ops-ui';
import { ErrorPanel, LoadingBlock } from './ui';
import { useJson } from './use-json';

export function UsagePage() {
  const t = useT();
  const fmt = useFormat();
  const { data, error, loading, reload } = useJson<UsageOverview>('/api/admin/usage');
  return (
    <OpsPage title={t('ao.usage.title')} subtitle={t('ao.usage.sub')} right={<Button variant="outline" onClick={reload} disabled={loading}>{loading ? t('common.loading') : t('ao.refresh')}</Button>}>
      {loading && !data ? <LoadingBlock /> : error && !data ? <ErrorPanel error={error} onRetry={reload} /> : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('ao.usage.tenants')} value={fmt.n(data.tenants.total)} sub={t('ao.usage.tenantsSub', { suspended: data.tenants.suspended, comped: data.tenants.comped })} />
            <Stat label={t('ao.usage.paying')} value={fmt.n(data.revenue.paying)} sub={t('ao.usage.payingSub', { n: data.revenue.past_due })} />
            <Stat label={t('ao.usage.mrr')} value={data.revenue.mrr_cents === null ? t('ao.usage.mrrUnknown') : fmt.money(data.revenue.mrr_cents, data.revenue.currency)} sub={t('ao.usage.mrrSub')} tone={data.revenue.mrr_cents === null ? 'warn' : undefined} />
            <Stat label={t('ao.usage.trials')} value={fmt.n(data.trials.trialing)} sub={t('ao.usage.trialsSub', { n: data.trials.ending_7d })} tone={data.trials.expired_unconverted > 0 ? 'warn' : undefined} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
            <Card className="flex flex-col gap-3 p-4">
              <h2 className="text-[15px] font-semibold text-white">{t('ao.usage.byStatus')}</h2>
              <BarList label={t('ao.usage.byStatus')} rows={Object.entries(data.tenants.by_status).map(([k, v]) => ({ key: k, label: t(`at.status.${k}` as MessageKey), value: v }))} />
              <h2 className="mt-2 text-[15px] font-semibold text-white">{t('ao.usage.byBilling')}</h2>
              <BarList label={t('ao.usage.byBilling')} rows={Object.entries(data.tenants.by_billing).map(([k, v]) => ({ key: k, label: t(`at.billing.${k}` as MessageKey), value: v }))} />
            </Card>
            <Card className="flex flex-col gap-3 p-4">
              <h2 className="text-[15px] font-semibold text-white">{t('ao.usage.byPlan')}</h2>
              <BarList label={t('ao.usage.byPlan')} rows={data.tenants.by_plan.map((p) => ({ key: p.plan, label: <>{p.plan === 'none' ? t('ao.usage.noPlan') : p.plan}{p.comped ? <> <Badge tone="brand">{t('at.flag.comped')}</Badge></> : null}</>, value: p.count }))} />
            </Card>
          </div>
          <section aria-labelledby="rev-h" className="flex flex-col gap-3">
            <h2 id="rev-h" className="text-[15px] font-semibold text-white">{t('ao.usage.revenue')}</h2>
            <p className="text-[13px] text-mute">{t('ao.usage.revenueNote')}</p>
            {data.revenue.mrr_by_plan.length === 0 ? <p className="text-[13px] text-mute">{t('ao.usage.noPaying')}</p> : (
              <DataTable caption={t('ao.usage.revenue')} min={560} head={[{ label: t('ao.usage.col.plan') }, { label: t('ao.usage.col.paying'), right: true }, { label: t('ao.usage.col.price'), right: true }, { label: t('ao.usage.col.subtotal'), right: true }, { label: t('ao.usage.col.source') }]}>
                {data.revenue.mrr_by_plan.map((r) => (
                  <tr key={r.plan} className="border-b border-line last:border-0">
                    <Td>{r.plan}</Td><Td right>{fmt.n(r.paying)}</Td>
                    <Td right>{r.monthly_cents === null ? t('ao.usage.mrrUnknown') : fmt.money(r.monthly_cents, data.revenue.currency)}</Td>
                    <Td right>{r.subtotal_cents === null ? t('ao.usage.mrrUnknown') : fmt.money(r.subtotal_cents, data.revenue.currency)}</Td>
                    <Td>{t(`ao.usage.src.${r.price_source}` as MessageKey)}</Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>
          <section aria-labelledby="use-h" className="flex flex-col gap-3">
            <h2 id="use-h" className="text-[15px] font-semibold text-white">{t('ao.usage.usageTitle')}</h2>
            <p className="text-[13px] text-mute">{t('ao.usage.usageNote', { period: data.usage.period_start, n: data.usage.businesses_with_usage })}</p>
            <DataTable caption={t('ao.usage.usageTitle')} min={560} head={[{ label: t('ao.usage.col.meter') }, { label: t('ao.usage.col.used'), right: true }, { label: t('ao.usage.col.over80'), right: true }, { label: t('ao.usage.col.over100'), right: true }]}>
              {([['sms', data.usage.sms], ['ai', data.usage.ai_minutes], ['forward', data.usage.forward_minutes], ['voicemail', data.usage.voicemail_minutes]] as [string, CapUsage][]).map(([k, u]) => (
                <tr key={k} className="border-b border-line last:border-0">
                  <Td>{t(`ao.usage.meter.${k}` as MessageKey)}</Td><Td right>{fmt.n(u.used)}</Td><Td right>{fmt.n(u.over_80)}</Td><Td right>{u.over_100 > 0 ? <Badge tone="emergency">{fmt.n(u.over_100)}</Badge> : 0}</Td>
                </tr>
              ))}
            </DataTable>
          </section>
          <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
            <section aria-labelledby="top-h" className="flex flex-col gap-3">
              <h2 id="top-h" className="text-[15px] font-semibold text-white">{t('ao.usage.top')}</h2>
              {data.top_usage.length === 0 ? <p className="text-[13px] text-mute">{t('ao.usage.noUsage')}</p> : (
                <DataTable caption={t('ao.usage.top')} min={420} head={[{ label: t('ao.usage.col.tenant') }, { label: t('ao.usage.meter.sms'), right: true }, { label: t('ao.usage.meter.ai'), right: true }]}>
                  {data.top_usage.map((r) => (
                    <tr key={r.business_id} className="border-b border-line last:border-0">
                      <Td><Link href={`/admin/tenants/${r.business_id}`} className="underline">{r.name}</Link></Td>
                      <Td right>{r.sms} / {r.sms_cap}</Td><Td right>{r.ai_minutes} / {r.ai_cap}</Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </section>
            <section aria-labelledby="trial-h" className="flex flex-col gap-3">
              <h2 id="trial-h" className="text-[15px] font-semibold text-white">{t('ao.usage.trialsEnding')}</h2>
              <p className="text-[13px] text-mute">{t('ao.usage.trialsDetail', { d3: data.trials.ending_3d, d7: data.trials.ending_7d, expired: data.trials.expired_unconverted })}</p>
              {data.trials.upcoming.length === 0 ? <p className="text-[13px] text-mute">{t('ao.usage.noTrials')}</p> : (
                <DataTable caption={t('ao.usage.trialsEnding')} min={420} head={[{ label: t('ao.usage.col.tenant') }, { label: t('ao.usage.col.plan') }, { label: t('ao.usage.col.ends') }]}>
                  {data.trials.upcoming.map((r) => (
                    <tr key={r.business_id} className="border-b border-line last:border-0">
                      <Td><Link href={`/admin/tenants/${r.business_id}`} className="underline">{r.name}</Link></Td><Td>{r.plan ?? '-'}</Td><Td className="whitespace-nowrap">{fmt.when(r.trial_ends_at)}</Td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </section>
          </div>
          <p className="text-xs text-dim">{t('ao.generatedAt', { when: fmt.when(data.generated_at) })}</p>
        </>
      ) : null}
    </OpsPage>
  );
}
