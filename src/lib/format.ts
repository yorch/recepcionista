import { addDaysToDateKey, DEFAULT_TIMEZONE, localDateKey } from '@/lib/time';
import { formatCents } from '@/lib/money';

/** Display helpers. Default zone is the demo business's; pass the business zone when known. */
const TZ = DEFAULT_TIMEZONE;

export function timeET(iso: string, tz: string = TZ): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(new Date(iso));
}

export function dayET(iso: string, tz: string = TZ): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: tz,
  }).format(new Date(iso));
}

export function whenET(iso: string, tz: string = TZ): string {
  const dKey = localDateKey(iso, tz);
  const todayKey = localDateKey(new Date(), tz);
  if (dKey === todayKey) return `today at ${timeET(iso, tz)}`;
  if (dKey === addDaysToDateKey(todayKey, 1)) return `tomorrow at ${timeET(iso, tz)}`;
  return `${dayET(iso, tz)} at ${timeET(iso, tz)}`;
}

export function seconds(n?: number | null): string {
  if (n == null) return '—';
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Takes INTEGER CENTS (the unit of every money field in the DB). */
export function money(cents?: number | null): string {
  return formatCents(cents);
}

export function initials(name?: string | null): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

export function firstName(name?: string | null): string {
  return name?.trim().split(/\s+/)[0] || 'there';
}

export function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return diff < -60000 ? 'soon' : 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Last 10 digits of a phone number — the indexed inbound-call lookup key. */
export function phoneKey(phone?: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits ? digits.slice(-10) : null;
}
