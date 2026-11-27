/**
 * "Move to console" classification (pure). Of the keys the environment pins:
 *  movable  non-secret, pinned value valid, the caller may write that tier, nothing identical already stored  -> can be copied (preselected unless already stored)
 *  ready    the console already holds exactly the pinned value  -> the environment line can be deleted
 *  differs  the console holds a different value than the pin (dormant) -> shown so nobody deletes the line expecting the old console value
 *  blocked  secrets (entered once in the provider cards), invalid pins, env-only ratchets, or a tier the caller may not write
 */
import { sameValue, writePermissionFor } from './model';
import { settingDef } from '@/lib/config/registry';
import type { SettingView } from '@/lib/admin/settings-store';

export interface MoveRow { key: string; env: string; value: unknown; tier: 'normal' | 'sensitive' | 'critical'; preselect: boolean }
export type BlockWhy = 'secret' | 'invalid' | 'env_only' | 'permission';
export interface MoveClass { movable: MoveRow[]; ready: MoveRow[]; differs: MoveRow[]; blocked: { key: string; env: string; why: BlockWhy }[] }

export function classifyMove(settings: readonly SettingView[], permissions: readonly string[]): MoveClass {
  const out: MoveClass = { movable: [], ready: [], differs: [], blocked: [] };
  for (const v of settings) {
    if (v.source !== 'env' || !v.env) continue;
    if (v.class === 'SECRET' || v.kind === 'secret') { out.blocked.push({ key: v.key, env: v.env, why: 'secret' }); continue; }
    if (v.locked_reason === 'env_only') { out.blocked.push({ key: v.key, env: v.env, why: 'env_only' }); continue; }
    if (v.env_invalid || v.value === null || v.value === undefined) { out.blocked.push({ key: v.key, env: v.env, why: 'invalid' }); continue; }
    const row: MoveRow = { key: v.key, env: v.env, value: v.value, tier: v.tier, preselect: true };
    const stored = v.console_value !== null && v.console_value !== undefined;
    if (stored && sameValue(v.console_value, v.value)) { out.ready.push(row); continue; }
    if (stored) out.differs.push(row);
    const def = settingDef(v.key);
    if (def && !permissions.includes(writePermissionFor(def))) { out.blocked.push({ key: v.key, env: v.env, why: 'permission' }); continue; }
    if (!stored) out.movable.push(row);
    else out.movable.push({ ...row, preselect: false });
  }
  return out;
}
