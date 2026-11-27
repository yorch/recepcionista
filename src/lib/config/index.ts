/**
 * Runtime configuration: ONE synchronous, in-memory view of every platform setting.
 *
 * Resolution (owner decision D1): environment pin > console (database) value > registry default. An environment variable PINS a key
 * when it is set to a non-empty value; the console then shows it as "locked by environment". With no snapshot source installed (Phase 1:
 * there is no database yet) `configEnv()` returns `process.env` itself, so behaviour is byte-identical to reading the environment.
 *
 * RULES (docs/design/admin-console-architecture.md section 5):
 *  - Never keep the snapshot, the env view or a setting in a module-level `const`: call `runtimeConfig()` / `configEnv()` / `setting()` at each
 *    use. Anything that captures them freezes the console value (the job runner used to capture `env` at boot).
 *  - The snapshot lives on `globalThis[Symbol.for('rc.config')]`, not in a module variable: the proxy bundle and the route bundles load
 *    separate copies of this module and must share one state.
 *  - Dependency-free (no node-only imports, no I/O): this module is imported by the proxy / instrumentation bundles.
 *  - Secrets live in a non-enumerable map on the snapshot; the snapshot has no `toJSON`; `redactSecrets()` is the logger hook.
 */
import { defaultContext, defaultOf } from './define';
import { ENV_ONLY, RETIRED_ENV, settingByEnv, settingDef, allSettings } from './registry';
import type { SettingDef, SettingKey, SettingValue } from './registry';

export { SETTINGS, allSettings, settingDef, settingByEnv, registryStats, ENV_ONLY, BUILD_TIME_ENV, RETIRED_ENV, ratchetAllows, defineSetting, s } from './registry';
export type { SettingKey, SettingValue, SettingDef } from './registry';

// ---- the snapshot -----------------------------------------------------------------------------------------------------------

export interface SnapshotInit {
  /** The global settings version the values were loaded at (`settings_state.global_version`). */
  version: number;
  /** Non-secret console values by registry key (already validated and typed). */
  values?: Record<string, unknown>;
  /** Decrypted secret values by registry key. Held in a non-enumerable map; never serialised. */
  secrets?: Record<string, string>;
  loadedAt?: number;
}

/**
 * An immutable view of the console-held values. Secrets are on a NON-ENUMERABLE own property so `JSON.stringify`, spread, `Object.keys`
 * and `console.log` never see them; there is deliberately no `toJSON`.
 */
export class ConfigSnapshot {
  readonly version: number;
  readonly loadedAt: number;
  readonly values: Readonly<Record<string, unknown>>;
  declare readonly secrets: ReadonlyMap<string, string>;

  constructor(init: SnapshotInit) {
    this.version = init.version;
    this.loadedAt = init.loadedAt ?? Date.now();
    this.values = Object.freeze({ ...(init.values ?? {}) });
    Object.defineProperty(this, 'secrets', { value: new Map(Object.entries(init.secrets ?? {})), enumerable: false, writable: false });
  }

  /** The decrypted secret of a key, or undefined. Callers must never log or return it. */
  secret(key: string): string | undefined {
    return this.secrets.get(key);
  }

  get size(): number {
    return Object.keys(this.values).length + this.secrets.size;
  }

  /** Only the version and counts: never values (also what `util.inspect` prints). */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `ConfigSnapshot(v${this.version}, ${Object.keys(this.values).length} values, ${this.secrets.size} secrets)`;
  }
}

export const EMPTY_SNAPSHOT: ConfigSnapshot = new ConfigSnapshot({ version: 0, values: {}, secrets: {}, loadedAt: 0 });

/** Phase 2 plugs the database loader in here: a SYNCHRONOUS function returning the loader's current in-memory snapshot (or null before the first load). */
export type SnapshotSource = () => ConfigSnapshot | null;

interface ConfigState {
  source: SnapshotSource | null;
  /** Cache of the env-shaped view for the snapshot it was built from. */
  view: { snapshot: ConfigSnapshot; env: NodeJS.ProcessEnv } | null;
}

const STATE_KEY = Symbol.for('rc.config');

function state(): ConfigState {
  const g = globalThis as unknown as Record<symbol, ConfigState | undefined>;
  return (g[STATE_KEY] ??= { source: null, view: null });
}

/** Install (or with null remove) the snapshot provider. Idempotent; the latest call wins. */
export function setSnapshotSource(source: SnapshotSource | null): void {
  const st = state();
  st.source = source;
  st.view = null;
}

function currentSnapshot(): ConfigSnapshot | null {
  const src = state().source;
  if (!src) return null;
  try {
    const snap = src();
    return snap && snap.size > 0 ? snap : null;
  } catch {
    return null; // a failing loader must never take the readers down: keep serving the environment
  }
}

const rawEnv = (): NodeJS.ProcessEnv => (typeof process === 'undefined' ? ({} as NodeJS.ProcessEnv) : process.env);

// ---- resolution -------------------------------------------------------------------------------------------------------------

export type SettingSourceName = 'env' | 'console' | 'default';

export interface Resolved<T = unknown> {
  value: T | null;
  source: SettingSourceName;
  /** The environment variable was set but failed the registry validation (the default applies; readers apply their own fallback). */
  envInvalid?: boolean;
}

/** An environment variable pins a key when it is set to a non-empty value. */
export const isPinned = (env: Record<string, string | undefined>, name: string | undefined): boolean => Boolean(name) && (env[name as string] ?? '').trim() !== '';

/** Pure resolution (env pin > console > default) over explicit inputs: the single definition used by `setting()`, the console and the tests. */
export function resolveSetting<T = unknown>(
  def: SettingDef<T>,
  env: Record<string, string | undefined>,
  snapshot: ConfigSnapshot | null,
  nodeEnv: string | undefined = env.NODE_ENV,
): Resolved<T> {
  let envInvalid = false;
  if (def.env && isPinned(env, def.env)) {
    const r = def.schema.fromText((env[def.env] as string).trim());
    if (r.ok) return { value: r.value, source: 'env' };
    envInvalid = true;
  } else if (snapshot && !def.envOnlyLoosen) {
    const raw = def.kind === 'secret' ? snapshot.secret(def.key) : snapshot.values[def.key];
    if (raw !== undefined && raw !== null) {
      const r = def.schema.check(raw);
      if (r.ok) return { value: r.value, source: 'console' };
    }
  }
  return { value: defaultOf(def, defaultContext(nodeEnv)), source: 'default', ...(envInvalid ? { envInvalid } : {}) };
}

/** The effective value of a setting (env pin > console > default). `null` = unset. Never cache the result in a module constant. */
export function setting<K extends SettingKey>(key: K): SettingValue<K> | null {
  const def = settingDef(key);
  if (!def) throw new Error(`unknown setting ${key}`);
  return resolveSetting(def, rawEnv(), currentSnapshot()).value as SettingValue<K> | null;
}

/** Where the effective value of a key comes from (the console shows "locked by environment" for `env`). */
export function settingSource(key: SettingKey): SettingSourceName {
  const def = settingDef(key);
  if (!def) throw new Error(`unknown setting ${key}`);
  return resolveSetting(def, rawEnv(), currentSnapshot()).source;
}

// ---- the env-shaped view for the legacy readers -----------------------------------------------------------------------------

function envTextOf(def: SettingDef, value: unknown): string {
  if (def.kind === 'bool' && def.envFormat === 'on_off') return value ? 'on' : 'off';
  return def.schema.toText(value as never);
}

function buildView(snapshot: ConfigSnapshot): NodeJS.ProcessEnv {
  const overlay = new Map<string, string>();
  const secretNames = new Set<string>();
  for (const def of allSettings()) {
    if (!def.env || def.envOnlyLoosen) continue;
    if (def.kind === 'secret') {
      const v = snapshot.secret(def.key);
      if (v !== undefined) { overlay.set(def.env, v); secretNames.add(def.env); }
    } else {
      const v = snapshot.values[def.key];
      if (v !== undefined && v !== null && def.schema.check(v).ok) overlay.set(def.env, envTextOf(def, v));
    }
  }
  if (overlay.size === 0) return rawEnv();
  const target = rawEnv();
  return new Proxy(target, {
    get(t, p) {
      if (typeof p === 'string' && overlay.has(p)) {
        const own = t[p];
        return own !== undefined && own.trim() !== '' ? own : overlay.get(p); // env pins win
      }
      return Reflect.get(t, p);
    },
    has(t, p) {
      return (typeof p === 'string' && overlay.has(p)) || Reflect.has(t, p);
    },
    ownKeys(t) {
      const keys = Reflect.ownKeys(t);
      for (const name of overlay.keys()) if (!secretNames.has(name) && !keys.includes(name)) keys.push(name);
      return keys;
    },
    getOwnPropertyDescriptor(t, p) {
      const d = Reflect.getOwnPropertyDescriptor(t, p);
      if (d || typeof p !== 'string' || !overlay.has(p) || secretNames.has(p)) return d;
      return { value: overlay.get(p), enumerable: true, configurable: true, writable: true };
    },
  });
}

/**
 * The environment as the legacy readers see it: `process.env` overlaid with the console values for keys the environment does not pin.
 * Drop-in default for every `env: NodeJS.ProcessEnv = ...` parameter. With no console values it IS `process.env`. Call it at each use.
 */
export function configEnv(): NodeJS.ProcessEnv {
  const snap = currentSnapshot();
  if (!snap) return rawEnv();
  const st = state();
  if (st.view && st.view.snapshot === snap) return st.view.env;
  const env = buildView(snap);
  st.view = { snapshot: snap, env };
  return env;
}

export interface RuntimeConfig {
  /** Settings version of the applied snapshot (0 = nothing loaded: the environment and the defaults only). */
  readonly version: number;
  readonly loadedAt: number;
  get<K extends SettingKey>(key: K): SettingValue<K> | null;
  source(key: SettingKey): SettingSourceName;
  env(): NodeJS.ProcessEnv;
}

/** A facade over the CURRENT snapshot. Call it per use; do not keep the result (it would keep serving the snapshot it was created with). */
export function runtimeConfig(): RuntimeConfig {
  const snap = currentSnapshot();
  return {
    version: snap?.version ?? 0,
    loadedAt: snap?.loadedAt ?? 0,
    get: (key) => setting(key),
    source: (key) => settingSource(key),
    env: configEnv,
  };
}

// ---- diagnostics and the logger hook ----------------------------------------------------------------------------------------

/** Environment variables that pin a registry key with a value the registry rejects (names only, never values). */
export function configProblems(env: Record<string, string | undefined> = rawEnv()): { invalid: { name: string; key: string; error: string }[] } {
  const invalid: { name: string; key: string; error: string }[] = [];
  for (const def of allSettings()) {
    if (!def.env || !isPinned(env, def.env)) continue;
    const r = def.schema.fromText((env[def.env] as string).trim());
    if (!r.ok) invalid.push({ name: def.env, key: def.key, error: r.error });
  }
  return { invalid };
}

/** Retired variables (D11) that are still set: they keep working for one more release, the banner warns. */
export function retiredEnvWarnings(env: Record<string, string | undefined> = rawEnv()): { name: string; warning: string; warnedBy?: string }[] {
  const out: { name: string; warning: string; warnedBy?: string }[] = [];
  for (const r of RETIRED_ENV) {
    if (!isPinned(env, r.name)) continue;
    out.push({
      name: r.name,
      warnedBy: r.warnedBy,
      warning: `${r.name} is DEPRECATED and will be ignored after release ${r.removeAfter}${r.use ? ` (use ${r.use})` : ''}: ${r.note}`,
    });
  }
  return out;
}

/** Names whose values are secrets: registry secrets (by env alias) and the secret env-only names. */
const SECRET_ENV_NAMES: readonly string[] = [
  ...allSettings().filter((d) => d.kind === 'secret' && d.env).map((d) => d.env as string),
  ...ENV_ONLY.filter((e) => e.secret).map((e) => e.name),
];
const MIN_REDACT_LENGTH = 8;

/**
 * Logger hook: replaces every currently configured secret value (environment or console-held) found inside `text`. Values shorter than 8
 * characters are skipped (too likely to mask ordinary words). Cheap: a handful of `includes` per call.
 */
export function redactSecrets(text: string): string {
  if (text.length < MIN_REDACT_LENGTH) return text;
  let out = text;
  const env = rawEnv();
  for (const name of SECRET_ENV_NAMES) {
    const v = env[name];
    if (v && v.length >= MIN_REDACT_LENGTH && out.includes(v)) out = out.split(v).join('«redacted»');
  }
  const snap = currentSnapshot();
  if (snap) for (const v of snap.secrets.values()) if (v.length >= MIN_REDACT_LENGTH && out.includes(v)) out = out.split(v).join('«redacted»');
  return out;
}

/** Is `name` an environment variable the registry knows (a pin for a console setting)? */
export const isRegistryEnv = (name: string): boolean => settingByEnv(name) !== undefined;
