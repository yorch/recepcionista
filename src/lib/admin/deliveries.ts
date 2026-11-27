/**
 * Delivery views of the console (server only): SMS delivery failures and the webhook / event idempotency table.
 *
 * SMS: Twilio's per-message status callback audits `sms.delivery_failed` (error code, status, kind, the sms id; never the text). `sms_log` says what was sent and which sends failed or were
 * blocked at send time (`status` failed / blocked_*). The dashboard joins them per tenant and per error code, with the retry guidance of each failure class.
 * Events: `processed_events` is the idempotency table of every webhook and job claim: a `processing` row whose lease ran out is a delivery that never finished.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { PROCESSED_EVENTS_RETENTION_MS } from '@/lib/db/events';
import { classifySmsFailure, eventSourceKind, STUCK_CLAIM_MINUTES, type EventOverview, type SmsFailureClass, type SmsOverview } from './ops-model';
import { SettingsError } from './settings-store';

const clampInt = (v: number | undefined, def: number, min: number, max: number): number => Math.min(Math.max(Number.isFinite(v) ? Math.floor(v as number) : def, min), max);

export interface SmsQuery { days?: number; business_id?: string; code?: string; before?: string; limit?: number; now?: Date }

/** WHERE conditions of the `sms.delivery_failed` audit rows (alias `a`); `before` is the keyset cursor `<iso>~<id>` of the page query only. */
function failureConds(o: { from: Date; now: Date; businessId?: string; code?: string; before?: string }): Prisma.Sql[] {
  const conds: Prisma.Sql[] = [Prisma.sql`a.action = 'sms.delivery_failed'`, Prisma.sql`a.at >= ${o.from}`, Prisma.sql`a.at <= ${o.now}`];
  if (o.businessId) conds.push(Prisma.sql`a.business_id = ${o.businessId}`);
  if (o.code) conds.push(o.code === 'none' ? Prisma.sql`(a.meta->>'error_code') IS NULL` : Prisma.sql`a.meta->>'error_code' = ${o.code.slice(0, 10)}`);
  if (o.before) {
    const i = o.before.indexOf('~');
    const at = new Date(i === -1 ? o.before : o.before.slice(0, i));
    if (Number.isNaN(at.getTime())) throw new SettingsError(422, 'invalid_cursor', 'invalid cursor');
    const id = i === -1 ? null : o.before.slice(i + 1);
    conds.push(id ? Prisma.sql`(a.at < ${at} OR (a.at = ${at} AND a.id < ${id}))` : Prisma.sql`a.at < ${at}`);
  }
  return conds;
}

export async function smsDeliveryOverview(q: SmsQuery = {}): Promise<SmsOverview> {
  const now = q.now ?? new Date();
  const days = clampInt(q.days, 7, 1, 90);
  const from = new Date(now.getTime() - days * 86_400_000);
  const limit = clampInt(q.limit, 25, 1, 100);
  const where = Prisma.join(failureConds({ from, now, businessId: q.business_id, code: q.code }), ' AND ');
  const bizFilter = q.business_id ? { businessId: q.business_id } : {};

  const [byCode, byTenant, byDay, sent, sendFailed, blocked, page] = await Promise.all([
    prisma.$queryRaw<{ code: string | null; n: number }[]>`SELECT a.meta->>'error_code' AS code, count(*)::int AS n FROM audit_events a WHERE ${where} GROUP BY 1 ORDER BY n DESC LIMIT 40`,
    prisma.$queryRaw<{ business_id: string | null; name: string | null; n: number; top: string | null }[]>`
      SELECT a.business_id, b.name, count(*)::int AS n, (array_agg(a.meta->>'error_code' ORDER BY a.at DESC))[1] AS top
        FROM audit_events a LEFT JOIN businesses b ON b.id = a.business_id WHERE ${where} GROUP BY a.business_id, b.name ORDER BY n DESC LIMIT 25`,
    prisma.$queryRaw<{ day: string; n: number }[]>`SELECT to_char(date_trunc('day', a.at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS n FROM audit_events a WHERE ${where} GROUP BY 1 ORDER BY 1`,
    prisma.smsLog.count({ where: { createdAt: { gte: from, lte: now }, status: { in: ['sent', 'delivered', 'queued', 'mock'] }, ...bizFilter } }),
    prisma.smsLog.count({ where: { createdAt: { gte: from, lte: now }, status: 'failed', ...bizFilter } }),
    prisma.smsLog.count({ where: { createdAt: { gte: from, lte: now }, status: { startsWith: 'blocked' }, ...bizFilter } }),
    recentFailures({ from, now, limit, businessId: q.business_id, code: q.code, before: q.before }),
  ]);
  const delivery = byCode.reduce((n, r) => n + r.n, 0);
  const classes = new Map<SmsFailureClass, number>();
  for (const r of byCode) { const c = classifySmsFailure(r.code); classes.set(c, (classes.get(c) ?? 0) + r.n); }
  return {
    window: { from: from.toISOString(), to: now.toISOString(), days },
    totals: { sent, delivery_failures: delivery, send_failures: sendFailed, blocked, failure_rate_pct: sent > 0 ? Math.min(100, Math.round((delivery / sent) * 1000) / 10) : null },
    by_code: byCode.map((r) => ({ code: r.code, count: r.n, failure_class: classifySmsFailure(r.code) })),
    by_class: [...classes.entries()].map(([failure_class, count]) => ({ failure_class, count })).sort((a, b) => b.count - a.count),
    by_tenant: byTenant.map((r) => ({ business_id: r.business_id, business_name: r.name, count: r.n, top_code: r.top })),
    by_day: byDay.map((r) => ({ day: r.day, count: r.n })),
    recent: page,
  };
}

async function recentFailures(o: { from: Date; now: Date; limit: number; businessId?: string; code?: string; before?: string }): Promise<SmsOverview['recent']> {
  const where = Prisma.join(failureConds(o), ' AND ');
  const rows = await prisma.$queryRaw<{ id: string; at: Date; business_id: string | null; name: string | null; code: string | null; status: string | null; kind: string | null; target: string }[]>`
    SELECT a.id, a.at, a.business_id, b.name, a.meta->>'error_code' AS code, a.meta->>'status' AS status, a.meta->>'kind' AS kind, a.target
      FROM audit_events a LEFT JOIN businesses b ON b.id = a.business_id
     WHERE ${where} ORDER BY a.at DESC, a.id DESC LIMIT ${o.limit + 1}`;
  const items = rows.slice(0, o.limit);
  return {
    items: items.map((r) => ({ id: r.id, at: r.at.toISOString(), business_id: r.business_id, business_name: r.name, code: r.code, failure_class: classifySmsFailure(r.code), status: r.status ?? 'failed', kind: r.kind, sms_id: r.target.startsWith('sms:') ? r.target.slice(4) : null })),
    next_cursor: rows.length > o.limit ? `${items[items.length - 1].at.toISOString()}~${items[items.length - 1].id}` : null,
  };
}

export async function eventOverview(q: { hours?: number; now?: Date } = {}): Promise<EventOverview> {
  const now = q.now ?? new Date();
  const hours = clampInt(q.hours, 24, 1, 24 * 30);
  const from = new Date(now.getTime() - hours * 3_600_000);
  const stuckBefore = new Date(now.getTime() - STUCK_CLAIM_MINUTES * 60_000);
  const [sources, stuck] = await Promise.all([
    prisma.$queryRaw<{ source: string; total: number; done: number; processing: number; stuck: number; last_at: Date | null; oldest_stuck: Date | null }[]>`
      SELECT source, count(*)::int AS total,
             count(*) FILTER (WHERE status = 'done')::int AS done,
             count(*) FILTER (WHERE status = 'processing')::int AS processing,
             count(*) FILTER (WHERE status = 'processing' AND claimed_at < ${stuckBefore})::int AS stuck,
             max(claimed_at) AS last_at,
             min(claimed_at) FILTER (WHERE status = 'processing' AND claimed_at < ${stuckBefore}) AS oldest_stuck
        FROM processed_events WHERE claimed_at >= ${from} OR (status = 'processing' AND claimed_at < ${stuckBefore})
       GROUP BY source ORDER BY total DESC, source LIMIT 100`,
    prisma.$queryRaw<{ source: string; id: string; claimed_at: Date }[]>`
      SELECT source, id, claimed_at FROM processed_events WHERE status = 'processing' AND claimed_at < ${stuckBefore} ORDER BY claimed_at ASC LIMIT 50`,
  ]);
  const rows = sources.map((r) => ({ source: r.source, kind: eventSourceKind(r.source), total: r.total, done: r.done, processing: r.processing, stuck: r.stuck, last_at: r.last_at?.toISOString() ?? null, oldest_stuck_at: r.oldest_stuck?.toISOString() ?? null }));
  return {
    window: { from: from.toISOString(), to: now.toISOString(), hours },
    totals: rows.reduce((t, r) => ({ total: t.total + r.total, done: t.done + r.done, processing: t.processing + r.processing, stuck: t.stuck + r.stuck }), { total: 0, done: 0, processing: 0, stuck: 0 }),
    sources: rows,
    stuck: stuck.map((r) => ({ source: r.source, id: r.id.length > 80 ? `${r.id.slice(0, 77)}...` : r.id, claimed_at: r.claimed_at.toISOString(), age_minutes: Math.floor((now.getTime() - r.claimed_at.getTime()) / 60_000) })),
    retention_days: Math.round(PROCESSED_EVENTS_RETENTION_MS / 86_400_000),
  };
}
