'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextAreaField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import { formatPhoneDisplay, type MessageKey } from '@/lib/i18n/core';
import { whenET } from '@/lib/format';
import { MANUAL_TEXT_MAX } from '@/lib/messaging/manual-limits';
import type { InboxDetail, InboxItem, InboxPage } from '@/lib/messaging/inbox-view';
import type { InboundStatus } from '@/lib/types';
import { messageErrorText, statusTone } from '@/components/dashboard/messages-shared';

type Filter = InboundStatus | 'all';
const FILTERS: Filter[] = ['new', 'handled', 'ignored', 'all'];

/** The inbox: the list of customer texts (filter, load more), and the selected message with its conversation, triage actions and a reply box. */
export function MessagesInbox({ businessId, tz, initial, initialFilter }: { businessId: string; tz: string; initial: InboxPage; initialFilter: Filter }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [items, setItems] = useState<InboxItem[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.next_cursor);
  const [counts, setCounts] = useState(initial.counts);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<InboxDetail | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailRef = useRef<HTMLHeadingElement>(null);
  const base = `/api/businesses/${businessId}/messages`;

  const loadList = useCallback(async (f: Filter, after: string | null) => {
    setLoading(true);
    setListError(false);
    try {
      const q = new URLSearchParams({ status: f });
      if (after) q.set('cursor', after);
      const page = await apiRequest<InboxPage>(`${base}?${q}`);
      setItems((prev) => (after ? [...prev, ...page.items] : page.items));
      setCursor(page.next_cursor);
      setCounts(page.counts);
    } catch {
      setListError(true);
    } finally {
      setLoading(false);
    }
  }, [base]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await apiRequest<InboxDetail>(`${base}/${id}`));
    } catch (e) {
      setDetail(null);
      setError(messageErrorText(t, e));
    }
  }, [base, t]);

  function select(id: string) {
    setSelected(id);
    setError(null);
    setReply('');
    void loadDetail(id);
  }
  useEffect(() => { if (detail) detailRef.current?.focus(); }, [detail?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(f: Filter) {
    setFilter(f);
    setSelected(null);
    setDetail(null);
    void loadList(f, null);
  }

  async function setStatus(status: InboundStatus) {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`${base}/${detail.id}`, { method: 'PATCH', body: { status } });
      toast.success(t('msg.action.done'));
      await Promise.all([loadList(filter, null), loadDetail(detail.id)]);
      router.refresh(); // the sidebar badge
    } catch (e) {
      setError(messageErrorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  async function optOut() {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`${base}/${detail.id}/opt-out`, { method: 'POST', body: {} });
      toast.success(t('msg.optout.done'));
      await Promise.all([loadList(filter, null), loadDetail(detail.id)]);
      router.refresh();
    } catch (e) {
      setError(messageErrorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || busy || !reply.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`${base}/${detail.id}/reply`, { method: 'POST', body: { body: reply } });
      toast.success(t('msg.reply.sent'));
      setReply('');
      await Promise.all([loadList(filter, null), loadDetail(detail.id)]);
      router.refresh();
    } catch (err) {
      setError(messageErrorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const label = (f: Filter) => (f === 'all' ? t('msg.filter.all') : t(`msg.filter.${f}` as MessageKey, { count: counts[f] }));
  const when = (iso: string) => whenET(iso, tz, locale);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <section aria-label={t('msg.list.label')} className="min-w-0">
        <div role="group" aria-label={t('msg.filter.label')} className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => pick(f)}
              className={`inline-flex min-h-11 items-center rounded-xl px-3 text-[13px] font-medium ${filter === f ? 'bg-raised text-white' : 'text-mute hover:bg-hover hover:text-soft'}`}
            >
              {label(f)}
            </button>
          ))}
        </div>
        {items.length === 0 && !loading ? (
          <Card className="mt-3 px-5 py-8 text-center">
            <h2 className="text-[14px] font-semibold text-white">{t('msg.empty.title')}</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-mute">{filter === 'new' ? t('msg.empty.new') : t('msg.empty.other')}</p>
          </Card>
        ) : (
          <ul className="mt-3 flex flex-col gap-2" aria-live="polite">
            {items.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => select(m.id)}
                  aria-current={selected === m.id ? 'true' : undefined}
                  className={`block min-h-11 w-full rounded-xl border p-3.5 text-left transition-colors ${selected === m.id ? 'border-brand/60 bg-raised' : 'border-line bg-panel hover:bg-hover'}`}
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs text-dim">{t('msg.from', { last4: m.from_last4 })}</span>
                    <Badge tone={statusTone(m.status)}>{t(`msg.status.${m.status}` as MessageKey)}</Badge>
                  </span>
                  <span className="mt-1.5 line-clamp-2 block break-words text-[13px] text-body">{m.body}</span>
                  <span className="mt-1.5 block text-xs text-dim">{when(m.received_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {listError ? <p role="alert" className="mt-2 text-xs text-danger">{t('msg.loadFailed')}</p> : null}
        {cursor ? (
          <div className="mt-3"><Button variant="outline" disabled={loading} onClick={() => void loadList(filter, cursor)}>{loading ? t('msg.loading') : t('msg.loadMore')}</Button></div>
        ) : null}
      </section>

      <section aria-label={t('msg.detail.title')} className="min-w-0">
        {!detail ? (
          <Card className="px-5 py-8 text-center text-[13px] text-mute">{error ? <span role="alert" className="text-danger">{error}</span> : t('msg.detail.select')}</Card>
        ) : (
          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 ref={detailRef} tabIndex={-1} className="text-[15px] font-semibold text-white outline-none">{t('msg.from', { last4: detail.from_last4 })}</h2>
                <p className="mt-1 text-xs text-dim">{t('msg.detail.number')}: <a className="font-mono text-brand-soft underline-offset-2 hover:underline" href={`tel:${detail.from_e164}`} aria-label={`${t('msg.detail.call')} ${formatPhoneDisplay(detail.from_e164)}`}>{formatPhoneDisplay(detail.from_e164)}</a></p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone={statusTone(detail.status)}>{t(`msg.status.${detail.status}` as MessageKey)}</Badge>
                {detail.forwarded ? <Badge tone="neutral">{t('msg.badge.forwarded')}</Badge> : null}
                {detail.auto_replied ? <Badge tone="neutral">{t('msg.badge.autoReplied')}</Badge> : null}
                {detail.possible_opt_out ? <Badge tone="emergency">{t('msg.badge.possibleOptOut')}</Badge> : null}
              </div>
            </div>
            {detail.booking ? <p className="mt-2 text-xs text-mute">{t('msg.detail.booking', { service: detail.booking.service, when: when(detail.booking.scheduled_at) })}</p> : null}

            <h3 className="mt-4 text-xs font-medium uppercase tracking-wider text-dim">{t('msg.detail.thread')}</h3>
            <ol className="mt-2 flex max-h-80 flex-col gap-2 overflow-y-auto" aria-label={t('msg.detail.thread')}>
              {detail.thread.map((m, i) => (
                <li key={`${m.at}-${i}`} className={`max-w-[90%] rounded-xl px-3 py-2 text-[13px] ${m.direction === 'in' ? 'self-start bg-sunken text-body' : 'self-end bg-brand-bg text-[#ffd9c7]'}`}>
                  <span className="block break-words whitespace-pre-wrap">{m.body}</span>
                  <span className="mt-1 block text-[11px] text-dim">
                    {m.direction === 'in' ? t('msg.thread.in') : t('msg.thread.out')} · {when(m.at)}
                    {m.status && m.status !== 'sent' ? ` · ${t(`msg.log.status.${m.status}` as MessageKey)}` : ''}
                  </span>
                </li>
              ))}
            </ol>

            <div className="mt-4 flex flex-wrap gap-2">
              {detail.status !== 'handled' ? <Button variant="outline" disabled={busy} onClick={() => void setStatus('handled')}>{t('msg.action.handled')}</Button> : null}
              {detail.status === 'new' ? <Button variant="ghost" disabled={busy} onClick={() => void setStatus('ignored')}>{t('msg.action.ignore')}</Button> : null}
              {detail.status !== 'new' ? <Button variant="ghost" disabled={busy} onClick={() => void setStatus('new')}>{t('msg.action.reopen')}</Button> : null}
            </div>

            {detail.possible_opt_out && !detail.opted_out ? (
              <div className="mt-4 rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn">
                <p>{t('msg.optout.hint')}</p>
                <div className="mt-2"><Button variant="outline" disabled={busy} onClick={() => void optOut()}>{t('msg.optout.action')}</Button></div>
              </div>
            ) : null}

            {detail.opted_out ? (
              <p className="mt-4 rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn">{t('msg.reply.optedOut')}</p>
            ) : (
              <form onSubmit={sendReply} className="mt-4 flex flex-col gap-3">
                <TextAreaField
                  label={t('msg.reply.label')} rows={3} maxLength={MANUAL_TEXT_MAX} value={reply} onChange={(e) => setReply(e.target.value)}
                  hint={`${t('msg.reply.hint')} ${t('msg.reply.counter', { count: [...reply].length, max: MANUAL_TEXT_MAX })}`}
                />
                <div><Button type="submit" disabled={busy || !reply.trim()}>{busy ? t('msg.reply.sending') : t('msg.reply.send')}</Button></div>
              </form>
            )}
            {error ? <p role="alert" className="mt-3 text-xs text-danger">{error}</p> : null}
          </Card>
        )}
      </section>
    </div>
  );
}
