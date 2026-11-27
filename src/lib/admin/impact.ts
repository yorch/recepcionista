/**
 * Impact previews of the console (server only): "what would this change do to real tenants?". The registry entries listed in `IMPACT_KEYS` have a preview function here; the
 * route `POST /api/admin/settings/preview` runs it for the staged change set and returns `impacts[]` next to the tier / confirmation requirements, so the review step can say
 * "lowering the SMS cap puts 14 tenants over it this month", "narrowing the countries makes 3 owner phones invalid", "enabling retention purges 1,240 calls in 9 tenants".
 *
 * Read-only: counts only (and at most 10 tenant names), never a phone number, never customer data. The candidate configuration is the CURRENT environment view with the
 * staged values layered on top (`withEnv`), so the numbers are computed by the same functions the metering and the policy use (`smsCapFor`, `isProvisioningAllowed`, ...).
 */
import { configEnv, pinnedByEnv, settingDef, setting } from '@/lib/config';
import { defaultContext, defaultOf } from '@/lib/config/define';
import { prisma } from '@/lib/db/client';
import { isProvisioningAllowed } from '@/lib/db/usage';
import { planRow } from './plan-catalog';
import { listReleaseCandidateStates } from '@/lib/billing/release';
import { logger } from '@/lib/log';
import type { ImpactId, ImpactView } from './ops-model';
import type { SettingChange } from './settings-store';

const log = logger('admin-impact');
const MAX_ROWS = 20_000;

/** The registry keys that have an impact preview (the pure list the UI and the tests read). */
export const IMPACT_KEYS: Record<string, ImpactId> = {
  'billing.plan_sms_cap': 'tenants_over_sms_cap',
  'billing.trial_sms_cap': 'tenants_over_sms_cap',
  'billing.plan_call_minutes_cap': 'tenants_over_ai_cap',
  'billing.trial_call_minutes_cap': 'tenants_over_ai_cap',
  'messaging.sms_allowed_countries': 'owner_phones_invalid',
  'jobs.retention_enabled': 'retention_purge',
  'billing.enforced': 'billing_enforcement',
  'billing.past_due_grace_days': 'past_due_cutoff',
  'jobs.tenant_release_mode': 'tenant_release_candidates',
};

export const hasImpact = (key: string): boolean => key in IMPACT_KEYS;

/** The environment view with `over` layered on top (a hypothetical configuration; nothing is written anywhere). */
export function withEnv(base: NodeJS.ProcessEnv, over: Record<string, string>): NodeJS.ProcessEnv {
  return new Proxy(base, {
    get: (t, p) => (typeof p === 'string' && p in over ? over[p] : Reflect.get(t, p)),
    has: (t, p) => (typeof p === 'string' && p in over) || Reflect.has(t, p),
  });
}

function envText(key: string, value: unknown): { name: string; text: string } | null {
  const def = settingDef(key);
  if (!def?.env) return null;
  if (value === null || value === undefined) return { name: def.env, text: '' };
  if (def.envFormat === 'on_off' && typeof value === 'boolean') return { name: def.env, text: value ? 'on' : 'off' };
  try { return { name: def.env, text: (def.schema as { toText(v: unknown): string }).toText(value) }; } catch { return null; }
}

/** The value a staged change would make effective (a reset takes the registry default). */
function stagedValue(c: SettingChange): unknown {
  const def = settingDef(c.key);
  if (!def) return undefined;
  return c.remove ? defaultOf(def, defaultContext(process.env.NODE_ENV)) : c.value;
}

export interface ImpactDeps { env?: NodeJS.ProcessEnv; now?: Date }

interface Ctx { changes: SettingChange[]; keys: Set<string>; cur: NodeJS.ProcessEnv; cand: NodeJS.ProcessEnv; now: Date; value: (key: string) => unknown }

const view = (key: string, id: ImpactId, count: number, total: number | null, rows: ImpactView['rows'] = [], facts: ImpactView['facts'] = {}): ImpactView => ({ key, id, count, total, rows: rows.slice(0, 10), facts });

async function currentUsage(now: Date) {
  const floor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 86_400_000);
  return prisma.$queryRaw<{ id: string; name: string; plan: string | null; billing_status: string; sms: number; call_s: number; sms_o: number | null; call_o: number | null }[]>`
    SELECT DISTINCT ON (u.business_id) b.id, b.name, b.plan, b.billing_status, u.sms_count AS sms, u.call_seconds AS call_s, b.sms_cap_override AS sms_o, b.call_minutes_cap_override AS call_o
      FROM usage_counters u JOIN businesses b ON b.id = u.business_id WHERE u.period_start >= ${floor}::date ORDER BY u.business_id, u.period_start DESC LIMIT ${MAX_ROWS}`;
}

/**
 * The effective monthly cap of a tenant for a given PLATFORM value: business override, else the plan row (unless the real environment pins the platform variable),
 * else the platform value; trialing tenants are bounded by the trial cap. (`smsCapFor` itself cannot take a hypothetical value: its env-pin test reads the real environment.)
 */
function capWith(field: 'sms_cap' | 'call_minutes_cap', envName: string, r: { plan: string | null; billing_status: string; override: number | null }, platform: number, trial: number): number {
  if (r.override != null) return r.override;
  const planCap = pinnedByEnv(envName) ? undefined : planRow(r.plan)?.[field] ?? undefined;
  const base = planCap ?? platform;
  return r.billing_status === 'trialing' ? Math.min(base, trial) : base;
}
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

async function capImpact(c: Ctx, id: 'tenants_over_sms_cap' | 'tenants_over_ai_cap'): Promise<ImpactView[]> {
  const sms = id === 'tenants_over_sms_cap';
  const [planKey, trialKey, field, envName, planDef, trialDef] = sms
    ? (['billing.plan_sms_cap', 'billing.trial_sms_cap', 'sms_cap', 'PLAN_SMS_CAP', 500, 50] as const)
    : (['billing.plan_call_minutes_cap', 'billing.trial_call_minutes_cap', 'call_minutes_cap', 'PLAN_CALL_MINUTES_CAP', 300, 30] as const);
  const key = [...c.keys].find((k) => IMPACT_KEYS[k] === id) as string;
  const before = { plan: num(setting(planKey), planDef), trial: num(setting(trialKey), trialDef) };
  const after = { plan: num(c.value(planKey), before.plan), trial: num(c.value(trialKey), before.trial) };
  const rows = await currentUsage(c.now);
  const newly = rows.map((r) => {
    const used = sms ? r.sms : Math.floor(r.call_s / 60);
    const subject = { plan: r.plan, billing_status: r.billing_status, override: sms ? r.sms_o : r.call_o };
    return { name: r.name, used, now: capWith(field, envName, subject, before.plan, before.trial), next: capWith(field, envName, subject, after.plan, after.trial) };
  }).filter((r) => r.used >= r.next && r.used < r.now).sort((a, b) => b.used - a.used);
  return [view(key, id, newly.length, rows.length, newly.map((r) => ({ label: r.name, value: r.used })), { period: 'current month' })];
}

async function ownerPhoneImpact(c: Ctx): Promise<ImpactView[]> {
  const next = c.value('messaging.sms_allowed_countries');
  const codes = Array.isArray(next) ? (next as string[]).map(String) : null;
  if (!codes) return [];
  const now = ((setting('messaging.sms_allowed_countries') as string[] | null) ?? ['1']).map(String);
  const rows = await prisma.business.findMany({ where: { ownerPhoneE164: { not: null } }, select: { ownerPhoneE164: true }, take: MAX_ROWS });
  const valid = (e164: string, list: string[]) => list.some((code) => e164.startsWith(`+${code}`));
  const invalid = rows.filter((r) => !valid(r.ownerPhoneE164 as string, codes) && valid(r.ownerPhoneE164 as string, now));
  return [view('messaging.sms_allowed_countries', 'owner_phones_invalid', invalid.length, rows.length, [], { countries_before: now.join(','), countries_after: codes.join(',') })];
}

async function retentionImpact(c: Ctx): Promise<ImpactView[]> {
  if (c.value('jobs.retention_enabled') !== true) return [];
  const [calls, sms, briefings, bookings] = await Promise.all([
    prisma.$queryRaw<{ id: string; name: string; n: number }[]>`SELECT b.id, b.name, count(*)::int AS n FROM calls c JOIN businesses b ON b.id = c.business_id WHERE c.started_at < (${c.now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b.retention_days) GROUP BY b.id, b.name`,
    prisma.$queryRaw<{ id: string; name: string; n: number }[]>`SELECT b.id, b.name, count(*)::int AS n FROM sms_log s JOIN businesses b ON b.id = s.business_id WHERE s.created_at < (${c.now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b.retention_days) GROUP BY b.id, b.name`,
    prisma.$queryRaw<{ id: string; name: string; n: number }[]>`SELECT b.id, b.name, count(*)::int AS n FROM briefings br JOIN businesses b ON b.id = br.business_id WHERE br.created_at < (${c.now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b.retention_days) GROUP BY b.id, b.name`,
    prisma.$queryRaw<{ id: string; name: string; n: number }[]>`SELECT b.id, b.name, count(*)::int AS n FROM bookings bk JOIN businesses b ON b.id = bk.business_id WHERE bk.anonymized_at IS NULL AND bk.scheduled_at < (${c.now}::timestamptz AT TIME ZONE 'UTC') - make_interval(days => b.retention_days) GROUP BY b.id, b.name`,
  ]);
  const per = new Map<string, { name: string; n: number }>();
  for (const list of [calls, sms, briefings, bookings]) for (const r of list) { const e = per.get(r.id) ?? { name: r.name, n: 0 }; e.n += r.n; per.set(r.id, e); }
  const sum = (l: { n: number }[]) => l.reduce((t, r) => t + r.n, 0);
  const rows = [...per.values()].sort((a, b) => b.n - a.n).map((e) => ({ label: e.name, value: e.n }));
  return [view('jobs.retention_enabled', 'retention_purge', sum(calls) + sum(sms) + sum(briefings) + sum(bookings), per.size, rows, { calls: sum(calls), texts: sum(sms), briefings: sum(briefings), bookings_anonymized: sum(bookings), tenants: per.size })];
}

async function billingImpact(c: Ctx): Promise<ImpactView[]> {
  const turnedOn = c.value('billing.enforced') === true;
  const keys = [...c.keys].filter((k) => IMPACT_KEYS[k] === 'billing_enforcement');
  if (!keys.length || !turnedOn) return [];
  const rows = await prisma.business.findMany({ where: { status: 'live' }, select: { name: true, billingStatus: true, pastDueSince: true, suspendedAt: true }, take: MAX_ROWS });
  const refused = rows.filter((r) => {
    const b = { billing_status: r.billingStatus as never, past_due_since: r.pastDueSince?.toISOString() ?? null, suspended_at: r.suspendedAt?.toISOString() ?? null };
    return isProvisioningAllowed(b, c.now, c.cur) && !isProvisioningAllowed(b, c.now, c.cand);
  });
  const byStatus = new Map<string, number>();
  for (const r of refused) byStatus.set(r.billingStatus, (byStatus.get(r.billingStatus) ?? 0) + 1);
  return [view('billing.enforced', 'billing_enforcement', refused.length, rows.length, [...byStatus.entries()].map(([label, value]) => ({ label, value })), { live_tenants: rows.length })];
}

async function pastDueImpact(c: Ctx): Promise<ImpactView[]> {
  const rows = await prisma.business.findMany({ where: { billingStatus: 'past_due' }, select: { name: true, pastDueSince: true, suspendedAt: true }, take: MAX_ROWS });
  const cut = rows.filter((r) => {
    const b = { billing_status: 'past_due' as never, past_due_since: r.pastDueSince?.toISOString() ?? null, suspended_at: r.suspendedAt?.toISOString() ?? null };
    return isProvisioningAllowed(b, c.now, c.cur) && !isProvisioningAllowed(b, c.now, c.cand);
  });
  return [view('billing.past_due_grace_days', 'past_due_cutoff', cut.length, rows.length, cut.map((r) => ({ label: r.name, value: r.pastDueSince ? Math.floor((c.now.getTime() - r.pastDueSince.getTime()) / 86_400_000) : 0 })), {})];
}

async function releaseImpact(c: Ctx): Promise<ImpactView[]> {
  const mode = c.value('jobs.tenant_release_mode');
  if (mode !== 'on' && mode !== 'report') return [];
  const states = await listReleaseCandidateStates(c.now);
  return [view('jobs.tenant_release_mode', 'tenant_release_candidates', states.length, null, [], { mode: String(mode), acts: mode === 'on', stuck: states.filter((s) => s.stuck).length })];
}

const RUN: Record<ImpactId, (c: Ctx) => Promise<ImpactView[]>> = {
  tenants_over_sms_cap: (c) => capImpact(c, 'tenants_over_sms_cap'), tenants_over_ai_cap: (c) => capImpact(c, 'tenants_over_ai_cap'), owner_phones_invalid: ownerPhoneImpact, retention_purge: retentionImpact,
  billing_enforcement: billingImpact, past_due_cutoff: pastDueImpact, tenant_release_candidates: releaseImpact,
};

/** Impact previews of a staged change set (secrets and keys without a preview are skipped). Never throws: a failing preview is omitted, the review still works. */
export async function impactsFor(changes: readonly SettingChange[], deps: ImpactDeps = {}): Promise<ImpactView[]> {
  const live = changes.filter((c) => typeof c.secret !== 'string' && hasImpact(c.key));
  if (live.length === 0) return [];
  const cur = deps.env ?? configEnv();
  const over: Record<string, string> = {};
  const values = new Map<string, unknown>();
  for (const c of changes) {
    if (typeof c.secret === 'string') continue;
    const v = stagedValue(c);
    values.set(c.key, v);
    const e = envText(c.key, v);
    if (e && e.text !== '') over[e.name] = e.text;
  }
  const ctx: Ctx = { changes: live as SettingChange[], keys: new Set(live.map((c) => c.key)), cur, cand: withEnv(cur, over), now: deps.now ?? new Date(), value: (k) => (values.has(k) ? values.get(k) : setting(k as never)) };
  const ids = [...new Set(live.map((c) => IMPACT_KEYS[c.key]))];
  const out: ImpactView[] = [];
  for (const id of ids) {
    try { out.push(...(await RUN[id](ctx))); } catch (err) { log.warn('impact_failed', { id, error: (err as Error).message }); }
  }
  return out;
}
