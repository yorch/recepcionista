import { addDaysToDateKey, DEFAULT_TIMEZONE, localDateKey } from '@/lib/time';
import { intlTag, type Locale } from '@/lib/i18n/core';
import { formatMoney, formatPhoneDisplay } from '@/lib/i18n/core';

/**
 * Display helpers. Default zone is the demo business's; pass the business zone when known. Every helper takes an optional
 * `locale` ('en' default) so the Spanish dashboard formats dates, times, money and relative time the Spanish way.
 */
const TZ = DEFAULT_TIMEZONE;

/** The few words these helpers need, kept here (not in the message catalog) so client bundles that import this file stay small. */
const WORDS = {
  en: { today: 'Today', tomorrow: 'Tomorrow', todayAt: 'today at', tomorrowAt: 'tomorrow at', at: 'at', now: 'just now', soon: 'soon', m: (n: number) => `${n}m ago`, h: (n: number) => `${n}h ago`, d: (n: number) => `${n}d ago`, there: 'there' },
  es: { today: 'Hoy', tomorrow: 'Mañana', todayAt: 'hoy a las', tomorrowAt: 'mañana a las', at: 'a las', now: 'justo ahora', soon: 'pronto', m: (n: number) => `hace ${n} min`, h: (n: number) => `hace ${n} h`, d: (n: number) => `hace ${n} d`, there: 'allí' },
} as const;

export function timeET(iso: string, tz: string = TZ, locale: Locale = 'en'): string {
  return new Intl.DateTimeFormat(intlTag(locale), {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(new Date(iso));
}

export function dayET(iso: string, tz: string = TZ, locale: Locale = 'en'): string {
  return new Intl.DateTimeFormat(intlTag(locale), {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: tz,
  }).format(new Date(iso));
}

export function whenET(iso: string, tz: string = TZ, locale: Locale = 'en'): string {
  const w = WORDS[locale];
  const dKey = localDateKey(iso, tz);
  const todayKey = localDateKey(new Date(), tz);
  if (dKey === todayKey) return `${w.todayAt} ${timeET(iso, tz, locale)}`;
  if (dKey === addDaysToDateKey(todayKey, 1)) return `${w.tomorrowAt} ${timeET(iso, tz, locale)}`;
  return `${dayET(iso, tz, locale)} ${w.at} ${timeET(iso, tz, locale)}`;
}

/** "Today", "Tomorrow" or "Fri, Nov 27" for an instant, in the business zone (never splits another label on " at "). */
export function dayLabelET(iso: string, tz: string = TZ, now: Date = new Date(), locale: Locale = 'en'): string {
  const key = localDateKey(iso, tz);
  const todayKey = localDateKey(now, tz);
  if (key === todayKey) return WORDS[locale].today;
  if (key === addDaysToDateKey(todayKey, 1)) return WORDS[locale].tomorrow;
  return dayET(iso, tz, locale);
}

export function seconds(n?: number | null): string {
  if (n == null) return '—';
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Takes INTEGER CENTS (the unit of every money field in the DB). */
export function money(cents?: number | null, locale: Locale = 'en'): string {
  return formatMoney(locale, cents);
}

export function initials(name?: string | null): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

export function firstName(name?: string | null, locale: Locale = 'en'): string {
  return name?.trim().split(/\s+/)[0] || WORDS[locale].there;
}

export function relative(iso: string, nowMs: number = Date.now(), locale: Locale = 'en'): string {
  const w = WORDS[locale];
  const diff = nowMs - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return diff < -60000 ? w.soon : w.now;
  if (min < 60) return w.m(min);
  const h = Math.round(min / 60);
  if (h < 24) return w.h(h);
  return w.d(Math.round(h / 24));
}

/** A phone number for display: "+13055550142" -> "(305) 555-0142" (other numbers unchanged). Keep the raw value for `tel:` links. */
export function phoneDisplay(phone?: string | null): string {
  return formatPhoneDisplay(phone);
}

/** Last 10 digits of a phone number — the indexed inbound-call lookup key. */
export function phoneKey(phone?: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits ? digits.slice(-10) : null;
}
