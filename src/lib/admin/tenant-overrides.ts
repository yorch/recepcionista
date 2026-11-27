/**
 * Per-tenant overrides of `platform+tenant` registry keys (D6, table tenant_setting_overrides). Node runtime only.
 *
 *   effective(tenant, key) = clamp(tenant_override ?? platform_effective, min, max)
 *
 * - The registry decides WHO may write a key: `tenant.editableBy: 'owner'` keys are the owner's comfort knobs (D12: quiet hours stricter than the platform, briefing on/off
 *   and hour, thank-you toggle, ring seconds within bounds); everything else (caps, budgets, features) is platform-only and writable only through /api/admin/*.
 * - The server clamps: a write outside [min, max] is refused (422 out_of_bounds) and a stored value is clamped again at READ time, so tightening a platform bound later
 *   takes effect without touching the rows. `stricter_than_platform` (quiet hours) is re-checked at read as well: a window that no longer covers the platform's is ignored.
 * - An environment pin sets the platform value; overrides still apply on top unless the registry marks `envPinBlocksOverrides`.
 * - Every write is audited as `settings.tenant_override` with the business id; a suspended/missing business is a 404.
 */
import { Prisma } from '@prisma/client';
import { pinnedByEnv, setting } from '@/lib/config';
import { settingDef } from '@/lib/config/registry';
import type { SettingDef } from '@/lib/config/types';
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { roleCan, type AdminRole } from './permissions';
import { assertSettingsWritable, auditValue, SettingsError } from './settings-store';

export interface OverrideActor {
  kind: 'user' | 'admin_token';
  user_id: string | null;
  ip?: string | null;
  /** owner: a tenant owner through /api/businesses/[id]/settings-overrides (comfort knobs only). platform: an admin through /api/admin/*. */
  scope: 'owner' | 'platform';
  /** Platform scope: the admin's role (checked here as well as in the route). */
  role?: AdminRole;
  /** Platform scope, support role: the open write grant that authorises this write (tenants.support_enter). */
  support_grant_id?: string | null;
}

export interface Bounds { min: number | null; max: number | null }

const QUIET_START = 'messaging.quiet_start_hour';
const QUIET_END = 'messaging.quiet_end_hour';
const isNumeric = (def: SettingDef): boolean => def.schema.type === 'int';

/** The tenant-writable bounds of a numeric key: the tighter of the registry tenant rule and the platform schema. */
export function boundsOf(def: SettingDef): Bounds {
  const info = def.schema.info as { min?: number; max?: number };
  const lo = [def.tenant?.min, info.min].filter((x): x is number => typeof x === 'number');
  const hi = [def.tenant?.max, info.max].filter((x): x is number => typeof x === 'number');
  return { min: lo.length ? Math.max(...lo) : null, max: hi.length ? Math.min(...hi) : null };
}

export const clampTo = (n: number, b: Bounds): number => Math.min(b.max ?? Number.POSITIVE_INFINITY, Math.max(b.min ?? Number.NEGATIVE_INFINITY, n));

/** Hours (0-23) inside the quiet window [start, end), wrapping midnight. start === end is an empty window. */
export function quietHoursSet(start: number, end: number): Set<number> {
  const out = new Set<number>();
  for (let h = 0; h < 24; h++) if (start < end ? h >= start && h < end : start > end ? h >= start || h < end : false) out.add(h);
  return out;
}
/** Does the candidate quiet window cover EVERY quiet hour of the platform window (it may only be stricter)? */
export const quietIsStricter = (cs: number, ce: number, ps: number, pe: number): boolean => {
  const cand = quietHoursSet(cs, ce);
  for (const h of quietHoursSet(ps, pe)) if (!cand.has(h)) return false;
  return true;
};

export interface OverrideProblem { code: 'not_tenant_key' | 'invalid_value' | 'out_of_bounds' | 'not_stricter' | 'platform_only' | 'locked_by_env'; message: string; bounds?: Bounds }

/** Validate a candidate override. `others`: the tenant's other overrides (quiet hours are a pair). Returns the typed value or the problem. */
export function validateOverride(def: SettingDef | undefined, value: unknown, others: Record<string, unknown> = {}): { ok: true; value: unknown } | { ok: false; problem: OverrideProblem } {
  if (!def || def.scope !== 'platform+tenant' || !def.tenant) return { ok: false, problem: { code: 'not_tenant_key', message: 'this setting cannot be overridden per tenant' } };
  const chk = def.schema.check(value);
  if (!chk.ok) return { ok: false, problem: { code: 'invalid_value', message: chk.error } };
  if (isNumeric(def)) {
    const b = boundsOf(def);
    const n = chk.value as number;
    if ((b.min !== null && n < b.min) || (b.max !== null && n > b.max)) return { ok: false, problem: { code: 'out_of_bounds', message: `must be between ${b.min ?? '-'} and ${b.max ?? '-'}`, bounds: b } };
  }
  if (def.tenant.rule === 'stricter_than_platform' && (def.key === QUIET_START || def.key === QUIET_END)) {
    const ps = setting(QUIET_START) as number, pe = setting(QUIET_END) as number;
    const cs = def.key === QUIET_START ? (chk.value as number) : ((others[QUIET_START] as number | undefined) ?? ps);
    const ce = def.key === QUIET_END ? (chk.value as number) : ((others[QUIET_END] as number | undefined) ?? pe);
    if (!quietIsStricter(cs, ce, ps, pe)) return { ok: false, problem: { code: 'not_stricter', message: 'quiet hours may only be made stricter than the platform window (they must cover it entirely)' } };
  }
  return { ok: true, value: chk.value };
}

export interface EffectiveValue { key: string; value: unknown; source: 'tenant' | 'platform'; platform: unknown; override: unknown | null; clamped: boolean; ignored_override: boolean }

/** Pure: the effective value from the platform value and the stored overrides of ONE tenant (read-time clamp and re-validation). */
export function effectiveFor(def: SettingDef, overrides: Record<string, unknown>, env?: NodeJS.ProcessEnv): EffectiveValue {
  const platform = setting(def.key as never);
  const base: EffectiveValue = { key: def.key, value: platform, source: 'platform', platform, override: null, clamped: false, ignored_override: false };
  const raw = overrides[def.key];
  if (raw === undefined || raw === null) return base;
  const pinBlocks = Boolean(def.tenant?.envPinBlocksOverrides && def.env && pinnedByEnv(def.env, env));
  if (pinBlocks) return { ...base, override: raw, ignored_override: true };
  const chk = def.schema.check(raw);
  if (!chk.ok) return { ...base, override: raw, ignored_override: true };
  let v = chk.value;
  let clamped = false;
  if (isNumeric(def)) { const c = clampTo(v as number, boundsOf(def)); clamped = c !== v; v = c; }
  if (def.tenant?.rule === 'stricter_than_platform' && (def.key === QUIET_START || def.key === QUIET_END)) {
    const ps = setting(QUIET_START) as number, pe = setting(QUIET_END) as number;
    const cs = def.key === QUIET_START ? (v as number) : ((overrides[QUIET_START] as number | undefined) ?? ps);
    const ce = def.key === QUIET_END ? (v as number) : ((overrides[QUIET_END] as number | undefined) ?? pe);
    if (!quietIsStricter(cs, ce, ps, pe)) return { ...base, override: raw, ignored_override: true };
  }
  return { key: def.key, value: v, source: 'tenant', platform, override: raw, clamped, ignored_override: false };
}

async function loadOverrides(businessId: string): Promise<Record<string, unknown>> {
  const rows = await prisma.tenantSettingOverride.findMany({ where: { businessId } });
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** effective(tenant, key) for one key (one indexed read). */
export async function tenantEffective(businessId: string, key: string): Promise<EffectiveValue> {
  const def = settingDef(key);
  if (!def || def.scope !== 'platform+tenant') throw new SettingsError(404, 'not_tenant_key', 'this setting cannot be overridden per tenant');
  return effectiveFor(def, await loadOverrides(businessId));
}

export interface TenantKnob {
  key: string; label: string; help: string; kind: SettingDef['kind']; unit: SettingDef['unit'] | null; editable_by: 'owner' | 'platform';
  rule: 'within_bounds' | 'stricter_than_platform' | null; bounds: Bounds | null; platform_value: unknown; override: unknown | null; effective: unknown; source: 'tenant' | 'platform';
  ignored_override: boolean; locked_by_env: boolean;
}

/** The overridable keys of a tenant. `scope: 'owner'` lists the owner's comfort knobs only. */
export async function listTenantKnobs(businessId: string, scope: 'owner' | 'platform'): Promise<TenantKnob[]> {
  const { allSettings } = await import('@/lib/config/registry');
  const overrides = await loadOverrides(businessId);
  return allSettings().filter((d) => d.scope === 'platform+tenant' && d.tenant && (scope === 'platform' || d.tenant.editableBy === 'owner')).map((d) => {
    const e = effectiveFor(d, overrides);
    return {
      key: d.key, label: d.label, help: d.help, kind: d.kind, unit: d.unit ?? null, editable_by: d.tenant!.editableBy, rule: d.tenant!.rule ?? null, bounds: isNumeric(d) ? boundsOf(d) : null,
      platform_value: e.platform, override: e.override, effective: e.value, source: e.source, ignored_override: e.ignored_override,
      locked_by_env: Boolean(d.tenant!.envPinBlocksOverrides && d.env && pinnedByEnv(d.env)),
    };
  });
}

function authorise(actor: OverrideActor, def: SettingDef | undefined): void {
  if (!def || def.scope !== 'platform+tenant' || !def.tenant) throw new SettingsError(404, 'not_tenant_key', 'this setting cannot be overridden per tenant');
  if (actor.scope === 'owner') {
    if (def.tenant.editableBy !== 'owner') throw new SettingsError(403, 'platform_only', 'only the platform can change this setting for a tenant');
    return;
  }
  const role = actor.role;
  if (!role || !(roleCan(role, 'tenants.overrides.write') || (role === 'support' && actor.support_grant_id))) throw new SettingsError(403, 'forbidden', 'not allowed to change tenant settings');
}

async function ensureBusiness(businessId: string): Promise<void> {
  if (!(await prisma.business.findUnique({ where: { id: businessId }, select: { id: true } }))) throw new SettingsError(404, 'not_found', 'business not found');
}

export async function setTenantOverride(opts: { business_id: string; key: string; value: unknown; actor: OverrideActor; reason?: string }): Promise<EffectiveValue> {
  const def = settingDef(opts.key);
  authorise(opts.actor, def);
  await assertSettingsWritable();
  await ensureBusiness(opts.business_id);
  if (def!.tenant!.envPinBlocksOverrides && def!.env && pinnedByEnv(def!.env)) throw new SettingsError(409, 'locked_by_env', 'the platform value is pinned by the environment and blocks overrides');
  const others = await loadOverrides(opts.business_id);
  const v = validateOverride(def, opts.value, others);
  if (!v.ok) throw new SettingsError(422, v.problem.code, v.problem.message, [{ key: opts.key, code: v.problem.code, message: v.problem.message }]);
  const old = others[opts.key];
  if (JSON.stringify(old) !== JSON.stringify(v.value)) {
    await prisma.$transaction(async (tx) => {
      await tx.tenantSettingOverride.upsert({
        where: { businessId_key: { businessId: opts.business_id, key: opts.key } },
        create: { businessId: opts.business_id, key: opts.key, value: v.value as Prisma.InputJsonValue, updatedBy: opts.actor.user_id },
        update: { value: v.value as Prisma.InputJsonValue, updatedBy: opts.actor.user_id, updatedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: auditRowData({
          actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, business_id: opts.business_id, action: 'settings.tenant_override', target: `setting:${opts.key}`, ip: opts.actor.ip,
          meta: { key: opts.key, old: old === undefined ? null : auditValue(def!, old), new: auditValue(def!, v.value), scope: opts.actor.scope, role: opts.actor.role ?? 'owner', support_grant_id: opts.actor.support_grant_id ?? null, reason: opts.reason?.slice(0, MAX) ?? null },
          meta_trusted: true,
        }),
      });
    });
  }
  return effectiveFor(def!, { ...others, [opts.key]: v.value });
}
const MAX = 500;

export async function removeTenantOverride(opts: { business_id: string; key: string; actor: OverrideActor; reason?: string }): Promise<EffectiveValue> {
  const def = settingDef(opts.key);
  authorise(opts.actor, def);
  await assertSettingsWritable();
  await ensureBusiness(opts.business_id);
  const others = await loadOverrides(opts.business_id);
  if (others[opts.key] !== undefined) {
    await prisma.$transaction(async (tx) => {
      await tx.tenantSettingOverride.deleteMany({ where: { businessId: opts.business_id, key: opts.key } });
      await tx.auditEvent.create({
        data: auditRowData({
          actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, business_id: opts.business_id, action: 'settings.tenant_override_removed', target: `setting:${opts.key}`, ip: opts.actor.ip,
          meta: { key: opts.key, old: auditValue(def!, others[opts.key]), scope: opts.actor.scope, role: opts.actor.role ?? 'owner', support_grant_id: opts.actor.support_grant_id ?? null, reason: opts.reason?.slice(0, MAX) ?? null },
          meta_trusted: true,
        }),
      });
    });
    delete others[opts.key];
  }
  return effectiveFor(def!, others);
}
