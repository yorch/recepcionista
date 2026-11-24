/**
 * In-house i18n core (docs/i18n.md). Pure and runtime-agnostic (server, client, edge, tests): no I/O, no React.
 *
 *  - Message keys are the keys of `en` (src/lib/i18n/en.ts); `es` must carry exactly the same keys and the same
 *    `{placeholders}` (tests/i18n-parity.test.ts).
 *  - Interpolation: `{name}`. Plural: `{count, plural, one {# item} other {# items}}` (`#` = the number, formatted).
 *  - Locale resolution: user.locale -> business.locale_default -> Accept-Language -> en (resolveLocale).
 */
import type { en } from './en';
import type { Locale } from '@/lib/types';

export type { Locale };
export const LOCALES: readonly Locale[] = ['en', 'es'];
export const DEFAULT_LOCALE: Locale = 'en';
/** Cookie that remembers the language for visitors without a session (login footer switcher) and mirrors the user's choice. */
export const LOCALE_COOKIE = 'rc_locale';

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
export type Params = Record<string, string | number>;
export type TFunction = (key: MessageKey, params?: Params) => string;

export function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'es';
}

/** 'es-MX' / 'ES' / ' es ' -> 'es'; anything else -> null. */
export function normalizeLocale(v: unknown): Locale | null {
  if (typeof v !== 'string') return null;
  const base = v.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : null;
}

/** BCP 47 tag used for Intl (es-US: neutral Latin-American formatting, USD-friendly; en-US). */
export function intlTag(locale: Locale): string {
  return locale === 'es' ? 'es-US' : 'en-US';
}

/** First supported language of an Accept-Language header, honouring q-values; null when none is supported. */
export function parseAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header || header.length > 500) return null;
  const ranked = header
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: (tag ?? '').trim(), weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.tag && x.tag !== '*' && x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  for (const { tag } of ranked) {
    const l = normalizeLocale(tag);
    if (l) return l;
  }
  return null;
}

export interface LocaleSources {
  /** users.locale of the signed-in user, when there is one. */
  user?: unknown;
  /** The explicit choice of a visitor (rc_locale cookie). Only consulted when there is no signed-in user locale. */
  cookie?: unknown;
  /** businesses.locale_default of the active business. */
  business?: unknown;
  acceptLanguage?: string | null;
}

/** user.locale -> cookie -> business.locale_default -> Accept-Language -> en. */
export function resolveLocale(s: LocaleSources): Locale {
  return normalizeLocale(s.user) ?? normalizeLocale(s.cookie) ?? normalizeLocale(s.business) ?? parseAcceptLanguage(s.acceptLanguage) ?? DEFAULT_LOCALE;
}

// ---------------------------------------------------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------------------------------------------------

/** Plural category for a count (en/es share one/other; es treats 1 only as singular). */
export function pluralCategory(locale: Locale, n: number): 'one' | 'other' {
  return new Intl.PluralRules(intlTag(locale)).select(n) === 'one' ? 'one' : 'other';
}

/** Pick a form: plural('es', 2, { one: 'cita', other: 'citas' }). */
export function plural(locale: Locale, n: number, forms: { one: string; other: string }): string {
  return forms[pluralCategory(locale, n)];
}

/** Read a balanced `{...}` starting at s[i] === '{'; returns the inner text and the index after the closing brace. */
function readBraced(s: string, i: number): { inner: string; end: number } | null {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}') {
      depth--;
      if (depth === 0) return { inner: s.slice(i + 1, j), end: j + 1 };
    }
  }
  return null;
}

function format(locale: Locale, template: string, params: Params): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== '{') { out += ch; i++; continue; }
    const block = readBraced(template, i);
    if (!block) { out += ch; i++; continue; }
    const m = /^\s*([A-Za-z_][\w]*)\s*(?:,\s*plural\s*,([\s\S]*))?$/.exec(block.inner);
    if (!m) { out += template.slice(i, block.end); i = block.end; continue; }
    const name = m[1] as string;
    const val = params[name];
    if (m[2] === undefined) {
      out += val === undefined ? `{${name}}` : String(val);
    } else {
      const n = Number(val ?? 0);
      const branches: Record<string, string> = {};
      const body = m[2];
      let k = 0;
      while (k < body.length) {
        const rest = /^\s*(=?\w+)\s*/.exec(body.slice(k));
        if (!rest) break;
        const braceAt = k + rest[0].length;
        if (body[braceAt] !== '{') break;
        const b = readBraced(body, braceAt);
        if (!b) break;
        branches[rest[1] as string] = b.inner;
        k = b.end;
      }
      const chosen = branches[`=${n}`] ?? branches[pluralCategory(locale, n)] ?? branches.other ?? '';
      out += format(locale, chosen.replace(/#/g, new Intl.NumberFormat(intlTag(locale)).format(n)), params);
    }
    i = block.end;
  }
  return out;
}

/** Format `key` from an explicit catalog (the client's single-language catalog). Falls back to the key itself; never throws. */
export function translateFrom(catalog: Partial<Messages> | undefined, locale: Locale, key: MessageKey, params: Params = {}): string {
  return format(locale, catalog?.[key] ?? key, params);
}

/** Placeholder names a template uses (parity test): plain `{x}` and the plural variable of `{n, plural, ...}`. */
export function placeholdersOf(template: string): string[] {
  const names = new Set<string>();
  const walk = (s: string): void => {
    let i = 0;
    while (i < s.length) {
      if (s[i] !== '{') { i++; continue; }
      const block = readBraced(s, i);
      if (!block) break;
      const m = /^\s*([A-Za-z_]\w*)\s*(?:,\s*plural\s*,([\s\S]*))?$/.exec(block.inner);
      if (m) {
        names.add(m[1] as string);
        if (m[2] !== undefined) {
          let k = 0;
          const body = m[2];
          while (k < body.length) {
            const rest = /^\s*(=?\w+)\s*/.exec(body.slice(k));
            if (!rest || body[k + rest[0].length] !== '{') break;
            const b = readBraced(body, k + rest[0].length);
            if (!b) break;
            walk(b.inner);
            k = b.end;
          }
        }
      }
      i = block.end;
    }
  };
  walk(template);
  return [...names].sort();
}

// ---------------------------------------------------------------------------------------------------------------------
// Intl formatting (dates, currency, numbers, phone)
// ---------------------------------------------------------------------------------------------------------------------

export function formatDateTime(locale: Locale, at: Date | string | number, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlTag(locale), opts).format(new Date(at));
}

export function formatNumber(locale: Locale, n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlTag(locale), opts).format(n);
}

/** Integer cents in, "$1,234.50" / "$1,234.50" out (USD in both locales; es-US groups with commas). Whole dollars drop the decimals. */
export function formatMoney(locale: Locale, cents: number | null | undefined, currency = 'USD'): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  const whole = Math.round(cents) % 100 === 0;
  return new Intl.NumberFormat(intlTag(locale), {
    style: 'currency', currency, currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  }).format(Math.round(cents) / 100);
}

/** "+13055550142" -> "(305) 555-0142" (national format for a +1 number, international otherwise). Locale does not change digits grouping. */
export function formatPhoneDisplay(raw: string | null | undefined): string {
  if (!raw) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(raw.replace(/[\s().-]/g, ''));
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return raw;
}

export function formatList(locale: Locale, items: string[], type: 'conjunction' | 'disjunction' = 'conjunction'): string {
  return new Intl.ListFormat(intlTag(locale), { style: 'long', type }).format(items);
}

/** "5 min ago" / "hace 5 min" style relative time from a number of minutes (negative = future). */
export function relativeFromNow(locale: Locale, diffMs: number): string {
  const rtf = new Intl.RelativeTimeFormat(intlTag(locale), { numeric: 'auto', style: 'short' });
  const min = Math.round(-diffMs / 60000);
  if (Math.abs(min) < 60) return rtf.format(min, 'minute');
  const h = Math.round(min / 60);
  if (Math.abs(h) < 24) return rtf.format(h, 'hour');
  return rtf.format(Math.round(h / 24), 'day');
}

/** The `rc_locale` cookie value of a raw Cookie header, or undefined. */
export function localeCookieFrom(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === LOCALE_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** Locale of an incoming request that has no session yet (signup, invitation): cookie, then business default, then Accept-Language. */
export function localeOfRequest(h: { get(name: string): string | null }, business?: unknown): Locale {
  return resolveLocale({ cookie: localeCookieFrom(h.get('cookie')), business, acceptLanguage: h.get('accept-language') });
}
