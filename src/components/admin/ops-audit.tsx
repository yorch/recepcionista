'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { useT } from '@/lib/i18n/client';
import { EmptyStateInline } from './empty-inline';
import { DataTable, OpsPage, Td, useFormat } from './ops-ui';
import { useAdmin } from './provider';
import { ErrorPanel, LoadingBlock } from './ui';
import { useJson } from './use-json';

export interface AuditRow {
  id: string; at: string; actor_kind: string; actor_user_id: string | null; actor_email: string | null; business_id: string | null; business_name: string | null;
  action: string; target: string; ip: string | null; meta: unknown;
}
interface Page { items: AuditRow[]; next_cursor: string | null }
interface Filters { actor: string; action: string; business_id: string; from: string; to: string; q: string }
const EMPTY: Filters = { actor: '', action: '', business_id: '', from: '', to: '', q: '' };
const ACTOR_KINDS = ['user', 'admin_token', 'system', 'webhook'] as const;

/** Query string of the audit routes (also the export): only non-empty filters; the dates are datetime-local values converted to ISO. */
export function auditQuery(f: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (f.actor.trim()) p.set('actor', f.actor.trim());
  if (f.action.trim()) p.set('action', f.action.trim());
  if (f.business_id.trim()) p.set('business_id', f.business_id.trim());
  const iso = (v: string) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); };
  if (f.from && iso(f.from)) p.set('from', iso(f.from));
  if (f.to && iso(f.to)) p.set('to', iso(f.to));
  if (f.q.trim()) p.set('q', f.q.trim());
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

export function AuditPage() {
  const t = useT();
  const { can } = useAdmin();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const exportOk = can('audit.export');
  return (
    <OpsPage title={t('ao.audit.title')} subtitle={t('ao.audit.sub')}>
      <Card className="p-4">
        <form role="search" aria-label={t('ao.audit.filters')} onSubmit={(e) => { e.preventDefault(); setApplied(draft); }} className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <SelectField label={t('ao.audit.actorKind')} value={ACTOR_KINDS.includes(draft.actor as never) ? draft.actor : draft.actor ? 'other' : ''} onChange={(e) => set('actor', e.target.value === 'other' ? '' : e.target.value)}>
              <option value="">{t('ao.any')}</option>
              {ACTOR_KINDS.map((k) => <option key={k} value={k}>{t(`ao.actor.${k}`)}</option>)}
              {draft.actor && !ACTOR_KINDS.includes(draft.actor as never) ? <option value="other">{t('ao.audit.actorOther')}</option> : null}
            </SelectField>
            <TextField label={t('ao.audit.actorId')} hint={t('ao.audit.actorIdHint')} value={ACTOR_KINDS.includes(draft.actor as never) ? '' : draft.actor} onChange={(e) => set('actor', e.target.value)} mono maxLength={64} autoComplete="off" />
            <TextField label={t('ao.audit.action')} hint={t('ao.audit.actionHint')} value={draft.action} onChange={(e) => set('action', e.target.value)} mono maxLength={120} autoComplete="off" />
            <TextField label={t('ao.audit.business')} hint={t('ao.audit.businessHint')} value={draft.business_id} onChange={(e) => set('business_id', e.target.value)} mono maxLength={64} autoComplete="off" />
            <TextField label={t('ao.audit.from')} type="datetime-local" value={draft.from} onChange={(e) => set('from', e.target.value)} />
            <TextField label={t('ao.audit.to')} type="datetime-local" value={draft.to} onChange={(e) => set('to', e.target.value)} />
            <TextField label={t('ao.audit.text')} hint={t('ao.audit.textHint')} type="search" value={draft.q} onChange={(e) => set('q', e.target.value)} maxLength={100} className="sm:col-span-2 lg:col-span-3" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit">{t('ao.audit.apply')}</Button>
            <Button variant="outline" onClick={() => { setDraft(EMPTY); setApplied(EMPTY); }}>{t('ao.audit.reset')}</Button>
            {exportOk ? (
              <span className="ml-auto flex flex-wrap items-center gap-2">
                <span className="text-xs text-dim">{t('ao.audit.exportNote')}</span>
                <a className={buttonClass('outline')} href={`/api/admin/audit?${auditQuery(applied, { export: '1', format: 'csv', limit: '5000' })}`} download="audit.csv">{t('ao.audit.exportCsv')}</a>
                <a className={buttonClass('outline')} href={`/api/admin/audit?${auditQuery(applied, { export: '1', format: 'json', limit: '5000' })}`} download="audit.json">{t('ao.audit.exportJson')}</a>
              </span>
            ) : <span className="ml-auto text-xs text-dim">{t('ao.audit.exportDenied')}</span>}
          </div>
        </form>
      </Card>
      <Results key={auditQuery(applied)} filters={applied} />
    </OpsPage>
  );
}

function Results({ filters }: { filters: Filters }) {
  const t = useT();
  const fmt = useFormat();
  const url = (before?: string | null) => `/api/admin/audit?${auditQuery(filters, { limit: '50', ...(before ? { before } : {}) })}`;
  const first = useJson<Page>(url());
  const [more, setMore] = useState<{ items: AuditRow[]; cursor: string | null | undefined; busy: boolean; error: unknown }>({ items: [], cursor: undefined, busy: false, error: null });
  const [openId, setOpenId] = useState<string | null>(null);
  if (first.loading && !first.data) return <LoadingBlock />;
  if (first.error && !first.data) return <ErrorPanel error={first.error} onRetry={first.reload} />;
  const items = [...(first.data?.items ?? []), ...more.items];
  const cursor = more.cursor === undefined ? first.data?.next_cursor ?? null : more.cursor;
  async function loadMore() {
    setMore((m) => ({ ...m, busy: true, error: null }));
    try { const page = await apiRequest<Page>(url(cursor)); setMore((m) => ({ items: [...m.items, ...page.items], cursor: page.next_cursor, busy: false, error: null })); } catch (error) { setMore((m) => ({ ...m, busy: false, error })); }
  }
  if (items.length === 0) return <EmptyStateInline title={t('ao.audit.emptyTitle')} body={t('ao.audit.emptyBody')} />;
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-[13px] text-mute">{t('ao.audit.shown', { n: items.length })}</p>
      <DataTable caption={t('ao.audit.title')} min={900} head={[{ label: t('ao.audit.col.when') }, { label: t('ao.audit.col.actor') }, { label: t('ao.audit.col.action') }, { label: t('ao.audit.col.business') }, { label: t('ao.audit.col.target') }, { label: t('ao.audit.col.details') }]}>
        {items.flatMap((r) => {
          const open = openId === r.id;
          const hasMeta = r.meta && typeof r.meta === 'object' && Object.keys(r.meta as object).length > 0;
          return [
            <tr key={r.id} className="border-b border-line">
              <Td className="whitespace-nowrap">{fmt.when(r.at)}</Td>
              <Td>
                <Badge tone={r.actor_kind === 'admin_token' ? 'unsure' : 'neutral'}>{t(`ao.actor.${r.actor_kind as (typeof ACTOR_KINDS)[number]}`)}</Badge>
                {r.actor_email ? <span className="mt-0.5 block break-all text-xs text-dim">{r.actor_email}</span> : r.actor_user_id ? <span className="mt-0.5 block font-mono text-xs text-dim">{r.actor_user_id.slice(0, 8)}</span> : null}
              </Td>
              <Td mono className="break-all">{r.action}</Td>
              <Td>{r.business_id ? <Link href={`/admin/tenants/${r.business_id}`} className="underline">{r.business_name ?? r.business_id.slice(0, 8)}</Link> : <span className="text-dim">-</span>}</Td>
              <Td mono className="max-w-[14rem] break-all">{r.target}</Td>
              <Td>
                {hasMeta ? <Button variant="ghost" className="min-h-11" aria-expanded={open} onClick={() => setOpenId(open ? null : r.id)}>{open ? t('ao.audit.hide') : t('ao.audit.show')}<span className="sr-only"> {r.action}</span></Button> : <span className="text-dim">-</span>}
              </Td>
            </tr>,
            open ? <tr key={`${r.id}-m`} className="border-b border-line bg-sunken/50"><td colSpan={6} className="px-4 py-3"><MetaView row={r} /></td></tr> : null,
          ];
        })}
      </DataTable>
      {more.error ? <ErrorPanel error={more.error} onRetry={() => void loadMore()} /> : null}
      {cursor ? <Button variant="outline" className="self-start" onClick={() => void loadMore()} disabled={more.busy}>{more.busy ? t('common.loading') : t('ao.loadMore')}</Button> : null}
    </div>
  );
}

interface KeyDiff { key: string; old?: unknown; new?: unknown; old_fp?: string; new_fp?: string }
const show = (v: unknown): string => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** The structured diff of a `settings.change` / `settings.rollback` row (old -> new per key, secrets as fingerprints), else the meta as a key table. */
export function MetaView({ row }: { row: AuditRow }) {
  const t = useT();
  const m = (row.meta ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(m.keys) && (row.action === 'settings.change' || row.action === 'settings.rollback') ? (m.keys as KeyDiff[]) : null;
  const rest = Object.entries(m).filter(([k]) => !(keys && k === 'keys'));
  return (
    <div className="flex flex-col gap-3">
      {keys ? (
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-dim">{t('ao.audit.diff')}</p>
          <DataTable caption={t('ao.audit.diff')} min={520} head={[{ label: t('ao.audit.diffKey') }, { label: t('ao.audit.diffOld') }, { label: t('ao.audit.diffNew') }]}>
            {keys.map((k) => (
              <tr key={k.key} className="border-b border-line last:border-0">
                <Td mono>{k.key}</Td>
                <Td mono className="break-all text-danger">{k.old_fp ? `#${k.old_fp}` : show(k.old) || <span className="text-dim">{t('ao.audit.unset')}</span>}</Td>
                <Td mono className="break-all text-mint-text">{k.new_fp ? `#${k.new_fp}` : show(k.new) || <span className="text-dim">{t('ao.audit.unset')}</span>}</Td>
              </tr>
            ))}
          </DataTable>
        </div>
      ) : null}
      {rest.length ? (
        <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-1 text-[13px]" aria-label={t('ao.audit.meta')}>
          {rest.map(([k, v]) => (<div key={k} className="contents"><dt className="font-mono text-xs text-dim">{k}</dt><dd className="break-words font-mono text-xs text-soft">{show(v)}</dd></div>))}
        </dl>
      ) : null}
      {row.ip ? <p className="text-xs text-dim">{t('ao.audit.ip', { ip: row.ip })}</p> : null}
    </div>
  );
}
