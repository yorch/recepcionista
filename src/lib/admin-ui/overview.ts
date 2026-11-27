/**
 * Pure derivations of the Overview page (testable without a browser): the latest run of every job, and the alerts that the existing APIs can really answer
 * (providers not ready, job errors in the last 24 hours, settings drift between instances, the settings layer's own health, freeze). Signals with no API
 * yet (stuck recording deletions, SMS delivery failures) are NOT invented here: the page lists them as "not monitored yet".
 */
export interface RunLite { job: string; started_at: string; status: string; processed: number; errors: number; dry_run: boolean; trigger: string; error_sample: string | null }
export interface ProviderLite { provider: string; ready: boolean; missing: string[] }
export interface SystemLite {
  frozen: { frozen: boolean };
  loader: { ok: boolean; canary: string; ignored_rows: number; needs_reencrypt: boolean; error?: string };
  applied: { instances_alive: number; instances_current: number };
}

export interface JobSummary { job: string; last: RunLite; lastReal: RunLite | null; errors24h: number; runs: number }

const DAY = 24 * 60 * 60_000;

/** Newest run per job (the list is newest first) with how many real runs failed in the last 24 hours. */
export function summarizeJobs(runs: readonly RunLite[], now: number): JobSummary[] {
  const by = new Map<string, JobSummary>();
  for (const r of runs) {
    let s = by.get(r.job);
    if (!s) by.set(r.job, (s = { job: r.job, last: r, lastReal: null, errors24h: 0, runs: 0 }));
    s.runs++;
    if (!r.dry_run && !s.lastReal) s.lastReal = r;
    if (!r.dry_run && r.status === 'error' && now - new Date(r.started_at).getTime() < DAY) s.errors24h++;
  }
  return [...by.values()].sort((a, b) => a.job.localeCompare(b.job));
}

export type AlertCode =
  | 'provider_not_ready' | 'job_errors' | 'settings_drift' | 'settings_unhealthy' | 'canary_failed' | 'rows_ignored' | 'needs_reencrypt' | 'frozen';
export interface Alert { code: AlertCode; severity: 'error' | 'warn'; subject: string; count?: number }

export function buildAlerts(input: { providers: readonly ProviderLite[] | null; runs: readonly RunLite[] | null; system: SystemLite | null; now: number }): Alert[] {
  const out: Alert[] = [];
  for (const p of input.providers ?? []) if (!p.ready) out.push({ code: 'provider_not_ready', severity: 'warn', subject: p.provider, count: p.missing.length });
  for (const j of summarizeJobs(input.runs ?? [], input.now)) if (j.errors24h > 0) out.push({ code: 'job_errors', severity: 'error', subject: j.job, count: j.errors24h });
  const s = input.system;
  if (s) {
    if (s.loader.canary === 'failed') out.push({ code: 'canary_failed', severity: 'error', subject: 'canary' });
    else if (!s.loader.ok) out.push({ code: 'settings_unhealthy', severity: 'error', subject: s.loader.error ?? 'settings' });
    if (s.loader.ignored_rows > 0) out.push({ code: 'rows_ignored', severity: 'error', subject: 'settings', count: s.loader.ignored_rows });
    if (s.applied.instances_current < s.applied.instances_alive) out.push({ code: 'settings_drift', severity: 'warn', subject: 'instances', count: s.applied.instances_alive - s.applied.instances_current });
    if (s.loader.needs_reencrypt) out.push({ code: 'needs_reencrypt', severity: 'warn', subject: 'keys' });
    if (s.frozen.frozen) out.push({ code: 'frozen', severity: 'warn', subject: 'freeze' });
  }
  return out;
}
