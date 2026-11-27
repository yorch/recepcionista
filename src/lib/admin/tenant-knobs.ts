/**
 * Readers of the per-tenant knobs (registry `platform+tenant` keys): `effective(tenant, key) = clamp(override ?? platform value, min, max)`, evaluated by
 * `effectiveFor` (tenant-overrides.ts). These helpers are the ONE place the feature code asks "what is the value for THIS business": they never throw
 * (a database failure answers with the platform value, which is today's behaviour) and cost one indexed read of the tenant's override rows.
 * Node runtime only.
 */
import { setting } from '@/lib/config';
import { settingDef } from '@/lib/config/registry';
import { prisma } from '@/lib/db/client';
import { effectiveFor } from './tenant-effective';

type Overrides = Record<string, unknown>;

/** The stored overrides of one business (empty on failure or without a business). */
export async function loadTenantOverrides(businessId: string | null | undefined): Promise<Overrides> {
  if (!businessId) return {};
  try {
    const rows = await prisma.tenantSettingOverride.findMany({ where: { businessId } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

/** The overrides of many businesses in one query (jobs that sweep every tenant). Empty maps on failure. */
export async function loadTenantOverridesMany(businessIds: readonly string[]): Promise<Map<string, Overrides>> {
  const out = new Map<string, Overrides>();
  if (businessIds.length === 0) return out;
  try {
    const rows = await prisma.tenantSettingOverride.findMany({ where: { businessId: { in: [...businessIds] } } });
    for (const r of rows) { const o = out.get(r.businessId) ?? {}; o[r.key] = r.value; out.set(r.businessId, o); }
  } catch { /* the platform values apply */ }
  return out;
}

/** Effective value of one tenant knob from already loaded overrides (pure). Unknown keys read the platform setting. */
export function knobFrom<T>(key: string, overrides: Overrides): T {
  const def = settingDef(key);
  if (!def || def.scope !== 'platform+tenant') return setting(key as never) as T;
  return effectiveFor(def, overrides).value as T;
}

/** Effective value of one tenant knob (one read). */
export async function tenantKnob<T>(businessId: string | null | undefined, key: string): Promise<T> {
  return knobFrom<T>(key, await loadTenantOverrides(businessId));
}

export interface QuietWindow { start: number; end: number }

/** The quiet-hours window of a business: the platform window, or the tenant's stricter one (re-validated at read time). */
export async function quietWindowFor(businessId: string | null | undefined): Promise<QuietWindow> {
  const o = await loadTenantOverrides(businessId);
  return { start: knobFrom<number>('messaging.quiet_start_hour', o), end: knobFrom<number>('messaging.quiet_end_hour', o) };
}

/**
 * The value a feature reader should use for THIS business: the tenant's override (validated, clamped to the registry bounds) when it has one that
 * applies, else `base` (the caller's own platform value: env > console > default, so existing readers keep their exact behaviour).
 */
export async function knobOr<T extends number | boolean>(businessId: string | null | undefined, key: string, base: T): Promise<T> {
  const o = await loadTenantOverrides(businessId);
  return knobOrFrom(key, o, base);
}

export function knobOrFrom<T extends number | boolean>(key: string, overrides: Overrides, base: T): T {
  const def = settingDef(key);
  if (!def || def.scope !== 'platform+tenant' || overrides[key] === undefined || overrides[key] === null) return base;
  const e = effectiveFor(def, overrides);
  return e.source === 'tenant' && typeof e.value === typeof base ? (e.value as T) : base;
}
