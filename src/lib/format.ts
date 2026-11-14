const TZ = 'America/New_York';

export function timeET(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ,
  }).format(new Date(iso));
}

export function dayET(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ,
  }).format(new Date(iso));
}

export function whenET(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const dET = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
  const nET = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
  if (dET === nET) return `today at ${timeET(iso)}`;
  const tomorrow = new Date(now.getTime() + 86400000);
  const tET = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(tomorrow);
  if (dET === tET) return `tomorrow at ${timeET(iso)}`;
  return `${dayET(iso)} at ${timeET(iso)}`;
}

export function seconds(n?: number | null): string {
  if (!n) return '—';
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function money(n?: number | null): string {
  if (n == null) return '—';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function initials(name?: string | null): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

export function firstName(name?: string | null): string {
  return name?.trim().split(/\s+/)[0] ?? 'there';
}

export function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
