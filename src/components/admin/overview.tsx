'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardHead } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import type { ChangeSetView } from '@/lib/admin/settings-store';
import { buildAlerts, summarizeJobs, type ProviderLite, type RunLite, type SystemLite } from '@/lib/admin-ui/overview';
import { useLabelOf } from './change-review';
import { EmptyStateInline } from './empty-inline';
import { useAdmin } from './provider';
import { useJson } from './use-json';
import { ErrorPanel, formatWhen, LoadingBlock } from './ui';

interface Selftest { providers: (ProviderLite & { tested: boolean; note?: string })[]; ready: boolean }
interface RunsPage { items: RunLite[] }
interface HistoryPage { items: ChangeSetView[] }

const PROVIDER_LABEL: Record<string, MessageKey> = {
  twilio: 'ac.provider.twilio', elevenlabs: 'ac.provider.elevenlabs', stripe: 'ac.provider.stripe', llm: 'ac.provider.llm', email: 'ac.provider.email', google: 'ac.provider.google', turnstile: 'ac.provider.turnstile',
};
const ALERT_KEY = {
  provider_not_ready: 'ac.alert.provider_not_ready', job_errors: 'ac.alert.job_errors', settings_drift: 'ac.alert.settings_drift', settings_unhealthy: 'ac.alert.settings_unhealthy',
  canary_failed: 'ac.alert.canary_failed', rows_ignored: 'ac.alert.rows_ignored', needs_reencrypt: 'ac.alert.needs_reencrypt', frozen: 'ac.alert.frozen',
} as const satisfies Record<string, MessageKey>;

/** Overview: provider readiness (from selftest), job health (from job runs), alerts the APIs can really answer, and the recent critical changes. Every block loads and fails on its own. */
export function Overview() {
  const t = useT();
  const { can } = useAdmin();
  const selftest = useJson<Selftest>(can('selftest.read') ? '/api/admin/selftest' : null);
  const runs = useJson<RunsPage>(can('jobs.read') ? '/api/admin/job-runs?limit=100' : null);
  const history = useJson<HistoryPage>(can('settings.read') ? '/api/admin/settings/history?limit=50' : null);
  const system = useJson<SystemLite>(can('system.read') ? '/api/admin/system' : null);
  const ops = useJson<{ summary: { critical: number; warning: number } }>(can('system.read') ? '/api/admin/alerts' : null); // the alerts center (agent D): stuck deletions, SMS failures, integrity, drift
  const [now] = useState(() => Date.now());
  const alerts = buildAlerts({ providers: selftest.data?.providers ?? null, runs: runs.data?.items ?? null, system: system.data, now });
  const jobs = summarizeJobs(runs.data?.items ?? [], now);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('ac.page.overview.title')} subtitle={t('ac.page.overview.sub')} />

      <Card>
        <CardHead title={t('ac.overview.alerts')} subtitle={t('ac.overview.alertsSub')} />
        <div className="p-5">
          {(selftest.loading || runs.loading || system.loading) && alerts.length === 0 ? <LoadingBlock rows={1} /> : alerts.length === 0 ? (
            <p role="status" className="text-[13px] text-mint-text">{t('ac.overview.noAlerts')}</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label={t('ac.overview.alerts')}>
              {alerts.map((a, i) => (
                <li key={`${a.code}-${a.subject}-${i}`} className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Badge tone={a.severity === 'error' ? 'emergency' : 'unsure'}>{t(a.severity === 'error' ? 'ac.alert.error' : 'ac.alert.warn')}</Badge>
                  <span className="text-soft">{t(ALERT_KEY[a.code], { subject: PROVIDER_LABEL[a.subject] ? t(PROVIDER_LABEL[a.subject]) : a.subject, n: a.count ?? 0 })}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-dim">
            {ops.data ? t('ao.overview.summary', { critical: ops.data.summary.critical, warning: ops.data.summary.warning }) : t('ao.overview.summaryNone')}{' '}
            {can('system.read') ? <Link href="/admin/operations/alerts" className="text-soft underline">{t('ao.overview.link')}</Link> : null}
          </p>
        </div>
      </Card>

      <section aria-labelledby="ov-prov">
        <h2 id="ov-prov" className="mb-2 text-sm font-semibold text-white">{t('ac.overview.providers')}</h2>
        {!can('selftest.read') ? null : selftest.loading && !selftest.data ? <LoadingBlock rows={2} /> : selftest.error && !selftest.data ? <ErrorPanel error={selftest.error} onRetry={selftest.reload} /> : (
          <>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(selftest.data?.providers ?? []).map((p) => (
                <li key={p.provider} className="rounded-xl border border-line bg-panel/80 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[14px] font-medium text-white">{PROVIDER_LABEL[p.provider] ? t(PROVIDER_LABEL[p.provider]) : p.provider}</span>
                    <Badge tone={p.ready ? 'routine' : 'unsure'}>{p.ready ? t('ac.overview.ready') : t('ac.overview.notReady')}</Badge>
                  </div>
                  <p className="mt-1.5 text-xs text-dim">{p.ready ? t('ac.overview.configOnly') : t('ac.overview.missing', { n: p.missing.length })}</p>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-dim">{t('ac.overview.providersNote')}</p>
          </>
        )}
      </section>

      <Card>
        <CardHead title={t('ac.overview.jobs')} subtitle={t('ac.overview.jobsSub')} />
        {!can('jobs.read') ? null : runs.loading && !runs.data ? <div className="p-5"><LoadingBlock rows={2} /></div> : runs.error && !runs.data ? <div className="p-5"><ErrorPanel error={runs.error} onRetry={runs.reload} /></div> : jobs.length === 0 ? (
          <div className="p-5"><EmptyStateInline title={t('ac.overview.jobsEmptyTitle')} body={t('ac.overview.jobsEmptyBody')} /></div>
        ) : <JobsTable jobs={jobs} />}
      </Card>

      <Card>
        <CardHead title={t('ac.overview.critical')} subtitle={t('ac.overview.criticalSub')} right={<Link href="/admin/history" className="inline-flex min-h-11 items-center text-[13px] text-brand-soft hover:underline">{t('ac.overview.allHistory')}</Link>} />
        <div className="p-5">
          {history.loading && !history.data ? <LoadingBlock rows={2} /> : history.error && !history.data ? <ErrorPanel error={history.error} onRetry={history.reload} /> : <CriticalList items={(history.data?.items ?? []).filter((c) => c.tier === 'critical').slice(0, 5)} />}
        </div>
      </Card>
    </div>
  );
}

function JobsTable({ jobs }: { jobs: ReturnType<typeof summarizeJobs> }) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-[12.5px]">
        <caption className="sr-only">{t('ac.overview.jobs')}</caption>
        <thead className="text-dim"><tr>
          <th scope="col" className="px-5 py-2 font-medium">{t('ac.overview.colJob')}</th><th scope="col" className="px-3 py-2 font-medium">{t('ac.overview.colLast')}</th>
          <th scope="col" className="px-3 py-2 font-medium">{t('ac.overview.colStatus')}</th><th scope="col" className="px-3 py-2 font-medium">{t('ac.overview.colErrors')}</th>
        </tr></thead>
        <tbody className="divide-y divide-line">
          {jobs.map((j) => (
            <tr key={j.job}>
              <td className="px-5 py-2 font-mono text-soft">{j.job}</td>
              <td className="px-3 py-2 text-mute">{formatWhen(j.last.started_at, locale)}{j.last.dry_run ? ` (${t('ac.overview.dry')})` : ''}</td>
              <td className="px-3 py-2"><Badge tone={j.last.status === 'ok' ? 'routine' : j.last.status === 'error' ? 'emergency' : 'neutral'}>{t(`ac.overview.status.${j.last.status}` as MessageKey)}</Badge></td>
              <td className="px-3 py-2 text-soft">{j.errors24h}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CriticalList({ items }: { items: ChangeSetView[] }) {
  const t = useT();
  const locale = useLocale();
  const labelOf = useLabelOf();
  if (items.length === 0) return <p className="text-[13px] text-mute">{t('ac.overview.criticalNone')}</p>;
  return (
    <ul className="flex flex-col gap-3">
      {items.map((c) => (
        <li key={c.id} className="text-[13px]">
          <p className="text-soft">{c.keys.slice(0, 3).map((k) => labelOf(k)).join(', ')}{c.keys.length > 3 ? ` +${c.keys.length - 3}` : ''}</p>
          <p className="text-xs text-dim">{formatWhen(c.at, locale)}{c.reason ? ` · “${c.reason}”` : ''}</p>
        </li>
      ))}
    </ul>
  );
}
