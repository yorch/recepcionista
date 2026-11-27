/**
 * Operations views: the PURE part (types and classifiers shared by the server modules, the JSON routes and the client components; no database, no Node API).
 * Agent D (operations): SMS delivery failures, webhook / event deliveries, provider health history, alerts, usage and revenue overview, impact previews.
 */

// ---- SMS delivery failures --------------------------------------------------------------------------------------------------

/** What a failed text means for the operator. Each class has localized guidance in the catalog (`ao.sms.guide.<class>`). */
export type SmsFailureClass = 'number' | 'optout' | 'carrier' | 'registration' | 'account' | 'transient' | 'unknown';

const SMS_CODES: Record<string, SmsFailureClass> = {
  '30001': 'transient', // queue overflow
  '30002': 'account', // account suspended
  '30003': 'number', // unreachable destination handset (switched off, out of coverage)
  '30004': 'carrier', // message blocked
  '30005': 'number', // unknown destination handset
  '30006': 'number', // landline or unreachable carrier
  '30007': 'carrier', // carrier violation (filtered)
  '30008': 'transient', // unknown error
  '30009': 'transient', // missing segment
  '30010': 'account', // price exceeds the max price
  '30034': 'registration', // A2P 10DLC: unregistered sender
  '21610': 'optout', // recipient unsubscribed
  '21211': 'number', // invalid To number
  '21614': 'number', // To number is not a valid mobile number
  '21408': 'account', // permission to send to this region is not enabled
  '21612': 'carrier', // cannot route to this number
};

export function classifySmsFailure(code: string | null | undefined): SmsFailureClass {
  const c = (code ?? '').trim();
  return SMS_CODES[c] ?? 'unknown';
}

/** Classes where a retry can help (the others need a fix first). */
export const RETRYABLE_SMS_CLASSES: readonly SmsFailureClass[] = ['transient'];

export interface SmsFailureRow { id: string; at: string; business_id: string | null; business_name: string | null; code: string | null; failure_class: SmsFailureClass; status: string; kind: string | null; sms_id: string | null }
export interface SmsOverview {
  window: { from: string; to: string; days: number };
  totals: { sent: number; delivery_failures: number; send_failures: number; blocked: number; failure_rate_pct: number | null };
  by_code: { code: string | null; count: number; failure_class: SmsFailureClass }[];
  by_class: { failure_class: SmsFailureClass; count: number }[];
  by_tenant: { business_id: string | null; business_name: string | null; count: number; top_code: string | null }[];
  by_day: { day: string; count: number }[];
  recent: { items: SmsFailureRow[]; next_cursor: string | null };
}

// ---- event / webhook deliveries ---------------------------------------------------------------------------------------------

export type EventSourceKind = 'webhook' | 'job' | 'internal';
const WEBHOOK_SOURCES = new Set(['stripe', 'stripe-billing', 'elevenlabs-postcall', 'inbound_keyword', 'sms_send', 'sms_cancel', 'inbound-ambiguous', 'recording-played']);
const JOB_SOURCES = new Set(['job-state', 'daily-briefing', 'gratitude-sweep', 'usage-warn-pass', 'usage-warn-retry', 'agent-dirty', 'gcal-dirty', 'gcal-state', 'link-deactivate']);
export function eventSourceKind(source: string): EventSourceKind {
  return WEBHOOK_SOURCES.has(source) ? 'webhook' : JOB_SOURCES.has(source) ? 'job' : 'internal';
}

/** A 'processing' claim whose lease ran out is a delivery that was claimed and never finished (the worker died or the handler failed and could not release it). */
export const STUCK_CLAIM_MINUTES = 15;

export interface EventSourceRow { source: string; kind: EventSourceKind; total: number; done: number; processing: number; stuck: number; last_at: string | null; oldest_stuck_at: string | null }
export interface EventOverview {
  window: { from: string; to: string; hours: number };
  totals: { total: number; done: number; processing: number; stuck: number };
  sources: EventSourceRow[];
  stuck: { source: string; id: string; claimed_at: string; age_minutes: number }[];
  retention_days: number;
}

// ---- provider health -------------------------------------------------------------------------------------------------------

export type HealthOutcome = 'ok' | 'auth_failed' | 'unreachable' | 'misconfigured';
export interface HealthPoint { at: string; outcome: HealthOutcome; ms: number | null; checks: Record<string, string> | null; actor: string }
export interface ProviderHealth {
  provider: string;
  current: HealthPoint | null;
  /** Share of recorded checks in the window that were `ok` (null: no data). */
  ok_pct: number | null;
  checks: number;
  last_ok_at: string | null;
  last_failure_at: string | null;
  history: HealthPoint[];
}
export interface HealthOverview { window: { from: string; to: string; days: number }; providers: ProviderHealth[] }

// ---- alerts ----------------------------------------------------------------------------------------------------------------

export const ALERT_KINDS = [
  'recording_deletions_stuck', 'sms_delivery_failures', 'job_errors', 'settings_integrity', 'settings_drift', 'stuck_events', 'provider_unhealthy', 'notify_failures', 'instance_down', 'freeze_active', 'maintenance_active',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface AlertView {
  /** Stable id: `<kind>` or `<kind>:<subject>` (a job name, a provider). Acknowledgement is keyed by it. */
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** How many things are wrong (stuck deletions, failed texts, failed runs...). */
  count: number;
  subject: string | null;
  since: string | null;
  /** Non-secret facts the page can show (counts, job name, codes). */
  detail: Record<string, string | number | boolean | null>;
  /** The console page that fixes or explains it. */
  href: string;
  acknowledged: { by: string | null; at: string; until: string; reason: string | null } | null;
}

/** Console routes per kind (kept next to the kinds so the nav and the alerts agree). */
export const ALERT_HREF: Record<AlertKind, string> = {
  recording_deletions_stuck: '/admin/operations/jobs',
  sms_delivery_failures: '/admin/operations/deliveries',
  job_errors: '/admin/operations/jobs',
  settings_integrity: '/admin/system',
  settings_drift: '/admin/operations/instances',
  stuck_events: '/admin/operations/events',
  provider_unhealthy: '/admin/operations/health',
  notify_failures: '/admin/operations/audit',
  instance_down: '/admin/operations/instances',
  freeze_active: '/admin/system',
  maintenance_active: '/admin/settings/locales',
};

export const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** An acknowledgement silences an alert until it expires OR until the problem grows (more failures than when it was acknowledged). */
export function isAcknowledged(ack: { until: string; count: number } | null, now: Date, currentCount: number): boolean {
  return Boolean(ack && new Date(ack.until).getTime() > now.getTime() && currentCount <= ack.count);
}

export const ACK_MIN_HOURS = 1;
export const ACK_MAX_HOURS = 24 * 14;
export const ACK_DEFAULT_HOURS = 24;

// ---- instances --------------------------------------------------------------------------------------------------------------

export interface InstanceView {
  instance_id: string; settings_version: number; build_sha: string | null; canary: string; ignored_rows: number; started_at: string; seen_at: string;
  alive: boolean; current: boolean; behind_by: number;
}
export interface InstancesOverview {
  version: number;
  instances: InstanceView[];
  alive: number;
  current: number;
  /** More than one build SHA among the live instances (a rolling deploy in progress, or a stuck one). */
  mixed_builds: boolean;
  builds: { build_sha: string | null; count: number }[];
}
export const INSTANCE_ALIVE_MS = 90_000;

// ---- usage and revenue ------------------------------------------------------------------------------------------------------

export interface UsageOverview {
  generated_at: string;
  tenants: { total: number; by_status: Record<string, number>; by_billing: Record<string, number>; by_plan: { plan: string; count: number; comped: boolean }[]; suspended: number; comped: number };
  revenue: {
    /** Paying tenants = billing_status active (not comped, not suspended); past_due is counted separately. */
    paying: number; past_due: number;
    currency: string | null;
    /** Estimated monthly recurring revenue in minor units (cents), from the monthly price of each plan. Null while no price can be read. */
    mrr_cents: number | null;
    mrr_by_plan: { plan: string; paying: number; monthly_cents: number | null; subtotal_cents: number | null; price_source: 'plan' | 'platform' | 'none' }[];
    note: 'estimate_monthly_price';
  };
  usage: { period_start: string; businesses_with_usage: number; sms: CapUsage; ai_minutes: CapUsage; forward_minutes: CapUsage; voicemail_minutes: CapUsage };
  trials: { trialing: number; ending_7d: number; ending_3d: number; expired_unconverted: number; upcoming: { business_id: string; name: string; trial_ends_at: string; plan: string | null }[] };
  top_usage: { business_id: string; name: string; sms: number; sms_cap: number; ai_minutes: number; ai_cap: number }[];
}
export interface CapUsage { used: number; over_80: number; over_100: number }

// ---- impact previews --------------------------------------------------------------------------------------------------------

export type ImpactId = 'tenants_over_sms_cap' | 'tenants_over_ai_cap' | 'owner_phones_invalid' | 'retention_purge' | 'billing_enforcement' | 'past_due_cutoff' | 'tenant_release_candidates';
export interface ImpactView {
  key: string;
  id: ImpactId;
  /** The headline number (tenants / phones / rows affected). */
  count: number;
  /** The population it is measured against (tenants with usage, owner phones, live tenants...), or null. */
  total: number | null;
  /** Per-tenant or per-kind detail rows (never more than 10). */
  rows: { label: string; value: number }[];
  /** Extra non-secret facts. */
  facts: Record<string, string | number | boolean | null>;
}

// ---- jobs -------------------------------------------------------------------------------------------------------------------

/** The job names of the runner (kept in sync with `JOB_NAMES` of src/lib/jobs/schedule.ts by a test: the client must not import the runner). */
export const OPS_JOB_NAMES = ['daily_briefing', 'gratitude_sweep', 'cleanup', 'retention', 'recording_deletions', 'reconcile', 'usage_warnings', 'google_calendar', 'tenant_release', 'grandfather'] as const;
export type OpsJobName = (typeof OPS_JOB_NAMES)[number];

/** Jobs that delete data or act on tenants: a real run needs a written reason and the typed phrase, and notifies every admin. Mirrors `CRITICAL_JOBS` of the run route. */
export const CRITICAL_OPS_JOBS: readonly OpsJobName[] = ['retention', 'tenant_release', 'grandfather'];
/** Jobs a run can be limited to one business. */
export const PER_BUSINESS_JOBS: readonly OpsJobName[] = ['daily_briefing', 'gratitude_sweep', 'tenant_release'];

/** The registry setting that switches a job on or off (shown next to the job; edited on the generated settings pages). */
export const JOB_CONTROL: Record<OpsJobName, { key: string; page: string } | null> = {
  daily_briefing: { key: 'jobs.enabled', page: '/admin/settings/jobs' },
  gratitude_sweep: { key: 'jobs.enabled', page: '/admin/settings/jobs' },
  cleanup: { key: 'jobs.enabled', page: '/admin/settings/jobs' },
  recording_deletions: { key: 'jobs.enabled', page: '/admin/settings/jobs' },
  reconcile: { key: 'jobs.enabled', page: '/admin/settings/jobs' },
  usage_warnings: { key: 'jobs.enabled', page: '/admin/settings/jobs' },
  google_calendar: { key: 'jobs.enabled', page: '/admin/settings/jobs' },
  retention: { key: 'jobs.retention_enabled', page: '/admin/settings/data' },
  tenant_release: { key: 'jobs.tenant_release_mode', page: '/admin/settings/data' },
  grandfather: null,
};

export interface JobStatusView {
  name: OpsJobName; description: string; schedule: string; enabled: boolean; last_run_at: string | null; last_result: Record<string, unknown> | null; next_due_at: string | null; note?: string;
}
export interface JobsData {
  runner: { jobs_setting: 'on' | 'off'; explicit: boolean; tick_seconds: number; enabled_jobs: string[] };
  jobs: JobStatusView[];
  diagnostics: {
    recording_deletions: { pending: number; stuck: number; oldest_at: string | null };
    tenant_release: {
      setting: 'off' | 'report' | 'on';
      last_report: { at: string; meta: StoredReport } | null;
      last_grandfather_report: { at: string; meta: StoredReport } | null;
    };
  };
}
/** The audit meta of `jobs.tenant_release_report` / `jobs.grandfather_report`. `items` are `[business id, outcome]` pairs (capped at 40; `items_total` says how many there were). */
export interface StoredReport { at?: string; dry_run?: boolean; processed?: number; errors?: number; counts?: Record<string, number>; items?: [string | null, string][]; items_total?: number; setting?: string; cutoff?: string }
export interface JobReportView { job: string; dry_run: boolean; at: string; processed: number; errors: number; counts?: Record<string, number>; items: { business_id?: string; outcome: string; detail?: Record<string, unknown> }[] }
