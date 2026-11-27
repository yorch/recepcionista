'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import type { HealthOutcome, HealthOverview, ProviderHealth } from '@/lib/admin/ops-model';
import { DataTable, OpsPage, Td, useFormat } from './ops-ui';
import { opsErrorText } from './ops-errors';
import { useAdmin } from './provider';
import { ErrorPanel, LoadingBlock } from './ui';
import { useJson } from './use-json';

const DAYS = [1, 7, 14, 30, 90] as const;
const TONE: Record<HealthOutcome, 'routine' | 'emergency' | 'unsure'> = { ok: 'routine', auth_failed: 'emergency', unreachable: 'unsure', misconfigured: 'unsure' };

export function HealthPage() {
  const t = useT();
  const { can } = useAdmin();
  const [days, setDays] = useState<number>(14);
  const { data, error, loading, reload } = useJson<HealthOverview>(`/api/admin/provider-health?days=${days}`);
  const [busy, setBusy] = useState(false);

  async function checkNow() {
    setBusy(true);
    try { await apiRequest('/api/admin/selftest?live=1&force=1', { timeoutMs: 60_000 }); toast.success(t('ao.health.checked')); reload(); } catch (err) { toast.error(opsErrorText(t, err)); } finally { setBusy(false); }
  }
  const right = (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={reload} disabled={loading}>{loading ? t('common.loading') : t('ao.refresh')}</Button>
      {can('providers.repair') ? <Button onClick={() => void checkNow()} disabled={busy}>{busy ? t('common.loading') : t('ao.health.checkNow')}</Button> : null}
    </div>
  );
  return (
    <OpsPage title={t('ao.health.title')} subtitle={t('ao.health.sub')} right={right}>
      <div className="max-w-xs"><SelectField label={t('ao.health.window')} value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>{DAYS.map((d) => <option key={d} value={d}>{t('ao.sms.lastDays', { n: d })}</option>)}</SelectField></div>
      <p className="text-[13px] text-mute">{t('ao.health.how')}</p>
      {loading && !data ? <LoadingBlock /> : error && !data ? <ErrorPanel error={error} onRetry={reload} /> : data ? (
        <ul className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0" aria-label={t('ao.health.title')}>
          {data.providers.map((p) => <ProviderCard key={p.provider} p={p} />)}
        </ul>
      ) : null}
    </OpsPage>
  );
}

function ProviderCard({ p }: { p: ProviderHealth }) {
  const t = useT();
  const fmt = useFormat();
  return (
    <li>
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-white">{t(`ao.provider.${p.provider}` as MessageKey)}</h2>
          {p.current ? <Badge tone={TONE[p.current.outcome]}>{t(`ao.health.outcome.${p.current.outcome}` as MessageKey)}</Badge> : <Badge>{t('ao.health.noData')}</Badge>}
        </div>
        {p.checks === 0 ? <p className="text-[13px] text-mute">{t('ao.health.noneYet')}</p> : (
          <>
            <dl className="grid grid-cols-3 gap-2 text-[13px]">
              <div><dt className="text-xs text-dim">{t('ao.health.okPct')}</dt><dd className="text-lg font-semibold tabular-nums text-white">{fmt.pct(p.ok_pct)}</dd></div>
              <div><dt className="text-xs text-dim">{t('ao.health.checks')}</dt><dd className="text-lg font-semibold tabular-nums text-white">{p.checks}</dd></div>
              <div><dt className="text-xs text-dim">{t('ao.health.latency')}</dt><dd className="text-lg font-semibold tabular-nums text-white">{p.current?.ms === null || p.current?.ms === undefined ? '-' : t('ao.history.ms', { n: p.current.ms })}</dd></div>
            </dl>
            <p className="text-xs text-dim">{t('ao.health.lastOk', { when: p.last_ok_at ? fmt.when(p.last_ok_at) : t('ao.jobs.never') })} · {t('ao.health.lastBad', { when: p.last_failure_at ? fmt.when(p.last_failure_at) : t('ao.jobs.never') })}</p>
            <DataTable caption={t('ao.health.historyOf', { provider: t(`ao.provider.${p.provider}` as MessageKey) })} min={420} head={[{ label: t('ao.audit.col.when') }, { label: t('ao.health.col.outcome') }, { label: t('ao.health.latency'), right: true }]}>
              {p.history.slice(0, 10).map((h) => (
                <tr key={h.at} className="border-b border-line last:border-0">
                  <Td className="whitespace-nowrap">{fmt.when(h.at)}</Td>
                  <Td><Badge tone={TONE[h.outcome]}>{t(`ao.health.outcome.${h.outcome}` as MessageKey)}</Badge>{h.checks ? <span className="ml-2 text-xs text-dim">{Object.entries(h.checks).map(([k, v]) => `${k}: ${v}`).join(', ')}</span> : null}</Td>
                  <Td right>{h.ms === null ? '-' : t('ao.history.ms', { n: h.ms })}</Td>
                </tr>
              ))}
            </DataTable>
          </>
        )}
      </Card>
    </li>
  );
}
