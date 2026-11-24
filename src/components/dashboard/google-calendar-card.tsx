'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, buttonClass } from '@/components/ui/button';
import { apiRequest, useApi } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { intlTag } from '@/lib/i18n/core';
import type { GoogleStatus } from '@/app/api/integrations/google/status/route';

const CHANGE_KEYS = ['time_changed_in_google', 'deleted_in_google', 'edited_in_google_before_push'] as const;

/** Settings > Google Calendar: connect / disconnect, health, calendar picker, "block on busy" switch, and notices about owner edits. */
export function GoogleCalendarCard({ initialResult }: { initialResult?: string | null }) {
  const t = useT();
  const locale = useLocale();
  const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : t('gcal.never'));
  const router = useRouter();
  const { busy, call } = useApi();
  const [st, setSt] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<{ id: string; name: string; primary: boolean }[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [deleteEvents, setDeleteEvents] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await apiRequest<GoogleStatus>('/api/integrations/google/status');
      setSt(s); setError(null);
      if (s.connected && s.status !== 'needs_reauth') {
        try { const c = await apiRequest<{ calendars: { id: string; name: string; primary: boolean }[] }>('/api/integrations/google/calendars'); setCalendars(c.calendars); } catch { setCalendars([]); }
      }
    } catch (err) { setError(errorText(t, err, 'gcal.loadFailed')); }
  }, [t]);
  useEffect(() => { const tm = setTimeout(() => { void load(); }, 0); return () => clearTimeout(tm); }, [load]);

  async function patch(body: Record<string, unknown>, success: string) {
    const r = await call('/api/integrations/google/calendar', { method: 'PATCH', body }, { success });
    if (r !== undefined) { await load(); router.refresh(); }
  }
  async function disconnect() {
    const r = await call(`/api/integrations/google/disconnect${deleteEvents ? '?delete_events=true' : ''}`, { method: 'DELETE' }, { success: t('gcal.disconnected') });
    if (r !== undefined) { setConfirming(false); await load(); router.refresh(); }
  }

  if (error) return <p role="alert" className="text-[13px] text-danger">{error}</p>;
  if (!st) return <p className="text-[13px] text-dim">{t('common.loading')}</p>;
  if (!st.configured) return <p className="text-[13px] text-mute">{t('gcal.notConfigured')}</p>;

  const flash = initialResult === 'denied' ? t('gcal.denied')
    : initialResult === 'error' ? t('gcal.errorFlash') : null;

  return (
    <div className="flex flex-col gap-4 text-[13px] text-soft">
      {st.mock ? <p className="rounded-xl border border-line-2 bg-sunken p-2 text-xs text-warn">{t('gcal.mock')}</p> : null}
      {flash ? <p role="status" className="text-warn">{flash}</p> : null}

      {!st.connected ? (
        <>
          <p>{t('gcal.intro')}</p>
          <div><a href="/api/integrations/google/connect" className={buttonClass('primary')}>{t('gcal.connect')}</a></div>
        </>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-dim">{t('gcal.account')}</dt><dd>{st.account_email}</dd>
            <dt className="text-dim">{t('gcal.status')}</dt>
            <dd className={st.status === 'active' ? 'text-success' : 'text-warn'}>
              {st.status === 'active' ? t('gcal.status.active') : st.status === 'needs_reauth' ? t('gcal.status.needs_reauth') : t('gcal.status.error')}
            </dd>
            <dt className="text-dim">{t('gcal.lastSync')}</dt><dd>{when(st.last_sync_at)}{st.push_channel ? '' : t('gcal.every15')}</dd>
          </dl>

          {st.status === 'needs_reauth' ? (
            <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg p-3 text-danger">
              {t('gcal.stopped', { detail: st.last_error ? ` (${st.last_error})` : '' })}
              <div className="mt-2"><a href="/api/integrations/google/connect" className={buttonClass('primary')}>{t('gcal.reconnect')}</a></div>
            </div>
          ) : st.last_error ? <p className="text-warn">{t('gcal.lastError', { error: st.last_error })}</p> : null}

          {st.status !== 'needs_reauth' ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-white">{t('gcal.calendarToUse')}</span>
                <select
                  value={st.calendar_id ?? 'primary'} disabled={busy} aria-label={t('gcal.calendarToUse')}
                  onChange={(e) => { if (window.confirm(t('gcal.confirmSwitch'))) void patch({ calendar_id: e.target.value }, t('gcal.calendarChanged')); }}
                  className="min-h-11 max-w-sm rounded-xl border border-line-3 bg-sunken px-2.5 text-[13px] text-soft"
                >
                  {!calendars.some((c) => c.id === st.calendar_id) ? <option value={st.calendar_id ?? 'primary'}>{st.calendar_id === 'primary' ? t('gcal.primaryCalendar') : st.calendar_id}</option> : null}
                  {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}{c.primary ? t('gcal.primarySuffix') : ''}</option>)}
                </select>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1 h-4 w-4" checked={st.block_on_busy} disabled={busy} onChange={(e) => void patch({ block_on_busy: e.target.checked }, t('common.saved'))} />
                <span>
                  <span className="font-medium text-white">{t('gcal.block')}</span>
                  <span className="block text-xs text-dim">{t('gcal.blockHint')}</span>
                </span>
              </label>
            </>
          ) : null}

          {st.external_changes.length > 0 ? (
            <div role="status" className="rounded-xl border border-line-2 bg-sunken p-3">
              <p className="font-medium text-white">{t('gcal.changesTitle')}</p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {st.external_changes.map((c, i) => <li key={`${c.booking_id}-${i}`}>{t('gcal.changeLine', { text: (CHANGE_KEYS as readonly string[]).includes(c.change) ? t(`gcal.change.${c.change}` as 'gcal.change.deleted_in_google') : t('gcal.change.other'), at: when(c.at) })}</li>)}
              </ul>
            </div>
          ) : null}

          {confirming ? (
            <div className="flex flex-col gap-2 rounded-xl border border-line-2 p-3">
              <p>{t('gcal.confirmDisconnect')}</p>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={deleteEvents} onChange={(e) => setDeleteEvents(e.target.checked)} /> {t('gcal.alsoRemove')}</label>
              <div className="flex gap-2"><Button variant="danger" disabled={busy} onClick={disconnect}>{t('gcal.disconnect')}</Button><Button variant="outline" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button></div>
            </div>
          ) : <div><Button variant="outline" onClick={() => setConfirming(true)}>{t('gcal.disconnect')}</Button></div>}
        </>
      )}
    </div>
  );
}
