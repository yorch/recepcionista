/**
 * Hand-rolled schema helpers for the settings registry (the repo has no zod). Pure: no imports, no I/O, so the SAME
 * validators run on the server (apply API, env pins) and in the browser (console forms, Phase 3).
 *
 * A schema validates two shapes of the same value:
 *   - `check(value)`    the typed JSON value (what the database stores and the console form submits);
 *   - `fromText(text)`  the text form (an environment variable, a text input). Strict: junk is an error, never a silent default.
 * `toText(value)` is the inverse, used to build the env-shaped view for legacy readers (`configEnv()`).
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export type SchemaType = 'int' | 'bool' | 'enum' | 'string' | 'list' | 'json';

export interface Schema<T> {
  readonly type: SchemaType;
  /** Constraints, exposed for the generated forms and the registry tests (min/max/values/maxLength/item/...). */
  readonly info: Readonly<Record<string, unknown>>;
  check(value: unknown): Parsed<T>;
  fromText(text: string): Parsed<T>;
  toText(value: T): string;
}

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const err = (error: string): Parsed<never> => ({ ok: false, error });

const TRUE = new Set(['true', 'on', '1', 'yes']);
const FALSE = new Set(['false', 'off', '0', 'no']);

export function intSchema(opts: { min?: number; max?: number } = {}): Schema<number> {
  const min = opts.min ?? Number.MIN_SAFE_INTEGER;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  const check = (v: unknown): Parsed<number> => {
    if (typeof v !== 'number' || !Number.isInteger(v)) return err('must be a whole number');
    if (v < min || v > max) return err(`must be between ${min} and ${max}`);
    return ok(v);
  };
  return {
    type: 'int',
    info: { min: opts.min, max: opts.max },
    check,
    fromText: (t) => (/^-?\d+$/.test(t.trim()) ? check(Number(t.trim())) : err('must be a whole number')),
    toText: (v) => String(v),
  };
}

export function boolSchema(): Schema<boolean> {
  return {
    type: 'bool',
    info: {},
    check: (v) => (typeof v === 'boolean' ? ok(v) : err('must be true or false')),
    fromText: (t) => {
      const x = t.trim().toLowerCase();
      return TRUE.has(x) ? ok(true) : FALSE.has(x) ? ok(false) : err('must be true or false');
    },
    toText: (v) => (v ? 'true' : 'false'),
  };
}

export function enumSchema<const V extends string>(values: readonly V[]): Schema<V> {
  const set = new Set<string>(values);
  const check = (v: unknown): Parsed<V> => (typeof v === 'string' && set.has(v) ? ok(v as V) : err(`must be one of: ${values.join(', ')}`));
  return { type: 'enum', info: { values }, check, fromText: (t) => check(t.trim()), toText: (v) => v };
}

export function stringSchema(opts: { min?: number; max?: number; pattern?: RegExp; patternHint?: string; multiline?: boolean } = {}): Schema<string> {
  const min = opts.min ?? 0;
  const max = opts.max ?? 500;
  const check = (v: unknown): Parsed<string> => {
    if (typeof v !== 'string') return err('must be text');
    const s = v.trim();
    if (s.length < min) return err(`must be at least ${min} characters`);
    if (s.length > max) return err(`must be at most ${max} characters`);
    if (!opts.multiline && /[\r\n]/.test(s)) return err('must be a single line');
    if (s && opts.pattern && !opts.pattern.test(s)) return err(opts.patternHint ?? 'has an invalid format');
    return ok(s);
  };
  return { type: 'string', info: { min: opts.min, max, pattern: opts.pattern?.source, multiline: opts.multiline }, check, fromText: check, toText: (v) => v };
}

/** An absolute http(s) URL (https only unless `allowHttp`). Empty text is NOT valid here; unset is expressed by a null default. */
export function urlSchema(opts: { allowHttp?: boolean; max?: number } = {}): Schema<string> {
  const max = opts.max ?? 500;
  const check = (v: unknown): Parsed<string> => {
    if (typeof v !== 'string') return err('must be a URL');
    const s = v.trim();
    if (!s || s.length > max) return err(`must be a URL of at most ${max} characters`);
    let u: URL;
    try { u = new URL(s); } catch { return err('must be an absolute URL'); }
    if (u.protocol !== 'https:' && !(opts.allowHttp && u.protocol === 'http:')) return err(opts.allowHttp ? 'must be an http(s) URL' : 'must be an https URL');
    if (u.username || u.password) return err('must not contain credentials');
    return ok(s);
  };
  return { type: 'string', info: { max, allowHttp: Boolean(opts.allowHttp), format: 'url' }, check, fromText: check, toText: (v) => v };
}

/** A list of items, comma separated as text. Items are validated by `item`; duplicates are dropped (order kept). */
export function listSchema<T extends string | number>(item: Schema<T>, opts: { max?: number; minItems?: number } = {}): Schema<T[]> {
  const max = opts.max ?? 200;
  const finish = (items: T[]): Parsed<T[]> => {
    const uniq = [...new Set(items)];
    if (uniq.length > max) return err(`at most ${max} entries`);
    if (uniq.length < (opts.minItems ?? 0)) return err(`at least ${opts.minItems} entries`);
    return ok(uniq);
  };
  return {
    type: 'list',
    info: { item: item.type, itemInfo: item.info, max, minItems: opts.minItems },
    check: (v) => {
      if (!Array.isArray(v)) return err('must be a list');
      const out: T[] = [];
      for (const x of v) {
        const r = item.check(x);
        if (!r.ok) return err(`entry ${JSON.stringify(x)}: ${r.error}`);
        out.push(r.value);
      }
      return finish(out);
    },
    fromText: (t) => {
      const parts = t.split(',').map((p) => p.trim()).filter(Boolean);
      const out: T[] = [];
      for (const p of parts) {
        const r = item.fromText(p);
        if (!r.ok) return err(`entry "${p}": ${r.error}`);
        out.push(r.value);
      }
      return finish(out);
    },
    toText: (v) => v.map((x) => String(x)).join(','),
  };
}

/** A country calling code without "+": 1 to 3 digits. */
export const callingCodeSchema = (): Schema<string> => stringSchema({ min: 1, max: 3, pattern: /^[1-9]\d{0,2}$/, patternHint: 'a calling code of 1 to 3 digits, without +' });
/** A NANP area code: three digits, first 2-9. */
export const areaCodeSchema = (): Schema<string> => stringSchema({ min: 3, max: 3, pattern: /^[2-9]\d{2}$/, patternHint: 'a 3-digit area code (first digit 2-9)' });
/** An ISO 3166-1 alpha-2 country code, upper case. */
export const countrySchema = (): Schema<string> => stringSchema({ min: 2, max: 2, pattern: /^[A-Z]{2}$/, patternHint: 'a 2-letter ISO country code in upper case' });

/** Free-form JSON validated by a function (object-shaped settings). Text form is JSON. */
export function jsonSchema<T>(validate: (v: unknown) => Parsed<T>, shape = 'json'): Schema<T> {
  return {
    type: 'json',
    info: { shape },
    check: validate,
    fromText: (t) => { try { return validate(JSON.parse(t)); } catch { return err('must be valid JSON'); } },
    toText: (v) => JSON.stringify(v),
  };
}

/** The `s.` namespace: how registry entries spell their validators. */
export const s = {
  secret: (o?: Parameters<typeof secretSchema>[0]) => secretSchema(o),
  int: intSchema,
  bool: boolSchema,
  enum: enumSchema,
  string: stringSchema,
  url: urlSchema,
  list: listSchema,
  callingCode: callingCodeSchema,
  areaCode: areaCodeSchema,
  country: countrySchema,
  json: jsonSchema,
} as const;

/** A credential: one token without whitespace. The value is never echoed in an error. */
export function secretSchema(opts: { min?: number; max?: number; pattern?: RegExp; patternHint?: string } = {}): Schema<string> {
  const max = opts.max ?? 4000;
  const check = (v: unknown): Parsed<string> => {
    if (typeof v !== 'string') return err('must be text');
    const x = v.trim();
    if (x.length < (opts.min ?? 8)) return err(`must be at least ${opts.min ?? 8} characters`);
    if (x.length > max) return err(`must be at most ${max} characters`);
    if (/\s/.test(x)) return err('must not contain whitespace');
    if (opts.pattern && !opts.pattern.test(x)) return err(opts.patternHint ?? 'has an invalid format');
    return ok(x);
  };
  return { type: 'string', info: { min: opts.min ?? 8, max, secret: true }, check, fromText: check, toText: (v) => v };
}
