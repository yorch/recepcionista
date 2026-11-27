'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/components/ui/cn';
import { PageHeader } from '@/components/ui/page-header';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import type { Permission } from '@/lib/admin/permissions';
import { useAdmin } from './provider';

/** The operations sub-navigation: one row of links shared by every operations page, filtered by the caller's permissions (the server enforces them again). */
export const OPS_TABS: readonly { href: string; label: MessageKey; permission: Permission }[] = [
  { href: '/admin/operations/alerts', label: 'ao.nav.alerts', permission: 'system.read' },
  { href: '/admin/operations/jobs', label: 'ao.nav.jobs', permission: 'jobs.read' },
  { href: '/admin/operations/audit', label: 'ao.nav.audit', permission: 'audit.read' },
  { href: '/admin/operations/deliveries', label: 'ao.nav.deliveries', permission: 'audit.read' },
  { href: '/admin/operations/events', label: 'ao.nav.events', permission: 'system.read' },
  { href: '/admin/operations/health', label: 'ao.nav.health', permission: 'selftest.read' },
  { href: '/admin/operations/instances', label: 'ao.nav.instances', permission: 'system.read' },
  { href: '/admin/operations/usage', label: 'ao.nav.usage', permission: 'tenants.read' },
];

export function OpsTabs() {
  const t = useT();
  const { can } = useAdmin();
  const path = usePathname();
  return (
    <nav aria-label={t('ao.tabs.label')} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1 border-b border-line">
        {OPS_TABS.filter((i) => can(i.permission)).map((i) => {
          const active = path === i.href;
          return (
            <li key={i.href}>
              <Link
                href={i.href} aria-current={active ? 'page' : undefined}
                className={cn('flex min-h-11 items-center border-b-2 px-3 text-[13px] font-medium transition-colors', active ? 'border-brand text-white' : 'border-transparent text-mute hover:text-soft')}
              >{t(i.label)}</Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Page frame of every operations page: header, the shared tabs, then the content. */
export function OpsPage({ title, subtitle, right, children }: { title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={t('ao.eyebrow')} title={title} subtitle={subtitle} right={right} />
      <OpsTabs />
      {children}
    </div>
  );
}

/** A scrollable, keyboard-focusable table region (phones scroll sideways inside it instead of the page scrolling). */
export function DataTable({ caption, head, children, min = 640 }: { caption: string; head: { label: string; right?: boolean }[]; children: React.ReactNode; min?: number }) {
  return (
    <div role="region" aria-label={caption} tabIndex={0} className="relative overflow-x-auto rounded-2xl border border-line focus-visible:outline-2">
      <table className="w-full text-left text-[13px]" style={{ minWidth: min }}>
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-line bg-panel/60 text-xs uppercase tracking-wider text-dim">
          <tr>{head.map((h, i) => <th key={i} scope="col" className={cn('px-3 py-3 first:px-4', h.right && 'text-right')}>{h.label}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, right, className, mono }: { children?: React.ReactNode; right?: boolean; className?: string; mono?: boolean }) => (
  <td className={cn('px-3 py-2.5 align-top text-soft first:px-4', right && 'text-right tabular-nums', mono && 'font-mono text-xs', className)}>{children}</td>
);

/** Horizontal bars with the number written out (never colour alone). */
export function BarList({ label, rows }: { label: string; rows: { key: string; label: React.ReactNode; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-[13px] sm:grid-cols-[minmax(0,12rem)_1fr_auto]">
          <span className="truncate text-soft">{r.label}</span>
          <span aria-hidden="true" className="h-2 rounded-full bg-raised"><span className="block h-2 rounded-full bg-brand" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} /></span>
          <span className="tabular-nums text-white">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

export function SeverityBadge({ severity }: { severity: 'critical' | 'warning' | 'info' }) {
  const t = useT();
  return <Badge tone={severity === 'critical' ? 'emergency' : severity === 'warning' ? 'unsure' : 'sky'}>{t(`ao.severity.${severity}` as MessageKey)}</Badge>;
}

/** Re-run `fn` every `ms` while the tab is visible (a dashboard that stays current without a manual refresh). */
export function usePoll(fn: () => void, ms: number): void {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') ref.current(); }, ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useFormat() {
  const locale = useLocale();
  const tag = locale === 'es' ? 'es-US' : 'en-US';
  return {
    n: (v: number) => new Intl.NumberFormat(tag).format(v),
    pct: (v: number | null) => (v === null ? '-' : `${new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(v)}%`),
    money: (cents: number, currency: string | null) => { try { return new Intl.NumberFormat(tag, { style: 'currency', currency: currency ?? 'USD' }).format(cents / 100); } catch { return String(cents / 100); } },
    when: (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : ''),
    day: (iso: string) => new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)),
    ago: (iso: string | null | undefined, now: number) => {
      if (!iso) return '';
      const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
      const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style: 'short' });
      return m < 60 ? rtf.format(-m, 'minute') : m < 1440 ? rtf.format(-Math.floor(m / 60), 'hour') : rtf.format(-Math.floor(m / 1440), 'day');
    },
  };
}
