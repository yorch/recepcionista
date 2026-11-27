/**
 * Types of the settings registry (see docs/design/admin-console-architecture.md). Pure: shared by the server, the proxy bundle and the
 * browser, so this file (and everything in src/lib/config) imports nothing node-only.
 */
import type { Schema } from './schema';

/** Widget / storage kind. `secret` is write-only and encrypted at rest (Phase 4); `provider_id` is a plain, non-secret provider identifier. */
export type SettingKind =
  | 'int' | 'bool' | 'enum' | 'string' | 'list' | 'url' | 'country_list' | 'duration' | 'secret' | 'provider_id' | 'json';

/** The three classes of 24a that a registry entry can have (everything else is env-only, see env-only.ts). */
export type SettingClass = 'SETTING_IN_ADMIN' | 'SECRET' | 'PROVIDER_ID';

export type SettingGroup =
  | 'platform' | 'brand' | 'billing' | 'messaging' | 'voice' | 'forwarding' | 'owner' | 'telephony' | 'payments' | 'llm' | 'email'
  | 'calendar' | 'signup' | 'security' | 'jobs' | 'data' | 'defaults' | 'limits';

/** normal: one step-up; sensitive: + reason; critical: + typed confirmation, impact preview and a notification to every admin. */
export type Tier = 'normal' | 'sensitive' | 'critical';

/** How a change takes effect: live (next read, at most one poll later), only for records created afterwards, after a restart, or after a re-sync action. */
export type Applies = 'live' | 'new_records_only' | 'restart_required' | 'needs_resync';

export type FollowUp = 'resync_agents' | 'repair_numbers' | 'reregister_webhooks' | 'restart';

/** `tighten_only_in_ui`: the console may only move the value to the safer side; loosening needs the environment variable (D10). */
export type Ratchet = 'tighten_only_in_ui' | 'env_only_loosen';

export interface DefaultContext {
  nodeEnv: string;
  production: boolean;
  development: boolean;
  test: boolean;
}

export interface TenantRule {
  /** Who may set the per-tenant override (D12: owners get comfort knobs only; caps, budgets and features are platform-only). */
  editableBy: 'owner' | 'platform';
  /** Tighter bounds than the platform schema for the tenant value (clamped server side). */
  min?: number;
  max?: number;
  /** `stricter_than_platform`: the tenant value may only be more restrictive than the platform value (quiet hours). */
  rule?: 'within_bounds' | 'stricter_than_platform';
  /** An environment pin on the platform value also blocks tenant overrides. */
  envPinBlocksOverrides?: boolean;
}

/** Where the entry comes from: an environment variable that exists today, a constant promoted from code (24c), or a new setting (24e 2.3). */
export type SettingSource = 'env' | 'promoted_const' | 'new';

export interface SettingInput<T> {
  /** Stable dotted key, `group.name`. Never renamed once shipped (stored rows use it). */
  key: string;
  /** Legacy environment variable: pins the value (env > DB > default) and is imported by the "move to console" wizard. */
  env?: string;
  group: SettingGroup;
  /** Human text (English); the i18n catalog keys are derived: `admin.setting.<key>.label` / `.help`. */
  label: string;
  help: string;
  kind: SettingKind;
  schema: Schema<T>;
  /** The value when neither env nor console sets it. May depend on NODE_ENV. `null` = unset (provider ids, secrets, optional URLs). */
  default: T | null | ((ctx: DefaultContext) => T | null);
  scope?: 'platform' | 'platform+tenant';
  tenant?: TenantRule;
  tier?: Tier;
  ratchet?: Ratchet;
  /** With `ratchet`: which direction is the safer one for the console (`lower`/`higher` numbers, `fewer`/`more` list entries). */
  tightenIs?: 'lower' | 'higher' | 'fewer' | 'more';
  applies?: Applies;
  followUp?: FollowUp;
  /** Keys that must change in the same change set (credential pairs). */
  pairedWith?: readonly string[];
  /** Display unit for int/duration kinds. */
  unit?: 'seconds' | 'minutes' | 'hours' | 'days' | 'ms' | 'cents' | 'percent' | 'count';
  /** Where the value lives today (documentation of the migration: `src/lib/x.ts:CONST`). Promoted constants only. */
  codeRef?: string;
  /** The console may never write it: the key is shown read-only ("locked: env-only security toggle"). */
  envOnlyLoosen?: boolean;
  /** Provider caches keyed by this credential must include its fingerprint (24e 5.3). */
  credentialFingerprintInCaches?: boolean;
  /** Text a legacy reader expects for a boolean in `configEnv()` (default `true`/`false`; some readers only accept `on`). */
  envFormat?: 'true_false' | 'on_off';
  /** The source of the entry; derived from `env` when omitted. */
  source?: SettingSource;
}

export interface SettingDef<T = unknown> extends Readonly<Omit<SettingInput<T>, 'scope' | 'tier' | 'applies' | 'source'>> {
  readonly scope: 'platform' | 'platform+tenant';
  readonly tier: Tier;
  readonly applies: Applies;
  readonly class: SettingClass;
  readonly source: SettingSource;
  readonly labelKey: string;
  readonly helpKey: string;
}

/** An env-only name (24e section 6): never stored in the database, never writable from the console. */
export interface EnvOnlyEntry {
  name: string;
  /** Why it stays in the environment. */
  reason: 'bootstrap' | 'master_secret' | 'infrastructure' | 'security_identity' | 'security_ratchet' | 'dev_only' | 'deploy_tooling' | 'public_origin' | 'build_time' | 'platform_control';
  note: string;
  /** Secret-valued (redacted by the logger hook). */
  secret?: boolean;
}

export interface RetiredEnvEntry {
  name: string;
  /** Replacement, if any. */
  use?: string;
  /** Release in which the name stops being recognised at all (it warns until then). */
  removeAfter: string;
  note: string;
  /** Boot warning event that already explains this variable (not repeated). */
  warnedBy?: string;
}
