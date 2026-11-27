'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { EmptyStateInline } from './empty-inline';
import { BILLING_STATUSES, minutesOf, TENANT_STATUSES, type PlanView, type TenantList, type TenantRow } from './tenant-api';
import { useJson } from './use-json';
import { ErrorPanel, formatWhen, LoadingBlock } from './ui';

interface Filters { q: string; status: string; billing_status: string; plan: string; trial: boolean; past_due: boolean; comped: boolean; suspended: boolean }
const EMPTY: Filters = { q: '', status: '', billing_status: '', plan: '', trial: false, past_due: false, comped: false, suspended: false };
const TRIAL_DAYS = 7;

export function queryOf(f: Filters, cursor?: string | null): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.status) p.set('status', f.status);
  if (f.billing_status) p.set('billing_status', f.billing_status);
  if (f.plan) p.set('plan', f.plan);
  if (f.trial) p.set('trial_ending_days', String(TRIAL_DAYS));
  if (f.past_due) p.set('past_due', '1');
  if (f.comped) p.set('comped', '1');
  if (f.suspended) p.set('suspended', '1');
  p.set('limit', '25');
  if (cursor) p.set('cursor', cursor);
  return `/api/admin/tenants?${p.toString()}`;
}

function BillingBadge({ row }: { row: TenantRow }) {
  const t = useT();
  const tone = row.billing_status === 'active' ? 'routine' : row.billing_status === 'past_due' || row.billing_status === 'unpaid' ? 'emergency' : row.billing_status === 'trialing' ? 'sky' : 'neutral';
  return <Badge tone={tone}>{t(`at.billing.${row.billing_status}` as MessageKey)}</Badge>;
}

export function TenantsPage() {
  const t = useT();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const plans = useJson<{ plans: PlanView[] }>('/api/admin/plans?archived=1');
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const toggles: { k: 'trial' | 'past_due' | 'comped' | 'suspended'; label: MessageKey }[] = [
    { k: 'trial', label: 'at.filter.trialEnding' }, { k: 'past_due', label: 'at.filter.pastDue' }, { k: 'comped', label: 'at.filter.comped' }, { k: 'suspended', label: 'at.filter.suspended' },
  ];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={t('at.page.eyebrow')} title={t('at.tenants.title')} subtitle={t('at.tenants.sub')} />
      <Card className="p-4">
        <form role="search" aria-label={t('at.filter.label')} onSubmit={(e) => { e.preventDefault(); setApplied(draft); }} className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextField label={t('at.filter.search')} hint={t('at.filter.searchHint')} value={draft.q} onChange={(e) => set('q', e.target.value)} maxLength={100} autoComplete="off" className="sm:col-span-2" type="search" />
            <SelectField label={t('at.filter.status')} value={draft.status} onChange={(e) => set('status', e.target.value)}>
              <option value="">{t('at.filter.any')}</option>
              {TENANT_STATUSES.map((s) => <option key={s} value={s}>{t(`at.status.${s}` as MessageKey)}</option>)}
            </SelectField>
            <SelectField label={t('at.filter.billing')} value={draft.billing_status} onChange={(e) => set('billing_status', e.target.value)}>
              <option value="">{t('at.filter.any')}</option>
              {BILLING_STATUSES.map((s) => <option key={s} value={s}>{t(`at.billing.${s}` as MessageKey)}</option>)}
            </SelectField>
            <SelectField label={t('at.filter.plan')} value={draft.plan} onChange={(e) => set('plan', e.target.value)}>
              <option value="">{t('at.filter.any')}</option>
              {(plans.data?.plans ?? []).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </SelectField>
          </div>
          <fieldset className="flex flex-wrap gap-x-5 gap-y-1">
            <legend className="sr-only">{t('at.filter.flags')}</legend>
            {toggles.map((x) => (
              <label key={x.k} className="flex min-h-11 items-center gap-2 text-[13px] text-soft">
                <input type="checkbox" checked={draft[x.k]} onChange={(e) => set(x.k, e.target.checked)} className="h-4 w-4 accent-[#ff6b35]" />
                {t(x.label, { days: TRIAL_DAYS })}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">{t('at.filter.apply')}</Button>
            <Button variant="outline" onClick={() => { setDraft(EMPTY); setApplied(EMPTY); }}>{t('at.filter.reset')}</Button>
          </div>
        </form>
      </Card>
      <Results key={queryOf(applied)} filters={applied} />
    </div>
  );
}

function Results({ filters }: { filters: Filters }) {
  const t = useT();
  const first = useJson<TenantList>(queryOf(filters));
  const [more, setMore] = useState<{ items: TenantRow[]; cursor: string | null | undefined; busy: boolean; error: unknown }>({ items: [], cursor: undefined, busy: false, error: null });
  if (first.loading && !first.data) return <LoadingBlock />;
  if (first.error && !first.data) return <ErrorPanel error={first.error} onRetry={first.reload} />;
  const items = [...(first.data?.items ?? []), ...more.items];
  const cursor = more.cursor === undefined ? first.data?.next_cursor ?? null : more.cursor;
  async function loadMore() {
    setMore((m) => ({ ...m, busy: true, error: null }));
    try {
      const page = await apiRequest<TenantList>(queryOf(filters, cursor));
      setMore((m) => ({ items: [...m.items, ...page.items], cursor: page.next_cursor, busy: false, error: null }));
    } catch (error) { setMore((m) => ({ ...m, busy: false, error })); }
  }
  if (items.length === 0) return <EmptyStateInline title={t('at.tenants.emptyTitle')} body={t('at.tenants.emptyBody')} />;
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-[13px] text-mute">{t('at.tenants.shown', { n: items.length })}</p>
      <div className="hidden overflow-x-auto rounded-2xl border border-line md:block">
        <table className="w-full min-w-[820px] text-left text-[13px]">
          <caption className="sr-only">{t('at.tenants.title')}</caption>
          <thead className="border-b border-line bg-panel/60 text-xs uppercase tracking-wider text-dim">
            <tr>
              <th scope="col" className="px-4 py-3">{t('at.col.business')}</th>
              <th scope="col" className="px-3 py-3">{t('at.col.status')}</th>
              <th scope="col" className="px-3 py-3">{t('at.col.plan')}</th>
              <th scope="col" className="px-3 py-3">{t('at.col.trialEnds')}</th>
              <th scope="col" className="px-3 py-3 text-right">{t('at.col.sms')}</th>
              <th scope="col" className="px-3 py-3 text-right">{t('at.col.calls')}</th>
              <th scope="col" className="px-3 py-3 text-right">{t('at.col.forward')}</th>
              <th scope="col" className="px-3 py-3 text-right">{t('at.col.voicemail')}</th>
            </tr>
          </thead>
          <tbody>{items.map((r) => <Row key={r.id} r={r} />)}</tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-3 md:hidden">{items.map((r) => <CardRow key={r.id} r={r} />)}</ul>
      {more.error ? <ErrorPanel error={more.error} onRetry={() => void loadMore()} /> : null}
      {cursor ? <Button variant="outline" onClick={() => void loadMore()} disabled={more.busy} className="self-start">{more.busy ? t('common.loading') : t('at.tenants.loadMore')}</Button> : null}
    </div>
  );
}

function Flags({ r }: { r: TenantRow }) {
  const t = useT();
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone={r.status === 'live' ? 'routine' : 'neutral'}>{t(`at.status.${r.status}` as MessageKey)}</Badge>
      <BillingBadge row={r} />
      {r.suspended_at ? <Badge tone="emergency">{t('at.flag.suspended')}</Badge> : null}
      {r.comped ? <Badge tone="brand">{t('at.flag.comped')}</Badge> : null}
    </span>
  );
}

function Row({ r }: { r: TenantRow }) {
  const locale = useLocale();
  return (
    <tr className="border-b border-line last:border-0 hover:bg-hover/40">
      <th scope="row" className="px-4 py-3 text-left font-medium">
        <Link href={`/admin/tenants/${r.id}`} className="text-white hover:underline">{r.name}</Link>
        <span className="mt-0.5 block text-xs font-normal text-dim">{r.owner_email ?? r.phone ?? r.id.slice(0, 8)}</span>
      </th>
      <td className="px-3 py-3"><Flags r={r} /></td>
      <td className="px-3 py-3 text-soft">{r.plan ?? '-'}</td>
      <td className="px-3 py-3 text-soft">{r.billing_status === 'trialing' ? formatWhen(r.trial_ends_at, locale) : ''}</td>
      <td className="px-3 py-3 text-right tabular-nums text-soft">{r.usage.sms_count}</td>
      <td className="px-3 py-3 text-right tabular-nums text-soft">{minutesOf(r.usage.call_seconds)}</td>
      <td className="px-3 py-3 text-right tabular-nums text-soft">{minutesOf(r.usage.forward_seconds)}</td>
      <td className="px-3 py-3 text-right tabular-nums text-soft">{minutesOf(r.usage.voicemail_seconds)}</td>
    </tr>
  );
}

function CardRow({ r }: { r: TenantRow }) {
  const t = useT();
  return (
    <li>
      <Link href={`/admin/tenants/${r.id}`} className="block rounded-2xl border border-line bg-panel/80 p-4 hover:bg-hover/40">
        <span className="block text-[15px] font-semibold text-white">{r.name}</span>
        <span className="block text-xs text-dim">{r.owner_email ?? r.phone ?? r.id.slice(0, 8)}</span>
        <span className="mt-2 block"><Flags r={r} /></span>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-mute">
          <dt>{t('at.col.plan')}</dt><dd className="text-right text-soft">{r.plan ?? '-'}</dd>
          <dt>{t('at.col.sms')}</dt><dd className="text-right tabular-nums text-soft">{r.usage.sms_count}</dd>
          <dt>{t('at.col.calls')}</dt><dd className="text-right tabular-nums text-soft">{minutesOf(r.usage.call_seconds)}</dd>
          <dt>{t('at.col.forward')}</dt><dd className="text-right tabular-nums text-soft">{minutesOf(r.usage.forward_seconds)}</dd>
        </dl>
      </Link>
    </li>
  );
}
