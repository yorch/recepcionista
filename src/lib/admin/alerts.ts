/**
 * Alerts center (server only). Alerts are COMPUTED from live state on every read (nothing to go stale, no table): stuck recording deletions, SMS delivery failures, job errors,
 * settings integrity failures (decrypt / MAC), settings drift between instances, stuck webhook claims, unhealthy providers, failed notifications, freeze and maintenance.
 *
 * Acknowledgement is an audit row (`alerts.acknowledged`, target `alert:<id>`, meta `until` / `count` / `reason`): it silences the alert until it expires OR the problem grows
 * (`isAcknowledged`). No schema change. Notification routing: `dispatchAlertNotices` mails every unacknowledged CRITICAL alert to every admin, `ALERT_EMAIL` and the registry
 * `platform.alert_recipients` (through `notifyAdmins`), at most once per 6 hours per alert unless it grew; each send is audited as `alerts.notified`.
 */
import { setting } from '@/lib/config';
import { prisma } from '@/lib/db/client';
import { recordAudit } from '@/lib/db/audit';
import { recordingDeletionStatus } from '@/lib/db/recording-deletions';
import { logger } from '@/lib/log';
import { eventOverview } from './deliveries';
import { notifyAdmins } from './notify';
import {
  ACK_DEFAULT_HOURS, ACK_MAX_HOURS, ACK_MIN_HOURS, ALERT_HREF, INSTANCE_ALIVE_MS, isAcknowledged, SEVERITY_RANK, type AlertKind, type AlertSeverity, type AlertView,
} from './ops-model';
import { freezeState, SettingsError, type StoreActor } from './settings-store';

const log = logger('admin-alerts');
const DAY = 86_400_000;
export const NOTICE_EVERY_MS = 6 * 3_600_000;
/** A settings version change older than this that an instance has not applied is drift (the 10 s poll + the 30 s heartbeat have long caught up). */
export const DRIFT_GRACE_MS = 120_000;

type Draft = Omit<AlertView, 'href' | 'acknowledged'>;
const mk = (d: Omit<Draft, 'id' | 'subject'> & { subject?: string | null }): Draft => ({ ...d, subject: d.subject ?? null, id: d.subject ? `${d.kind}:${d.subject}` : d.kind });

export interface AlertSummary { critical: number; warning: number; info: number; open: number; acknowledged: number }

export async function evaluateAlerts(now: Date = new Date()): Promise<{ alerts: AlertView[]; summary: AlertSummary; generated_at: string }> {
  const drafts: Draft[] = [];
  const since24 = new Date(now.getTime() - DAY);
  const guard = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (err) { log.warn('check_failed', { check: name, error: (err as Error).message }); } };

  await guard('recording_deletions', async () => {
    const s = await recordingDeletionStatus();
    if (s.stuck > 0) drafts.push(mk({ kind: 'recording_deletions_stuck', severity: 'critical', count: s.stuck, since: s.oldest_at, detail: { stuck: s.stuck, pending: s.pending } }));
  });

  await guard('sms', async () => {
    const [n, first, top] = await Promise.all([
      prisma.auditEvent.count({ where: { action: 'sms.delivery_failed', at: { gte: since24 } } }),
      prisma.auditEvent.findFirst({ where: { action: 'sms.delivery_failed', at: { gte: since24 } }, orderBy: { at: 'asc' }, select: { at: true } }),
      prisma.$queryRaw<{ code: string | null; n: number }[]>`SELECT meta->>'error_code' AS code, count(*)::int AS n FROM audit_events WHERE action = 'sms.delivery_failed' AND at >= ${since24} GROUP BY 1 ORDER BY n DESC LIMIT 1`,
    ]);
    if (n > 0) drafts.push(mk({ kind: 'sms_delivery_failures', severity: n >= 20 ? 'critical' : 'warning', count: n, since: first?.at.toISOString() ?? null, detail: { window_hours: 24, top_code: top[0]?.code ?? null } }));
  });

  await guard('jobs', async () => {
    const runs = await prisma.jobRun.findMany({ where: { startedAt: { gte: since24 }, dryRun: false }, orderBy: { startedAt: 'desc' }, take: 500, select: { job: true, status: true, startedAt: true, errors: true, errorSample: true } });
    const latest = new Map<string, (typeof runs)[number]>();
    const errors = new Map<string, number>();
    const firstErr = new Map<string, Date>();
    for (const r of runs) {
      if (!latest.has(r.job)) latest.set(r.job, r);
      if (r.status === 'error') { errors.set(r.job, (errors.get(r.job) ?? 0) + 1); firstErr.set(r.job, r.startedAt); }
    }
    for (const [job, r] of latest) {
      if (r.status !== 'error') continue; // the job recovered: nothing to do
      const n = errors.get(job) ?? 1;
      drafts.push(mk({ kind: 'job_errors', subject: job, severity: n >= 3 ? 'critical' : 'warning', count: n, since: firstErr.get(job)?.toISOString() ?? null, detail: { job, last_error: r.errorSample, window_hours: 24 } }));
    }
  });

  await guard('integrity', async () => {
    const since7 = new Date(now.getTime() - 7 * DAY);
    const [n, first, beats] = await Promise.all([
      prisma.auditEvent.count({ where: { action: 'settings.integrity_failure', at: { gte: since7 } } }),
      prisma.auditEvent.findFirst({ where: { action: 'settings.integrity_failure', at: { gte: since7 } }, orderBy: { at: 'asc' }, select: { at: true } }),
      prisma.instanceHeartbeat.findMany({ where: { seenAt: { gte: new Date(now.getTime() - INSTANCE_ALIVE_MS) } }, select: { canary: true, ignoredRows: true } }),
    ]);
    const canaryFailed = beats.filter((b) => b.canary === 'failed').length;
    const ignored = beats.reduce((m, b) => Math.max(m, b.ignoredRows), 0);
    if (n > 0 || canaryFailed > 0 || ignored > 0) {
      drafts.push(mk({ kind: 'settings_integrity', severity: 'critical', count: Math.max(n, canaryFailed, ignored, 1), since: first?.at.toISOString() ?? null, detail: { audited_failures_7d: n, canary_failed_instances: canaryFailed, ignored_rows: ignored } }));
    }
  });

  await guard('drift', async () => {
    const [state, beats] = await Promise.all([prisma.settingsState.findUnique({ where: { id: 1 } }), prisma.instanceHeartbeat.findMany({ where: { seenAt: { gte: new Date(now.getTime() - INSTANCE_ALIVE_MS) } }, select: { settingsVersion: true, instanceId: true } })]);
    const version = Number(state?.globalVersion ?? 0);
    if (beats.length === 0) {
      drafts.push(mk({ kind: 'instance_down', severity: 'warning', count: 1, since: null, detail: { alive: 0 } }));
      return;
    }
    const changedAgo = state ? now.getTime() - state.updatedAt.getTime() : 0;
    const behind = beats.filter((b) => Number(b.settingsVersion) !== version);
    if (behind.length > 0 && changedAgo > DRIFT_GRACE_MS) {
      drafts.push(mk({ kind: 'settings_drift', severity: 'warning', count: behind.length, since: state?.updatedAt.toISOString() ?? null, detail: { settings_version: version, instances_behind: behind.length, instances_alive: beats.length } }));
    }
  });

  await guard('events', async () => {
    const ev = await eventOverview({ hours: 24, now });
    if (ev.totals.stuck > 0) drafts.push(mk({ kind: 'stuck_events', severity: ev.totals.stuck >= 20 ? 'critical' : 'warning', count: ev.totals.stuck, since: ev.sources.map((s) => s.oldest_stuck_at).filter(Boolean).sort()[0] ?? null, detail: { sources: ev.sources.filter((s) => s.stuck > 0).length } }));
  });

  await guard('providers', async () => {
    const rows = await prisma.auditEvent.findMany({ where: { action: 'provider.health', at: { gte: since24 } }, orderBy: { at: 'desc' }, take: 300, select: { at: true, target: true, meta: true } });
    const seen = new Set<string>();
    for (const r of rows) {
      const provider = r.target.replace(/^provider:/, '');
      if (seen.has(provider)) continue;
      seen.add(provider);
      const outcome = ((r.meta ?? {}) as { outcome?: string }).outcome;
      if (outcome && outcome !== 'ok') drafts.push(mk({ kind: 'provider_unhealthy', subject: provider, severity: outcome === 'auth_failed' ? 'critical' : 'warning', count: 1, since: r.at.toISOString(), detail: { provider, outcome } }));
    }
  });

  await guard('notify', async () => {
    const [n, first] = await Promise.all([
      prisma.auditEvent.count({ where: { action: 'admin.notify_failed', at: { gte: since24 } } }),
      prisma.auditEvent.findFirst({ where: { action: 'admin.notify_failed', at: { gte: since24 } }, orderBy: { at: 'asc' }, select: { at: true } }),
    ]);
    if (n > 0) drafts.push(mk({ kind: 'notify_failures', severity: 'warning', count: n, since: first?.at.toISOString() ?? null, detail: { window_hours: 24 } }));
  });

  await guard('state', async () => {
    const f = await freezeState();
    if (f.frozen) drafts.push(mk({ kind: 'freeze_active', severity: 'info', count: 1, since: f.frozen_at, detail: { by_env: f.by_env } }));
    if (setting('platform.maintenance_mode') === true) drafts.push(mk({ kind: 'maintenance_active', severity: 'info', count: 1, since: null, detail: {} }));
  });

  const acks = await ackMap(now);
  const alerts: AlertView[] = drafts.map((d) => {
    const ack = acks.get(d.id) ?? null;
    return { ...d, href: ALERT_HREF[d.kind], acknowledged: ack && isAcknowledged({ until: ack.until, count: ack.count }, now, d.count) ? { by: ack.by, at: ack.at, until: ack.until, reason: ack.reason } : null };
  }).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || Number(Boolean(a.acknowledged)) - Number(Boolean(b.acknowledged)) || b.count - a.count);
  const open = alerts.filter((a) => !a.acknowledged && a.severity !== 'info');
  return {
    alerts, generated_at: now.toISOString(),
    summary: { critical: open.filter((a) => a.severity === 'critical').length, warning: open.filter((a) => a.severity === 'warning').length, info: alerts.filter((a) => a.severity === 'info').length, open: open.length, acknowledged: alerts.filter((a) => a.acknowledged).length },
  };
}

interface AckRow { by: string | null; at: string; until: string; count: number; reason: string | null }
async function ackMap(now: Date): Promise<Map<string, AckRow>> {
  const rows = await prisma.auditEvent.findMany({ where: { action: 'alerts.acknowledged', at: { gte: new Date(now.getTime() - (ACK_MAX_HOURS + 24) * 3_600_000) } }, orderBy: { at: 'desc' }, take: 500, select: { at: true, target: true, actorUserId: true, actorKind: true, meta: true } });
  const out = new Map<string, AckRow>();
  for (const r of rows) {
    const id = r.target.replace(/^alert:/, '');
    if (out.has(id)) continue;
    const m = (r.meta ?? {}) as { until?: string; count?: number; reason?: string | null };
    if (!m.until) continue;
    out.set(id, { by: r.actorUserId ?? r.actorKind, at: r.at.toISOString(), until: m.until, count: typeof m.count === 'number' ? m.count : 0, reason: m.reason ?? null });
  }
  return out;
}

const ID = /^[a-z_]{3,40}(:[A-Za-z0-9_.-]{1,60})?$/;

/** Acknowledge an alert that is open right now (an unknown id is 404: nothing is silenced in advance). */
export async function acknowledgeAlert(opts: { id: string; hours?: number; reason?: string; actor: StoreActor; now?: Date }): Promise<AlertView> {
  const now = opts.now ?? new Date();
  if (!ID.test(opts.id)) throw new SettingsError(422, 'invalid_body', 'invalid alert id');
  const hours = Math.min(Math.max(Math.floor(opts.hours ?? ACK_DEFAULT_HOURS), ACK_MIN_HOURS), ACK_MAX_HOURS);
  const reason = (opts.reason ?? '').trim().slice(0, 300);
  const { alerts } = await evaluateAlerts(now);
  const alert = alerts.find((a) => a.id === opts.id);
  if (!alert) throw new SettingsError(404, 'not_found', 'no such open alert');
  if (alert.severity === 'info') throw new SettingsError(409, 'not_acknowledgeable', 'informational notices cannot be acknowledged');
  const until = new Date(now.getTime() + hours * 3_600_000);
  await recordAudit({ actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, action: 'alerts.acknowledged', target: `alert:${alert.id}`, meta: { until: until.toISOString(), hours, count: alert.count, reason: reason || null, role: opts.actor.role } });
  return { ...alert, acknowledged: { by: opts.actor.user_id ?? opts.actor.kind, at: now.toISOString(), until: until.toISOString(), reason: reason || null } };
}

/** Withdraw an acknowledgement (the alert shows again at once). */
export async function unacknowledgeAlert(opts: { id: string; actor: StoreActor; now?: Date }): Promise<void> {
  const now = opts.now ?? new Date();
  if (!ID.test(opts.id)) throw new SettingsError(422, 'invalid_body', 'invalid alert id');
  await recordAudit({ actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, action: 'alerts.acknowledged', target: `alert:${opts.id}`, meta: { until: new Date(now.getTime() - 1000).toISOString(), hours: 0, count: 0, reason: 'withdrawn', role: opts.actor.role } });
}

export interface NoticeResult { due: string[]; skipped: string[]; recipients: number; sent: number; failed: number }

const SUBJECT: Record<AlertKind, string> = {
  recording_deletions_stuck: 'voicemail recordings are not being deleted', sms_delivery_failures: 'text messages are failing to deliver', job_errors: 'a background job is failing', settings_integrity: 'a stored setting failed its integrity check',
  settings_drift: 'instances run different settings versions', stuck_events: 'webhook claims are stuck', provider_unhealthy: 'a provider connection test fails', notify_failures: 'admin notification mail is failing',
  instance_down: 'no instance reports in', freeze_active: 'console frozen', maintenance_active: 'maintenance mode on',
};

/**
 * Mail every unacknowledged CRITICAL alert (and warnings that persist) to the admins, ALERT_EMAIL and `platform.alert_recipients`. One mail per call listing the due alerts; an alert is
 * re-sent only after 6 hours or when it grew. Never throws. `force` ignores the 6 hour spacing (the "send now" button).
 */
export async function dispatchAlertNotices(opts: { now?: Date; force?: boolean; severities?: AlertSeverity[] } = {}): Promise<NoticeResult> {
  const now = opts.now ?? new Date();
  const result: NoticeResult = { due: [], skipped: [], recipients: 0, sent: 0, failed: 0 };
  try {
    const { alerts } = await evaluateAlerts(now);
    const want = new Set<AlertSeverity>(opts.severities ?? ['critical']);
    const open = alerts.filter((a) => !a.acknowledged && want.has(a.severity));
    if (open.length === 0) return result;
    const prior = await prisma.auditEvent.findMany({ where: { action: 'alerts.notified', at: { gte: new Date(now.getTime() - NOTICE_EVERY_MS) } }, orderBy: { at: 'desc' }, take: 200, select: { target: true, meta: true } });
    const last = new Map<string, number>();
    for (const r of prior) { const id = r.target.replace(/^alert:/, ''); if (!last.has(id)) last.set(id, Number((r.meta as { count?: number } | null)?.count ?? 0)); }
    const due = open.filter((a) => opts.force || !last.has(a.id) || a.count > (last.get(a.id) ?? 0));
    result.skipped = open.filter((a) => !due.includes(a)).map((a) => a.id);
    if (due.length === 0) return result;
    result.due = due.map((a) => a.id);
    const n = await notifyAdmins({
      subject: `[Recepcionista] ${due.length} platform alert${due.length === 1 ? '' : 's'}: ${SUBJECT[due[0].kind]}${due.length > 1 ? ' and more' : ''}`,
      kind: 'alerts',
      lines: [
        `${due.length} open alert(s) need attention:`,
        ...due.map((a) => `- [${a.severity}] ${SUBJECT[a.kind]}${a.subject ? ` (${a.subject})` : ''}: ${a.count} affected${a.since ? `, since ${a.since}` : ''}. Console: ${a.href}`),
        '',
        'Open the Alerts center in the admin console to acknowledge or investigate. No secret value is included in this notice.',
      ],
    });
    result.recipients = n.recipients; result.sent = n.sent; result.failed = n.failed;
    for (const a of due) await recordAudit({ actor_kind: 'system', action: 'alerts.notified', target: `alert:${a.id}`, meta: { count: a.count, severity: a.severity, recipients: n.recipients, sent: n.sent, failed: n.failed } });
  } catch (err) {
    log.error('dispatch_failed', { error: (err as Error).message });
  }
  return result;
}
