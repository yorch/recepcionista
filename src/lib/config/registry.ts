/**
 * THE settings registry: single source of truth for every platform setting (24e 5.1). Assembled from registry-env.ts (what is an
 * environment variable today) and registry-promoted.ts (constants promoted from code, plus the missing brand / legal / platform controls).
 * Shared by the server, the proxy bundle and (Phase 3) the console forms. Pure: no I/O.
 */
import { ENV_SETTINGS } from './registry-env';
import { PROMOTED_SETTINGS } from './registry-promoted';
import type { SettingClass, SettingDef } from './types';

export { defineSetting, defaultOf, defaultContext, ratchetAllows } from './define';
export { s } from './schema';
export type { SettingDef, SettingInput, SettingKind, SettingClass, SettingGroup, Tier, Applies, FollowUp, Ratchet, TenantRule, DefaultContext, EnvOnlyEntry, RetiredEnvEntry } from './types';
export { ENV_ONLY, BUILD_TIME_ENV, RETIRED_ENV } from './env-only';

export const SETTINGS = [...ENV_SETTINGS, ...PROMOTED_SETTINGS] as const;
export type AnySetting = (typeof SETTINGS)[number];
export type SettingKey = AnySetting['key'];

/** The value type of a key (`T` of its `SettingDef<T>`). */
export type SettingValue<K extends SettingKey> = Extract<AnySetting, { key: K }> extends SettingDef<infer T> ? T : never;

const byKey = new Map<string, SettingDef>();
const byEnv = new Map<string, SettingDef>();
for (const def of SETTINGS as readonly SettingDef[]) {
  if (byKey.has(def.key)) throw new Error(`registry: duplicate key ${def.key}`);
  byKey.set(def.key, def);
  if (def.env) {
    if (byEnv.has(def.env)) throw new Error(`registry: duplicate env alias ${def.env}`);
    byEnv.set(def.env, def);
  }
}

export const settingDef = (key: string): SettingDef | undefined => byKey.get(key);
export const settingByEnv = (env: string): SettingDef | undefined => byEnv.get(env);
export const allSettings = (): readonly SettingDef[] => SETTINGS as readonly SettingDef[];
export const envAliases = (): string[] => [...byEnv.keys()];

/** Registry size by class (SETTING_IN_ADMIN / SECRET / PROVIDER_ID) and by origin (env / promoted constant / new). */
export function registryStats(): { total: number; byClass: Record<SettingClass, number>; bySource: Record<string, number>; withEnvAlias: number; platformTenant: number } {
  const byClass: Record<SettingClass, number> = { SETTING_IN_ADMIN: 0, SECRET: 0, PROVIDER_ID: 0 };
  const bySource: Record<string, number> = {};
  let platformTenant = 0;
  for (const d of allSettings()) {
    byClass[d.class]++;
    bySource[d.source] = (bySource[d.source] ?? 0) + 1;
    if (d.scope === 'platform+tenant') platformTenant++;
  }
  return { total: byKey.size, byClass, bySource, withEnvAlias: byEnv.size, platformTenant };
}
