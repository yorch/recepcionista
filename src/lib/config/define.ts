import type { DefaultContext, SettingClass, SettingDef, SettingInput } from './types';

const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;

export function defaultContext(nodeEnv: string | undefined): DefaultContext {
  const e = nodeEnv ?? '';
  return { nodeEnv: e, production: e === 'production', development: e === 'development', test: e === 'test' };
}

export function classOf(kind: SettingInput<unknown>['kind']): SettingClass {
  return kind === 'secret' ? 'SECRET' : kind === 'provider_id' ? 'PROVIDER_ID' : 'SETTING_IN_ADMIN';
}

/**
 * Declare one setting. Throws on a structurally impossible entry (bad key, secret with tenant scope, tenant rule without tenant scope),
 * so a typo fails the first test run instead of shipping. Value validity (default vs schema) is asserted by tests/config-registry.test.ts.
 */
export function defineSetting<const K extends string, T>(input: SettingInput<T> & { key: K }): SettingDef<T> & { readonly key: K } {
  if (!KEY_RE.test(input.key)) throw new Error(`registry: bad key "${input.key}"`);
  if (input.env !== undefined && !ENV_RE.test(input.env)) throw new Error(`registry: bad env alias "${input.env}" for ${input.key}`);
  const scope = input.scope ?? 'platform';
  if (input.kind === 'secret' && scope !== 'platform') throw new Error(`registry: secret ${input.key} must be platform scope`);
  if (input.tenant && scope !== 'platform+tenant') throw new Error(`registry: ${input.key} has tenant rules but platform scope`);
  if (scope === 'platform+tenant' && !input.tenant) throw new Error(`registry: ${input.key} is platform+tenant without tenant rules`);
  const def = {
    ...input,
    scope,
    tier: input.tier ?? (input.kind === 'secret' ? 'critical' : 'normal'),
    applies: input.applies ?? 'live',
    class: classOf(input.kind),
    source: input.source ?? (input.env ? ('env' as const) : ('promoted_const' as const)),
    labelKey: `admin.setting.${input.key}.label`,
    helpKey: `admin.setting.${input.key}.help`,
  };
  return Object.freeze(def) as SettingDef<T> & { readonly key: K };
}

/** The default of an entry for a given NODE_ENV (null = unset). */
export function defaultOf<T>(def: SettingDef<T>, ctx: DefaultContext): T | null {
  return typeof def.default === 'function' ? (def.default as (c: DefaultContext) => T | null)(ctx) : def.default;
}

const TIGHTER: Record<string, (a: unknown, b: unknown) => boolean | null> = {
  lower: (a, b) => (typeof a === 'number' && typeof b === 'number' ? b <= a : null),
  higher: (a, b) => (typeof a === 'number' && typeof b === 'number' ? b >= a : null),
  fewer: (a, b) => (Array.isArray(a) && Array.isArray(b) ? b.every((x) => a.includes(x)) : null),
  more: (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.every((x) => b.includes(x)) : null),
};

/**
 * Ratchet check (D10): may the console move `from` -> `to`? true = tightening or no ratchet declared; false = loosening (needs the env var).
 * An entry with a ratchet but no declared direction is never loosened from the console.
 */
export function ratchetAllows(def: Pick<SettingDef, 'ratchet' | 'tightenIs'>, from: unknown, to: unknown): boolean {
  if (!def.ratchet) return true;
  if (def.ratchet === 'env_only_loosen' && !def.tightenIs) return false;
  const f = def.tightenIs ? TIGHTER[def.tightenIs] : undefined;
  return f ? f(from, to) === true : false;
}
