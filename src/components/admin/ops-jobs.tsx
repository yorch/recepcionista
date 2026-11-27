'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Stat } from '@/components/ui/stat';
import { apiRequest } from '@/hooks/use-api';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import {
  CRITICAL_OPS_JOBS, JOB_CONTROL, OPS_JOB_NAMES, PER_BUSINESS_JOBS, type JobReportView, type JobsData, type JobStatusView, type OpsJobName, type StoredReport,
} from '@/lib/admin/ops-model';
import type { JobRunView } from '@/lib/admin/job-runs';
import { EmptyStateInline } from './empty-inline';
import { DataTable, OpsPage, Td, useFormat, usePoll } from './ops-ui';
import { opsErrorText } from './ops-errors';
import { useAdmin } from './provider';
import { ConfirmFields, confirmReady, ErrorPanel, LoadingBlock } from './ui';
import { useJson } from './use-json';

const jobLabel = (t: ReturnType<typeof useT>, name: string) => (OPS_JOB_NAMES as readonly string[]).includes(name) ? t(`ao.job.${name}.name` as MessageKey) : name;

export function JobsPage() {
  const t = useT();
  const fmt = useFormat();
  const { data, error, loading, reload } = useJson<JobsData>('/api/admin/jobs');
  const [selected, setSelected] = useState<OpsJobName | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  usePoll(reload, 60_000);
  const refresh = () => { reload(); setHistoryTick((n) => n + 1); };

  return (
    <OpsPage title={t('ao.jobs.title')} subtitle={t('ao.jobs.sub')} right={<Button variant="outline" onClick={refresh} disabled={loading}>{loading ? t('common.loading') : t('ao.refresh')}</Button>}>
      {loading && !data ? <LoadingBlock /> : error && !data ? <ErrorPanel error={error} onRetry={reload} /> : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('ao.jobs.runner')} value={data.runner.jobs_setting === 'on' ? t('ao.jobs.runnerOn') : t('ao.jobs.runnerOff')} sub={data.runner.explicit ? t('ao.jobs.runnerSetExplicit') : t('ao.jobs.runnerSetDefault')} tone={data.runner.jobs_setting === 'off' ? 'warn' : undefined} />
            <Stat label={t('ao.jobs.tick')} value={t('ao.jobs.seconds', { n: data.runner.tick_seconds })} sub={t('ao.jobs.tickSub')} />
            <Stat label={t('ao.jobs.enabled')} value={fmt.n(data.runner.enabled_jobs.length)} sub={t('ao.jobs.enabledSub', { n: data.jobs.length })} />
            <Stat label={t('ao.jobs.deletionQueue')} value={fmt.n(data.diagnostics.recording_deletions.pending)} sub={t('ao.jobs.deletionStuck', { n: data.diagnostics.recording_deletions.stuck })} tone={data.diagnostics.recording_deletions.stuck > 0 ? 'warn' : undefined} />
          </div>
          <p className="text-[13px] text-mute">
            {t('ao.jobs.settingsHint')}{' '}
            <Link href="/admin/settings/jobs" className="text-soft underline">{t('ao.jobs.settingsLink')}</Link>
          </p>
          <JobsTable jobs={data.jobs} data={data} selected={selected} onSelect={setSelected} />
          {selected ? <RunPanel key={selected} job={selected} data={data} onClose={() => setSelected(null)} onRan={refresh} /> : null}
          <Reports data={data} />
          <History key={historyTick} />
        </>
      ) : null}
    </OpsPage>
  );
}

function stateOf(t: ReturnType<typeof useT>, j: JobStatusView, data: JobsData): { label: string; tone: 'routine' | 'unsure' | 'neutral' | 'emergency' | 'brand' } {
  if (j.name === 'grandfather') return { label: t('ao.jobs.state.manual'), tone: 'neutral' };
  if (j.name === 'tenant_release') {
    const s = data.diagnostics.tenant_release.setting;
    return s === 'on' ? { label: t('ao.jobs.state.acting'), tone: 'emergency' } : s === 'report' ? { label: t('ao.jobs.state.report'), tone: 'brand' } : { label: t('ao.jobs.state.manual'), tone: 'neutral' };
  }
  if (j.enabled) return { label: t('ao.jobs.state.running'), tone: 'routine' };
  if (j.name === 'retention') return { label: t('ao.jobs.state.off'), tone: 'neutral' };
  return { label: data.runner.jobs_setting === 'off' ? t('ao.jobs.state.paused') : t('ao.jobs.state.off'), tone: 'unsure' };
}

function JobsTable({ jobs, data, selected, onSelect }: { jobs: JobStatusView[]; data: JobsData; selected: OpsJobName | null; onSelect: (j: OpsJobName | null) => void }) {
  const t = useT();
  const fmt = useFormat();
  const { can } = useAdmin();
  return (
    <DataTable
      caption={t('ao.jobs.tableCaption')} min={900}
      head={[{ label: t('ao.jobs.col.job') }, { label: t('ao.jobs.col.state') }, { label: t('ao.jobs.col.schedule') }, { label: t('ao.jobs.col.lastRun') }, { label: t('ao.jobs.col.next') }, { label: t('ao.jobs.col.control') }, { label: t('ao.jobs.col.actions') }]}
    >
      {jobs.map((j) => {
        const st = stateOf(t, j, data);
        const control = JOB_CONTROL[j.name];
        return (
          <tr key={j.name} className="border-b border-line last:border-0">
            <th scope="row" className="px-4 py-2.5 text-left align-top font-medium text-white">
              {jobLabel(t, j.name)}
              <span className="mt-0.5 block text-xs font-normal text-dim">{t(`ao.job.${j.name}.desc` as MessageKey)}</span>
            </th>
            <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
            <Td>{t(`ao.job.${j.name}.schedule` as MessageKey)}</Td>
            <Td>{j.last_run_at ? fmt.when(j.last_run_at) : <span className="text-dim">{t('ao.jobs.never')}</span>}</Td>
            <Td>{j.next_due_at ? fmt.when(j.next_due_at) : <span className="text-dim">-</span>}</Td>
            <Td>{control ? <Link href={control.page} className="font-mono text-xs text-soft underline">{control.key}</Link> : <span className="text-dim">{t('ao.jobs.noControl')}</span>}</Td>
            <Td>
              {can('jobs.run') ? (
                <Button variant={selected === j.name ? 'primary' : 'outline'} className="min-h-11" aria-expanded={selected === j.name} onClick={() => onSelect(selected === j.name ? null : j.name)}>
                  {t('ao.jobs.runNow')}<span className="sr-only"> {jobLabel(t, j.name)}</span>
                </Button>
              ) : <span className="text-xs text-dim">{t('ao.noPermission')}</span>}
            </Td>
          </tr>
        );
      })}
    </DataTable>
  );
}

/** Counts as chips, then the item table (outcome per business). Used for a preview, a real run and the stored reports. */
export function ReportTables({ counts, items, total, caption }: { counts?: Record<string, number>; items: { business_id: string | null; outcome: string; detail?: string }[]; total?: number; caption: string }) {
  const t = useT();
  const entries = Object.entries(counts ?? {}).filter(([, v]) => typeof v === 'number');
  return (
    <div className="flex flex-col gap-3">
      {entries.length ? (
        <dl aria-label={t('ao.report.counts')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {entries.map(([k, v]) => (
            <div key={k} className="rounded-xl border border-line bg-panel/60 px-3 py-2">
              <dt className="text-[11px] uppercase tracking-wider text-dim">{k.replace(/_/g, ' ')}</dt>
              <dd className="text-lg font-semibold tabular-nums text-white">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {items.length ? (
        <>
          <DataTable caption={caption} min={480} head={[{ label: t('ao.report.business') }, { label: t('ao.report.outcome') }, { label: t('ao.report.detail') }]}>
            {items.map((i, n) => (
              <tr key={`${i.business_id}-${n}`} className="border-b border-line last:border-0">
                <Td mono>{i.business_id ? <Link href={`/admin/tenants/${i.business_id}`} className="underline">{i.business_id.slice(0, 8)}</Link> : <span className="text-dim">-</span>}</Td>
                <Td><Badge tone={/error|needs_operator|refused/.test(i.outcome) ? 'emergency' : /^(released|notified|comped)$/.test(i.outcome) ? 'routine' : 'neutral'}>{i.outcome.replace(/_/g, ' ')}</Badge></Td>
                <Td className="break-words">{i.detail ?? ''}</Td>
              </tr>
            ))}
          </DataTable>
          {total !== undefined && total > items.length ? <p className="text-xs text-dim">{t('ao.report.truncated', { shown: items.length, total })}</p> : null}
        </>
      ) : <p className="text-[13px] text-mute">{t('ao.report.noItems')}</p>}
    </div>
  );
}

const detailText = (d?: Record<string, unknown>): string => (d ? Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ').slice(0, 200) : '');

function RunPanel({ job, data, onClose, onRan }: { job: OpsJobName; data: JobsData; onClose: () => void; onRan: () => void }) {
  const t = useT();
  const { guard } = useAdmin();
  const critical = (CRITICAL_OPS_JOBS as readonly string[]).includes(job);
  const perBusiness = (PER_BUSINESS_JOBS as readonly string[]).includes(job);
  const [businessId, setBusinessId] = useState('');
  const [before, setBefore] = useState('');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{ sig: string; report: JobReportView } | null>(null);
  const [result, setResult] = useState<JobReportView | null>(null);
  const release = data.diagnostics.tenant_release.setting;
  const needsOn = job === 'tenant_release' || job === 'grandfather';
  const blockedByMode = needsOn && release !== 'on';
  const phrase = critical ? `run ${job}` : null;
  const params = useMemo(() => ({ job, ...(perBusiness && businessId.trim() ? { business_id: businessId.trim() } : {}), ...(job === 'grandfather' && before ? { before: new Date(before).toISOString() } : {}) }), [job, perBusiness, businessId, before]);
  const sig = JSON.stringify(params);
  const grandfatherMissing = job === 'grandfather' && !before;
  const previewed = preview?.sig === sig ? preview.report : null;

  async function runPreview() {
    setBusy('preview'); setError(null); setResult(null);
    try { setPreview({ sig, report: await apiRequest<JobReportView>('/api/admin/jobs/run', { method: 'POST', body: { ...params, dry_run: true } }) }); onRan(); } catch (err) { setError(err); } finally { setBusy(null); }
  }
  async function apply(e: React.FormEvent) {
    e.preventDefault();
    if (!previewed) return;
    setBusy('apply'); setError(null);
    try {
      await guard(async () => { setResult(await apiRequest<JobReportView>('/api/admin/jobs/run', { method: 'POST', body: { ...params, dry_run: false, ...(reason.trim() ? { reason: reason.trim() } : {}) } })); });
      toast.success(t('ao.jobs.applied')); setPreview(null); setReason(''); setTyped(''); onRan();
    } catch (err) { setError(err); } finally { setBusy(null); }
  }

  const rows = (r: JobReportView) => r.items.slice(0, 100).map((i) => ({ business_id: i.business_id ?? null, outcome: i.outcome, detail: detailText(i.detail) }));
  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-5" aria-label={t('ao.jobs.runTitle', { job: jobLabel(t, job) })} role="region">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-[16px] font-semibold text-white">{t('ao.jobs.runTitle', { job: jobLabel(t, job) })}</h2>
          <p className="mt-1 max-w-2xl text-[13px] text-mute">{t('ao.jobs.runHelp')}</p>
        </div>
        <Button variant="ghost" onClick={onClose}>{t('ao.close')}</Button>
      </div>
      {perBusiness || job === 'grandfather' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {perBusiness ? <TextField label={t('ao.jobs.businessId')} hint={t('ao.jobs.businessIdHint')} optional value={businessId} onChange={(e) => setBusinessId(e.target.value)} mono maxLength={64} /> : null}
          {job === 'grandfather' ? <TextField label={t('ao.jobs.cutoff')} hint={t('ao.jobs.cutoffHint')} type="datetime-local" value={before} onChange={(e) => setBefore(e.target.value)} required aria-required="true" /> : null}
        </div>
      ) : null}
      {needsOn ? <p role="note" className="rounded-xl border border-warn-line bg-warn-bg/40 px-3 py-2 text-[13px] text-warn">{release === 'on' ? t('ao.jobs.releaseActing') : t('ao.jobs.releaseNotOn', { mode: release })}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void runPreview()} disabled={busy !== null || grandfatherMissing}>{busy === 'preview' ? t('common.loading') : previewed ? t('ao.jobs.previewAgain') : t('ao.jobs.preview')}</Button>
        <span className="text-xs text-dim">{t('ao.jobs.previewNote')}</span>
      </div>
      {error ? <p role="alert" className="rounded-xl border border-danger-line bg-danger-bg/40 px-3 py-2 text-[13px] text-danger">{opsErrorText(t, error)}</p> : null}
      {previewed ? (
        <section aria-label={t('ao.jobs.previewResult')} className="flex flex-col gap-3 rounded-xl border border-line-3 bg-sunken/60 p-4">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-white">{t('ao.jobs.previewResult')} <Badge tone="sky">{t('ao.jobs.dryRun')}</Badge>{previewed.errors > 0 ? <Badge tone="emergency">{t('ao.jobs.errorsN', { n: previewed.errors })}</Badge> : null}</p>
          <ReportTables counts={previewed.counts} items={rows(previewed)} total={previewed.items.length} caption={t('ao.jobs.previewResult')} />
          <form onSubmit={apply} aria-label={t('ao.jobs.applyTitle')} className="flex flex-col gap-3 border-t border-line pt-3">
            <p className="text-sm font-semibold text-white">{t('ao.jobs.applyTitle')}</p>
            <p className="text-[13px] text-mute">{critical ? t('ao.jobs.applyCritical') : t('ao.jobs.applyNormal')}</p>
            {critical ? <ConfirmFields reasonRequired phrase={phrase} reason={reason} onReason={setReason} typed={typed} onTyped={setTyped} /> : null}
            <div>
              <Button type="submit" variant={critical ? 'danger' : 'primary'} disabled={busy !== null || blockedByMode || !confirmReady({ reasonRequired: critical, reason, phrase, typed })}>{busy === 'apply' ? t('common.loading') : t('ao.jobs.apply')}</Button>
              {blockedByMode ? <p className="mt-2 text-xs text-warn">{t('ao.jobs.applyBlockedMode')}</p> : null}
            </div>
          </form>
        </section>
      ) : null}
      {result ? (
        <section aria-label={t('ao.jobs.runResult')} className="flex flex-col gap-3 rounded-xl border border-mint-line bg-mint-bg/20 p-4">
          <p className="text-sm font-semibold text-white">{t('ao.jobs.runResult')} <Badge tone={result.dry_run ? 'sky' : 'routine'}>{result.dry_run ? t('ao.jobs.dryRun') : t('ao.jobs.real')}</Badge></p>
          {result.dry_run ? <p className="text-[13px] text-warn">{t('ao.jobs.ranAsDry')}</p> : null}
          <ReportTables counts={{ processed: result.processed, errors: result.errors, ...(result.counts ?? {}) }} items={rows(result)} total={result.items.length} caption={t('ao.jobs.runResult')} />
        </section>
      ) : null}
    </Card>
  );
}

function Reports({ data }: { data: JobsData }) {
  const t = useT();
  const fmt = useFormat();
  const d = data.diagnostics.tenant_release;
  const block = (title: string, r: { at: string; meta: StoredReport } | null, emptyKey: MessageKey) => (
    <Card className="flex flex-col gap-3 p-4" role="region" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-white">{title}</h3>
        {r ? <span className="text-xs text-dim">{fmt.when(r.at)} <Badge tone={r.meta.dry_run === false ? 'emergency' : 'sky'}>{r.meta.dry_run === false ? t('ao.jobs.real') : t('ao.jobs.dryRun')}</Badge></span> : null}
      </div>
      {r ? <ReportTables counts={r.meta.counts} items={(r.meta.items ?? []).map(([id, outcome]) => ({ business_id: id, outcome }))} total={r.meta.items_total} caption={title} /> : <p className="text-[13px] text-mute">{t(emptyKey)}</p>}
    </Card>
  );
  return (
    <section aria-labelledby="reports-h" className="flex flex-col gap-3">
      <h2 id="reports-h" className="text-[16px] font-semibold text-white">{t('ao.reports.title')}</h2>
      <p className="text-[13px] text-mute">{t('ao.reports.sub', { mode: d.setting })}</p>
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        {block(t('ao.reports.release'), d.last_report, 'ao.reports.noRelease')}
        {block(t('ao.reports.grandfather'), d.last_grandfather_report, 'ao.reports.noGrandfather')}
      </div>
    </section>
  );
}

const STATUSES = ['ok', 'error', 'skipped'] as const;
const TRIGGERS = ['schedule', 'manual', 'api'] as const;

function History() {
  const t = useT();
  const fmt = useFormat();
  const [f, setF] = useState({ job: '', status: '', trigger: '', dry: '' });
  const [more, setMore] = useState<{ items: JobRunView[]; cursor: string | null | undefined; busy: boolean; error: unknown }>({ items: [], cursor: undefined, busy: false, error: null });
  const url = (before?: string | null) => {
    const p = new URLSearchParams({ limit: '25' });
    if (f.job) p.set('job', f.job);
    if (f.status) p.set('status', f.status);
    if (f.trigger) p.set('trigger', f.trigger);
    if (f.dry) p.set('dry_run', f.dry);
    if (before) p.set('before', before);
    return `/api/admin/job-runs?${p.toString()}`;
  };
  const first = useJson<{ items: JobRunView[]; next_cursor: string | null }>(url());
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setMore({ items: [], cursor: undefined, busy: false, error: null }); };
  const items = [...(first.data?.items ?? []), ...more.items];
  const cursor = more.cursor === undefined ? first.data?.next_cursor ?? null : more.cursor;
  async function loadMore() {
    setMore((m) => ({ ...m, busy: true, error: null }));
    try { const page = await apiRequest<{ items: JobRunView[]; next_cursor: string | null }>(url(cursor)); setMore((m) => ({ items: [...m.items, ...page.items], cursor: page.next_cursor, busy: false, error: null })); } catch (error) { setMore((m) => ({ ...m, busy: false, error })); }
  }
  return (
    <section aria-labelledby="history-h" className="flex flex-col gap-3">
      <h2 id="history-h" className="text-[16px] font-semibold text-white">{t('ao.history.title')}</h2>
      <p className="text-[13px] text-mute">{t('ao.history.sub')}</p>
      <form role="search" aria-label={t('ao.history.filters')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => e.preventDefault()}>
        <SelectField label={t('ao.history.job')} value={f.job} onChange={(e) => set('job', e.target.value)}>
          <option value="">{t('ao.any')}</option>
          {OPS_JOB_NAMES.map((j) => <option key={j} value={j}>{jobLabel(t, j)}</option>)}
        </SelectField>
        <SelectField label={t('ao.history.status')} value={f.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">{t('ao.any')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`ao.runStatus.${s}` as MessageKey)}</option>)}
        </SelectField>
        <SelectField label={t('ao.history.trigger')} value={f.trigger} onChange={(e) => set('trigger', e.target.value)}>
          <option value="">{t('ao.any')}</option>
          {TRIGGERS.map((s) => <option key={s} value={s}>{t(`ao.trigger.${s}` as MessageKey)}</option>)}
        </SelectField>
        <SelectField label={t('ao.history.mode')} value={f.dry} onChange={(e) => set('dry', e.target.value)}>
          <option value="">{t('ao.any')}</option>
          <option value="true">{t('ao.jobs.dryRun')}</option>
          <option value="false">{t('ao.jobs.real')}</option>
        </SelectField>
      </form>
      {first.loading && !first.data ? <LoadingBlock rows={2} /> : first.error && !first.data ? <ErrorPanel error={first.error} onRetry={first.reload} /> : items.length === 0 ? <EmptyStateInline title={t('ao.history.emptyTitle')} body={t('ao.history.emptyBody')} /> : (
        <>
          <DataTable caption={t('ao.history.title')} min={940} head={[{ label: t('ao.history.col.started') }, { label: t('ao.history.job') }, { label: t('ao.history.trigger') }, { label: t('ao.history.col.actor') }, { label: t('ao.history.status') }, { label: t('ao.history.col.duration'), right: true }, { label: t('ao.history.col.processed'), right: true }, { label: t('ao.history.col.errors'), right: true }, { label: t('ao.history.col.detail') }]}>
            {items.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <Td className="whitespace-nowrap">{fmt.when(r.started_at)}</Td>
                <Td>{jobLabel(t, r.job)}{r.dry_run ? <> <Badge tone="sky">{t('ao.jobs.dryRun')}</Badge></> : null}</Td>
                <Td>{t(`ao.trigger.${r.trigger}` as MessageKey)}</Td>
                <Td mono className="max-w-[10rem] truncate">{r.actor}</Td>
                <Td><Badge tone={r.status === 'ok' ? 'routine' : r.status === 'error' ? 'emergency' : 'neutral'}>{t(`ao.runStatus.${r.status}` as MessageKey)}</Badge></Td>
                <Td right>{r.duration_ms === null ? '-' : t('ao.history.ms', { n: r.duration_ms })}</Td>
                <Td right>{r.processed}</Td>
                <Td right>{r.errors}</Td>
                <Td className="max-w-[18rem] break-words text-xs">{r.error_sample ?? Object.entries((r.counts ?? {}) as Record<string, number>).filter(([, v]) => v).slice(0, 4).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(', ')}</Td>
              </tr>
            ))}
          </DataTable>
          {more.error ? <ErrorPanel error={more.error} onRetry={() => void loadMore()} /> : null}
          {cursor ? <Button variant="outline" className="self-start" onClick={() => void loadMore()} disabled={more.busy}>{more.busy ? t('common.loading') : t('ao.loadMore')}</Button> : null}
        </>
      )}
    </section>
  );
}
