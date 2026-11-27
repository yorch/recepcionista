/**
 * The PURE half of the tenant overrides: bounds, the quiet-hours rule and `effectiveFor` (the effective value of one `platform+tenant` key from the stored overrides of ONE tenant).
 * No database, no store: the cap readers of src/lib/db/usage.ts import it without pulling in the settings store.
 *
 *   effective = clamp(override ?? platform value, min, max); an owner-editable BOOLEAN is `platform && override` (an owner may switch a feature OFF, never ON when the platform has it off).
 */
import { pinnedByEnv, setting } from '@/lib/config';
import type { SettingDef } from '@/lib/config/types';

export const QUIET_START = 'messaging.quiet_start_hour';
export const QUIET_END = 'messaging.quiet_end_hour';
export const isNumeric = (def: SettingDef): boolean => def.schema.type === 'int';
/** An owner-editable on/off knob: the owner can only switch it OFF (effective = platform && override). */
export const isOwnerSwitch = (def: SettingDef): boolean => def.kind === 'bool' && def.tenant?.editableBy === 'owner';

export interface Bounds { min: number | null; max: number | null }

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
  if (isOwnerSwitch(def) && chk.value === true && platform === false) return { ...base, override: raw, ignored_override: true }; // an owner cannot switch ON what the platform turned off
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

