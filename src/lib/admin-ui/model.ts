/**
 * The pure model behind the console's settings forms (Agent A). Everything that decides WHAT the UI shows lives here, so it is unit tested without a
 * browser: which registry key belongs on which page, which widget a kind gets, text <-> typed value conversion with the registry's own validators (the SAME
 * schema objects the server applies), staged edits -> change set, and whether a field may be edited by this caller right now.
 * Safe in client and server bundles: it imports only the dependency-free config registry and TYPES.
 */
import { allSettings, ratchetAllows, settingDef, type SettingDef } from '@/lib/config/registry';
import type { Permission } from '@/lib/admin/permissions';
import type { SettingChange, SettingView } from '@/lib/admin/settings-store';

// ---- pages ----------------------------------------------------------------------------------------------------------------------------------------

export const SETTINGS_PAGE_IDS = ['voice', 'messaging', 'signup', 'data', 'billing', 'content', 'scheduling', 'jobs', 'locales'] as const;
export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number];
export const isSettingsPageId = (v: string): v is SettingsPageId => (SETTINGS_PAGE_IDS as readonly string[]).includes(v);

/** Registry keys that belong to the provider cards (Agent B), not to a settings page: shown there with their credentials. */
const PROVIDER_CARD_KEYS = new Set<string>(['google.oauth_redirect_uri']);
const PROVIDER_CARD_GROUPS = new Set<string>(['email', 'calendar', 'payments', 'llm']);

/** Explicit moves between registry groups and pages (a key listed here goes to that page whatever its group). */
const KEY_PAGE: Record<string, SettingsPageId> = {
  'voice.default_assistant_name': 'content',
  'live.max_per_user': 'voice', 'live.max_per_business': 'voice', 'live.max_polls_per_call': 'voice',
  'elevenlabs.voice_allowlist': 'content',
  'billing.release_grace_days': 'data',
  'billing.release_notice_days': 'data',
  'limits.max_businesses_per_user': 'signup',
  'limits.deposit_min_cents': 'scheduling', 'limits.deposit_max_cents': 'scheduling', 'limits.min_lead_max_minutes': 'scheduling',
  'limits.horizon_days_max': 'scheduling', 'limits.buffer_max_minutes': 'scheduling', 'limits.max_crews': 'scheduling',
  'defaults.slot_minutes': 'scheduling', 'defaults.min_lead_minutes': 'scheduling', 'defaults.horizon_days': 'scheduling', 'defaults.buffer_minutes': 'scheduling', 'defaults.crews': 'scheduling',
};
const GROUP_PAGE: Record<string, SettingsPageId> = {
  telephony: 'voice', voice: 'voice', owner: 'voice', forwarding: 'voice', live: 'voice',
  messaging: 'messaging', signup: 'signup', security: 'signup', limits: 'signup', data: 'data', billing: 'billing',
  brand: 'content', defaults: 'content', jobs: 'jobs', platform: 'locales',
};

/** A key owned by a provider card (credentials and their companions): the console renders those in agent B's cards. */
export const isProviderCardKey = (def: Pick<SettingDef, 'key' | 'group' | 'class'>): boolean =>
  def.class !== 'SETTING_IN_ADMIN' || PROVIDER_CARD_KEYS.has(def.key) || PROVIDER_CARD_GROUPS.has(def.group);

export function pageOfKey(def: Pick<SettingDef, 'key' | 'group' | 'class'>): SettingsPageId | null {
  if (isProviderCardKey(def)) return null;
  // `live.*` and `limits.*` keys have no registry group of their own in some builds: the key prefix is the fallback
  return KEY_PAGE[def.key] ?? GROUP_PAGE[def.group] ?? GROUP_PAGE[def.key.split('.')[0]] ?? null;
}

/** The registry definitions of a page, in registry order. */
export function settingsOfPage(page: SettingsPageId): SettingDef[] {
  return allSettings().filter((d) => pageOfKey(d) === page);
}

/** Registry groups present on a page, in order of first appearance (the section headings). */
export function sectionsOf(defs: readonly SettingDef[]): { group: string; defs: SettingDef[] }[] {
  const out: { group: string; defs: SettingDef[] }[] = [];
  for (const d of defs) {
    let sec = out.find((s) => s.group === d.group);
    if (!sec) out.push((sec = { group: d.group, defs: [] }));
    sec.defs.push(d);
  }
  return out;
}

// ---- widgets and text conversion ------------------------------------------------------------------------------------------------------------------

export type Widget = 'switch' | 'int' | 'select' | 'text' | 'url' | 'textarea' | 'list' | 'checkboxes' | 'json';

export function widgetFor(def: Pick<SettingDef, 'kind' | 'schema'>): Widget {
  const info = def.schema.info as { multiline?: boolean; values?: readonly string[]; itemInfo?: { values?: readonly string[] }; max?: number };
  switch (def.kind) {
    case 'bool': return 'switch';
    case 'int': return 'int';
    case 'enum': return 'select';
    case 'url': return 'url';
    case 'json': return 'json';
    case 'list':
    case 'country_list':
      return info.itemInfo?.values && info.itemInfo.values.length <= 6 ? 'checkboxes' : 'list';
    case 'string': return info.multiline || (info.max ?? 0) > 200 ? 'textarea' : 'text';
    default: return 'text';
  }
}

export function valueToText(def: Pick<SettingDef, 'kind' | 'schema'>, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (def.kind === 'json') return JSON.stringify(value, null, 2);
  try { return def.schema.toText(value as never); } catch { return String(value); }
}

export type StagedEdit = { op: 'set'; value: unknown; text: string } | { op: 'remove' };
export type TextEdit = { ok: true; edit: StagedEdit } | { ok: false; error: string };

/**
 * A text field's content -> a staged edit. An EMPTY field on a setting whose default is "unset" resets it (the field was optional): there is no
 * way to store an empty value. Everything else goes through the registry schema (`fromText`), exactly what an environment variable would be.
 */
export function editFromText(def: Pick<SettingDef, 'kind' | 'schema'>, text: string, defaultIsUnset: boolean): TextEdit {
  if (text.trim() === '' && defaultIsUnset && def.kind !== 'list' && def.kind !== 'country_list') return { ok: true, edit: { op: 'remove' } };
  const parsed = def.schema.fromText(def.kind === 'json' ? text : text);
  return parsed.ok ? { ok: true, edit: { op: 'set', value: parsed.value, text } } : { ok: false, error: parsed.error };
}

// ---- comparison, staging, field state -------------------------------------------------------------------------------------------------------------

/** Stable structural equality (order of object keys ignored). */
export function sameValue(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
  return canon(a ?? null) === canon(b ?? null);
}

/** Does the edit change anything compared with what is effective now? A no-op edit is dropped from the draft. */
export function editChangesSomething(view: Pick<SettingView, 'value' | 'source' | 'console_value' | 'locked'>, edit: StagedEdit): boolean {
  if (edit.op === 'remove') return view.console_value !== null && view.console_value !== undefined;
  return !sameValue(view.value, edit.value);
}

export function stagedToChanges(staged: Readonly<Record<string, StagedEdit>>): SettingChange[] {
  return Object.entries(staged).map(([key, e]) => (e.op === 'remove' ? { key, remove: true } : { key, value: e.value }));
}

export const writePermissionFor = (def: Pick<SettingDef, 'tier'>): Permission => (def.tier === 'critical' ? 'settings.write.critical' : 'settings.write');

export type FieldBlock = 'locked_env' | 'locked_env_only' | 'no_permission' | 'frozen' | null;

/** Why a field is not editable right now (null = editable). Order: what nobody can change first, then what this role cannot, then the incident freeze. */
export function fieldBlock(view: Pick<SettingView, 'locked' | 'locked_reason'>, def: Pick<SettingDef, 'tier'>, perms: readonly string[], frozen: boolean): FieldBlock {
  if (view.locked) return view.locked_reason === 'env_only' ? 'locked_env_only' : 'locked_env';
  if (!perms.includes(writePermissionFor(def))) return 'no_permission';
  if (frozen) return 'frozen';
  return null;
}

/** Client-side check of a ratchet before the server says no. `from` is what the server compares with: the console value, else the default. */
export function ratchetError(def: SettingDef, view: Pick<SettingView, 'console_value' | 'default'>, edit: StagedEdit): boolean {
  if (!def.ratchet) return false;
  const from = view.console_value ?? view.default;
  const to = edit.op === 'remove' ? view.default : edit.value;
  return !ratchetAllows(def, from, to);
}

/** Registry definition for a key in the API listing (client side: the schema validators are not serialisable). */
export const defOf = (key: string): SettingDef | undefined => settingDef(key);

// ---- pretty values for diffs ----------------------------------------------------------------------------------------------------------------------

export function displayValue(value: unknown, empty: string): string {
  if (value === null || value === undefined || value === '') return empty;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.every((x) => typeof x !== 'object')) return value.length ? value.join(', ') : empty;
  return JSON.stringify(value);
}

/** The phrase a critical change set needs (mirrors `confirmationPhrase` of the settings store, which is server only). */
export const confirmPhrase = (keys: readonly string[]): string => (keys.length === 1 ? keys[0] : `apply ${keys.length} critical settings`);

/** Confirmation phrase of a legal page publication. */
export const publishPhrase = (slug: string, locale: string): string => `publish ${slug}/${locale}`;
