'use client';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyStateInline } from './empty-inline';
import { TextField } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { allSettings } from '@/lib/config/registry';
import { confirmPhrase, displayValue } from '@/lib/admin-ui/model';
import type { ApplyResult, ChangeSetView } from '@/lib/admin/settings-store';
import { useLabelOf } from './change-review';
import { useJson } from './use-json';
import { phraseFromError } from './errors';
import { useAdmin } from './provider';
import { confirmReady, ConfirmFields, ErrorPanel, formatWhen, LoadingBlock, Problems, TierBadge } from './ui';
import { ExportImport } from './import-export';

interface Page { items: ChangeSetView[]; next_cursor: string | null }
const STATUS_TONE: Record<string, string> = { applied: 'routine', rolled_back: 'neutral', pending_approval: 'unsure', scheduled: 'sky' };

/** Change history: every change set (who, when, tier, reason, keys), its diff, and rollback as a NEW change set. Export / import lives below. */
export function HistoryPage() {
  const t = useT();
  const [filter, setFilter] = useState('');
  const [applied, setApplied] = useState('');
  const [tick, setTick] = useState(0);
  const keys = useMemo(() => allSettings().map((d) => d.key).sort(), []);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('ac.page.history.title')} subtitle={t('ac.page.history.sub')} />
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setApplied(filter.trim()); }} role="search" aria-label={t('ac.history.filter')}>
        <TextField label={t('ac.history.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} list="ac-history-keys" mono className="min-w-64 flex-1" placeholder={t('ac.history.filterPh')} />
        <datalist id="ac-history-keys">{keys.map((k) => <option key={k} value={k} />)}</datalist>
        <Button type="submit" variant="outline">{t('ac.history.apply')}</Button>
        {applied ? <Button variant="ghost" onClick={() => { setFilter(''); setApplied(''); }}>{t('ac.history.clear')}</Button> : null}
      </form>
      <HistoryList key={`${applied}#${tick}`} filterKey={applied} onChanged={() => setTick((n) => n + 1)} />
      <ExportImport />
    </div>
  );
}

/** One filter's pages: the first comes from the hook, "load older" appends. A new filter or a rollback remounts it (fresh state, no effect-driven resets). */
function HistoryList({ filterKey, onChanged }: { filterKey: string; onChanged: () => void }) {
  const t = useT();
  const qs = new URLSearchParams({ limit: '25' });
  if (filterKey) qs.set('key', filterKey);
  const first = useJson<Page>(`/api/admin/settings/history?${qs}`);
  const [more, setMore] = useState<ChangeSetView[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const items = [...(first.data?.items ?? []), ...more];
  const next = cursor === undefined ? first.data?.next_cursor ?? null : cursor;

  async function loadMore() {
    if (!next) return;
    setBusy(true); setMoreError(null);
    try {
      const q = new URLSearchParams({ limit: '25', before: next });
      if (filterKey) q.set('key', filterKey);
      const page = await apiRequest<Page>(`/api/admin/settings/history?${q}`);
      setMore((cur) => [...cur, ...page.items]);
      setCursor(page.next_cursor);
    } catch (e) { setMoreError(e); } finally { setBusy(false); }
  }

  if (first.loading && !first.data) return <LoadingBlock rows={4} />;
  if (first.error && !first.data) return <ErrorPanel error={first.error} onRetry={first.reload} />;
  if (items.length === 0) return <EmptyStateInline title={t('ac.history.emptyTitle')} body={t('ac.history.emptyBody')} />;
  return (
    <>
      <ol className="flex flex-col gap-3" aria-label={t('ac.page.history.title')}>
        {items.map((cs) => <ChangeSetCard key={cs.id} cs={cs} onRolledBack={onChanged} />)}
      </ol>
      {moreError ? <ErrorPanel error={moreError} /> : null}
      {next ? <div><Button variant="outline" disabled={busy} onClick={() => void loadMore()}>{busy ? t('common.loading') : t('ac.history.more')}</Button></div> : null}
    </>
  );
}

function ChangeSetCard({ cs, onRolledBack }: { cs: ChangeSetView; onRolledBack: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { can } = useAdmin();
  const labelOf = useLabelOf();
  const [detail, setDetail] = useState<ChangeSetView | null>(null);
  const [open, setOpen] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [rolling, setRolling] = useState(false);

  async function ensureDetail() {
    if (detail) return;
    try { setDetail(await apiRequest<ChangeSetView>(`/api/admin/settings/history/${cs.id}`)); setLoadError(null); } catch (e) { setLoadError(e); }
  }
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) await ensureDetail();
  }

  const critical = cs.tier === 'critical';
  const mayRollback = cs.status === 'applied' && can('settings.rollback') && (!critical || can('settings.rollback.critical'));

  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-semibold text-white">{t('ac.history.version', { n: cs.version })}</span>
              <Badge tone={STATUS_TONE[cs.status] ?? 'neutral'}>{t(`ac.history.status.${cs.status}` as MessageKey)}</Badge>
              <TierBadge tier={cs.tier as 'normal' | 'sensitive' | 'critical'} />
              <Badge>{t(`ac.history.via.${cs.via}` as MessageKey)}</Badge>
            </div>
            <p className="mt-1 text-xs text-dim">
              {formatWhen(cs.at, locale)} · {cs.created_by ? <span title={cs.created_by}>{t('ac.history.byUser', { id: cs.created_by.slice(0, 8) })}</span> : t('ac.history.byToken')}
            </p>
            {cs.reason ? <p className="mt-1.5 text-[13px] text-soft">“{cs.reason}”</p> : null}
            {cs.rollback_of ? <p className="mt-1 text-xs text-dim">{t('ac.history.rollbackOf', { id: cs.rollback_of.slice(0, 8) })}</p> : null}
            <p className="mt-1.5 text-xs text-mute">{cs.keys.slice(0, 4).map((k) => labelOf(k)).join(', ')}{cs.keys.length > 4 ? ` +${cs.keys.length - 4}` : ''}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" aria-expanded={open} onClick={() => void toggle()}>{open ? t('ac.history.hide') : t('ac.history.show')}</Button>
            {mayRollback ? <Button variant="danger" onClick={() => { setRolling(true); setOpen(true); void ensureDetail(); }}>{t('ac.history.rollback')}</Button> : null}
          </div>
        </div>
        {open ? (
          <div className="border-t border-line px-5 py-4">
            {loadError ? <ErrorPanel error={loadError} /> : !detail ? <LoadingBlock rows={2} /> : (
              <ul className="flex flex-col gap-3">
                {(detail.revisions ?? []).map((r) => (
                  <li key={r.key} className="rounded-xl border border-line bg-sunken p-3">
                    <div className="flex flex-wrap items-center gap-2"><span className="text-[13px] font-medium text-white">{labelOf(r.key)}</span><code className="font-mono text-[11px] text-dim">{r.key}</code></div>
                    <dl className="mt-1.5 grid gap-1 text-[12px] sm:grid-cols-[auto_1fr] sm:gap-x-3">
                      <dt className="text-dim">{t('ac.diff.before')}</dt>
                      <dd className="break-words font-mono text-danger"><span aria-hidden="true">− </span>{r.old_fingerprint ? t('ac.history.fingerprint', { fp: r.old_fingerprint }) : displayValue(r.old_present ? r.old : null, t('ac.diff.unset'))}</dd>
                      <dt className="text-dim">{t('ac.diff.after')}</dt>
                      <dd className="break-words font-mono text-mint-text"><span aria-hidden="true">+ </span>{r.op === 'remove' ? t('ac.diff.backToDefault') : r.new_fingerprint ? t('ac.history.fingerprint', { fp: r.new_fingerprint }) : displayValue(r.new, t('ac.diff.unset'))}</dd>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
            {rolling && detail ? <RollbackPanel cs={detail} onCancel={() => setRolling(false)} onDone={() => { setRolling(false); onRolledBack(); }} /> : null}
          </div>
        ) : null}
      </Card>
    </li>
  );
}

function RollbackPanel({ cs, onCancel, onDone }: { cs: ChangeSetView; onCancel: () => void; onDone: () => void }) {
  const t = useT();
  const { guard } = useAdmin();
  const labelOf = useLabelOf();
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [phrase, setPhrase] = useState<string | null>(cs.tier === 'critical' ? confirmPhrase(cs.keys) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ready = !busy && confirmReady({ reasonRequired: true, reason, phrase, typed });

  async function run() {
    setBusy(true);
    setError(null);
    try {
      let result: ApplyResult | null = null;
      await guard(async () => { result = await apiRequest<ApplyResult>('/api/admin/settings/rollback', { body: { change_set_id: cs.id, reason: reason.trim(), confirm: typed.trim() || undefined } }); });
      if (result) { toast.success(t('ac.history.rolledBack')); onDone(); }
    } catch (e) {
      const p = phraseFromError(e);
      if (p) { setPhrase(p); setTyped(''); }
      setError(e);
    } finally { setBusy(false); }
  }

  return (
    <div role="group" aria-label={t('ac.history.rollbackTitle')} className="mt-4 flex flex-col gap-3 rounded-xl border border-danger-line bg-danger-bg/30 p-4">
      <p className="text-[13px] text-soft">{t('ac.history.rollbackBody', { n: cs.keys.length })}</p>
      <ConfirmFields reasonRequired phrase={phrase} reason={reason} onReason={setReason} typed={typed} onTyped={setTyped} />
      {error ? <Problems error={error} labelOf={labelOf} /> : null}
      <div className="flex gap-2">
        <Button variant="danger" disabled={!ready} onClick={() => void run()}>{busy ? t('ac.review.applying') : t('ac.history.rollbackDo')}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}

