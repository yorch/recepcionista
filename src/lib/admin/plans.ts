/**
 * Plans (table `plans`; businesses.plan references plans.key). Node runtime only. Every write bumps settings_state.global_version in the same transaction, so the
 * plan catalog (src/lib/admin/plan-catalog.ts, read synchronously by the cap helpers) refreshes on every instance within one poll.
 *
 * Caps: a NULL cap inherits the platform setting (billing.plan_sms_cap ...); the precedence is business override > environment pin > plan row > platform
 * setting > default (src/lib/db/usage.ts). Features: {feature: boolean}; a missing feature is ENABLED (today's behaviour).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { loaderStarted, refreshNow } from './loader';
import { PLAN_FEATURES } from './plan-catalog';
import { roleCan } from './permissions';
import { assertSettingsWritable, MAX_REASON, MIN_REASON, SettingsError, type StoreActor } from './settings-store';

export const PLAN_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const CAP_MAX = 10_000_000;

export interface PlanInput {
  key?: string;
  name?: string;
  public?: boolean;
  is_comped?: boolean;
  stripe_price_id?: string | null;
  stripe_price_id_annual?: string | null;
  trial_days?: number | null;
  sms_cap?: number | null;
  call_minutes_cap?: number | null;
  voicemail_minutes_cap?: number | null;
  forward_minutes_cap?: number | null;
  max_locations?: number | null;
  features?: Record<string, boolean>;
  sort?: number;
}
export interface PlanView extends Required<Omit<PlanInput, 'features'>> { features: Record<string, boolean>; archived_at: string | null; created_at: string; updated_at: string; updated_by: string | null; businesses: number }

const INT_FIELDS: Record<string, [number, number]> = { trial_days: [0, 365], sms_cap: [0, CAP_MAX], call_minutes_cap: [0, CAP_MAX], voicemail_minutes_cap: [0, CAP_MAX], forward_minutes_cap: [0, CAP_MAX], max_locations: [1, 1000] };
const KNOWN = new Set(['key', 'name', 'public', 'is_comped', 'stripe_price_id', 'stripe_price_id_annual', 'features', 'sort', ...Object.keys(INT_FIELDS)]);

/** Validate a (possibly partial) plan. Returns the prisma data fragment or the problems; unknown fields are an error (no silent drops). */
export function validatePlanInput(input: unknown, opts: { partial: boolean }): { ok: true; data: Prisma.PlanUncheckedUpdateInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['body must be an object'] };
  const i = input as Record<string, unknown>;
  for (const k of Object.keys(i)) if (!KNOWN.has(k)) errors.push(`unknown field "${k}"`);
  const data: Record<string, unknown> = {};
  if (i.name !== undefined) { if (typeof i.name !== 'string' || !i.name.trim() || i.name.length > 80) errors.push('name must be 1-80 characters'); else data.name = i.name.trim(); } else if (!opts.partial) errors.push('name is required');
  for (const b of ['public', 'is_comped'] as const) if (i[b] !== undefined) { if (typeof i[b] !== 'boolean') errors.push(`${b} must be true or false`); else data[b === 'is_comped' ? 'isComped' : b] = i[b]; }
  for (const [f, [lo, hi]] of Object.entries(INT_FIELDS)) {
    if (i[f] === undefined) continue;
    const camel = f.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    if (i[f] === null) data[camel] = null;
    else if (typeof i[f] !== 'number' || !Number.isInteger(i[f]) || (i[f] as number) < lo || (i[f] as number) > hi) errors.push(`${f} must be a whole number from ${lo} to ${hi}, or null`);
    else data[camel] = i[f];
  }
  for (const f of ['stripe_price_id', 'stripe_price_id_annual'] as const) {
    if (i[f] === undefined) continue;
    const camel = f === 'stripe_price_id' ? 'stripePriceId' : 'stripePriceIdAnnual';
    if (i[f] === null || i[f] === '') data[camel] = null;
    else if (typeof i[f] !== 'string' || !/^price_[A-Za-z0-9_]{4,80}$/.test(i[f] as string)) errors.push(`${f} must look like price_...`);
    else data[camel] = i[f];
  }
  if (i.sort !== undefined) { if (typeof i.sort !== 'number' || !Number.isInteger(i.sort) || i.sort < 0 || i.sort > 100_000) errors.push('sort must be a whole number'); else data.sort = i.sort; }
  if (i.features !== undefined) {
    const f = i.features;
    if (!f || typeof f !== 'object' || Array.isArray(f)) errors.push('features must be an object of {feature: boolean}');
    else {
      for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
        if (!(PLAN_FEATURES as readonly string[]).includes(k)) errors.push(`unknown feature "${k}"`);
        else if (typeof v !== 'boolean') errors.push(`feature ${k} must be true or false`);
      }
      data.features = f;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, data: data as Prisma.PlanUncheckedUpdateInput };
}

type Row = Awaited<ReturnType<typeof prisma.plan.findMany>>[number];
const view = (r: Row, businesses = 0): PlanView => ({
  key: r.key, name: r.name, public: r.public, is_comped: r.isComped, stripe_price_id: r.stripePriceId, stripe_price_id_annual: r.stripePriceIdAnnual, trial_days: r.trialDays, sms_cap: r.smsCap,
  call_minutes_cap: r.callMinutesCap, voicemail_minutes_cap: r.voicemailMinutesCap, forward_minutes_cap: r.forwardMinutesCap, max_locations: r.maxLocations,
  features: (r.features ?? {}) as Record<string, boolean>, sort: r.sort, archived_at: r.archivedAt?.toISOString() ?? null, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString(),
  updated_by: r.updatedBy, businesses,
});

export async function listPlans(opts: { includeArchived?: boolean } = {}): Promise<PlanView[]> {
  const rows = await prisma.plan.findMany({ where: opts.includeArchived ? {} : { archivedAt: null }, orderBy: [{ sort: 'asc' }, { key: 'asc' }] });
  const counts = await prisma.business.groupBy({ by: ['plan'], where: { plan: { in: rows.map((r) => r.key) } }, _count: { _all: true } });
  const n = new Map(counts.map((c) => [c.plan as string, c._count._all]));
  return rows.map((r) => view(r, n.get(r.key) ?? 0));
}
export async function getPlan(key: string): Promise<PlanView | null> {
  const r = await prisma.plan.findUnique({ where: { key } });
  return r ? view(r, await prisma.business.count({ where: { plan: key } })) : null;
}

const needReason = (reason: string | undefined): string => {
  const r = (reason ?? '').trim();
  if (r.length < MIN_REASON || r.length > MAX_REASON) throw new SettingsError(422, 'reason_required', `a reason of ${MIN_REASON} to ${MAX_REASON} characters is required`);
  return r;
};
const needPerm = (a: StoreActor) => { if (a.role !== 'system' && !roleCan(a.role, 'plans.write')) throw new SettingsError(403, 'forbidden', 'not allowed to change plans'); };

async function bump(tx: Prisma.TransactionClient): Promise<number> {
  await tx.$executeRaw`INSERT INTO settings_state (id, global_version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;
  const rows = await tx.$queryRaw<{ global_version: bigint }[]>`UPDATE settings_state SET global_version = global_version + 1, updated_at = now() WHERE id = 1 RETURNING global_version`;
  return Number(rows[0].global_version);
}

async function audit(tx: Prisma.TransactionClient, actor: StoreActor, action: string, key: string, meta: Record<string, unknown>) {
  await tx.auditEvent.create({ data: auditRowData({ actor_kind: actor.kind, actor_user_id: actor.user_id, action, target: `plan:${key}`, ip: actor.ip, meta: { ...meta, role: actor.role, via: actor.via }, meta_trusted: true }) });
}

export async function createPlan(input: unknown, opts: { actor: StoreActor; reason: string }): Promise<PlanView> {
  needPerm(opts.actor);
  await assertSettingsWritable();
  const reason = needReason(opts.reason);
  const key = (input as { key?: unknown })?.key;
  if (typeof key !== 'string' || !PLAN_KEY_RE.test(key)) throw new SettingsError(422, 'invalid_plan', 'key must be 1-60 characters: lowercase letters, digits, - and _');
  const { key: _k, ...rest } = input as Record<string, unknown>; void _k;
  const v = validatePlanInput(rest, { partial: false });
  if (!v.ok) throw new SettingsError(422, 'invalid_plan', v.errors[0], v.errors.map((m) => ({ key, code: 'invalid_plan', message: m })));
  const row = await prisma.$transaction(async (tx) => {
    if (await tx.plan.findUnique({ where: { key } })) throw new SettingsError(409, 'exists', 'a plan with this key already exists');
    const created = await tx.plan.create({ data: { ...(v.data as Prisma.PlanUncheckedCreateInput), key, name: (v.data as { name: string }).name, updatedBy: opts.actor.user_id } });
    const version = await bump(tx);
    await audit(tx, opts.actor, 'plans.create', key, { reason, version, plan: view(created) });
    return created;
  });
  if (loaderStarted()) await refreshNow();
  return view(row);
}

export async function updatePlan(key: string, patch: unknown, opts: { actor: StoreActor; reason: string }): Promise<PlanView> {
  needPerm(opts.actor);
  await assertSettingsWritable();
  const reason = needReason(opts.reason);
  const v = validatePlanInput(patch, { partial: true });
  if (!v.ok) throw new SettingsError(422, 'invalid_plan', v.errors[0], v.errors.map((m) => ({ key, code: 'invalid_plan', message: m })));
  if (Object.keys(v.data).length === 0) throw new SettingsError(422, 'nothing_to_change', 'no fields to change');
  const row = await prisma.$transaction(async (tx) => {
    const before = await tx.plan.findUnique({ where: { key } });
    if (!before) throw new SettingsError(404, 'not_found', 'plan not found');
    const after = await tx.plan.update({ where: { key }, data: { ...v.data, updatedAt: new Date(), updatedBy: opts.actor.user_id } });
    const version = await bump(tx);
    await audit(tx, opts.actor, 'plans.update', key, { reason, version, before: view(before), after: view(after) });
    return after;
  });
  if (loaderStarted()) await refreshNow();
  return view(row, await prisma.business.count({ where: { plan: key } }));
}

export async function setPlanArchived(key: string, archived: boolean, opts: { actor: StoreActor; reason: string }): Promise<PlanView> {
  needPerm(opts.actor);
  await assertSettingsWritable();
  const reason = needReason(opts.reason);
  const row = await prisma.$transaction(async (tx) => {
    if (!(await tx.plan.findUnique({ where: { key } }))) throw new SettingsError(404, 'not_found', 'plan not found');
    const after = await tx.plan.update({ where: { key }, data: { archivedAt: archived ? new Date() : null, updatedAt: new Date(), updatedBy: opts.actor.user_id } });
    const version = await bump(tx);
    await audit(tx, opts.actor, archived ? 'plans.archive' : 'plans.unarchive', key, { reason, version });
    return after;
  });
  if (loaderStarted()) await refreshNow();
  return view(row);
}

/** Delete a plan nobody uses. A plan in use must be archived (businesses keep working on it). */
export async function deletePlan(key: string, opts: { actor: StoreActor; reason: string }): Promise<void> {
  needPerm(opts.actor);
  await assertSettingsWritable();
  const reason = needReason(opts.reason);
  await prisma.$transaction(async (tx) => {
    const row = await tx.plan.findUnique({ where: { key } });
    if (!row) throw new SettingsError(404, 'not_found', 'plan not found');
    if (key === 'standard') throw new SettingsError(409, 'protected_plan', 'the standard plan cannot be deleted (archive it)');
    const used = await tx.business.count({ where: { plan: key } });
    if (used > 0) throw new SettingsError(409, 'in_use', `${used} business(es) are on this plan: archive it instead`);
    await tx.plan.delete({ where: { key } });
    const version = await bump(tx);
    await audit(tx, opts.actor, 'plans.delete', key, { reason, version, plan: view(row) });
  });
  if (loaderStarted()) await refreshNow();
}

/** Import: upsert the documents inside the caller's transaction (version already bumped by the change set). */
export async function upsertPlansInTx(tx: Prisma.TransactionClient, docs: Record<string, unknown>[], actor: StoreActor, version: number): Promise<void> {
  for (const d of docs) {
    const key = d?.key;
    if (typeof key !== 'string' || !PLAN_KEY_RE.test(key)) throw new SettingsError(422, 'invalid_plan', 'every imported plan needs a valid key');
    const { key: _k, archived_at: archivedAt, ...rest } = d; void _k;
    const v = validatePlanInput(rest, { partial: true });
    if (!v.ok) throw new SettingsError(422, 'invalid_plan', `${key}: ${v.errors[0]}`);
    const exists = await tx.plan.findUnique({ where: { key } });
    const archived = typeof archivedAt === 'string' ? new Date(archivedAt) : null;
    if (exists) await tx.plan.update({ where: { key }, data: { ...v.data, archivedAt: archived, updatedAt: new Date(), updatedBy: actor.user_id } });
    else await tx.plan.create({ data: { ...(v.data as Prisma.PlanUncheckedCreateInput), key, name: (v.data as { name?: string }).name ?? key, archivedAt: archived, updatedBy: actor.user_id } });
    await audit(tx, actor, exists ? 'plans.update' : 'plans.create', key, { via_import: true, version });
  }
}

/** Plan-only import (no settings in the document): its own transaction and version bump. Returns the new version. */
export async function applyPlansDoc(docs: Record<string, unknown>[], actor: StoreActor, reason: string | undefined): Promise<number> {
  needPerm(actor);
  needReason(reason);
  const version = await prisma.$transaction(async (tx) => {
    const v = await bump(tx);
    await upsertPlansInTx(tx, docs, actor, v);
    return v;
  });
  if (loaderStarted()) await refreshNow();
  return version;
}
