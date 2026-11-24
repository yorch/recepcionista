'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, buttonClass } from '@/components/ui/button';
import { ApiError, apiRequest, useApi } from '@/hooks/use-api';
import type { GoogleStatus } from '@/app/api/integrations/google/status/route';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'not yet');
const CHANGE_TEXT: Record<string, string> = {
  time_changed_in_google: 'was moved in Google Calendar. The customer was NOT told and the booking did not change.',
  deleted_in_google: 'was deleted from Google Calendar. The booking is still active.',
  edited_in_google_before_push: 'was edited in Google Calendar before we updated it.',
};

/** Settings > Google Calendar: connect / disconnect, health, calendar picker, "block on busy" switch, and notices about owner edits. */
export function GoogleCalendarCard({ initialResult }: { initialResult?: string | null }) {
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
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not load Google Calendar status.'); }
  }, []);
  useEffect(() => { const t = setTimeout(() => { void load(); }, 0); return () => clearTimeout(t); }, [load]);

  async function patch(body: Record<string, unknown>, success: string) {
    const r = await call('/api/integrations/google/calendar', { method: 'PATCH', body }, { success });
    if (r !== undefined) { await load(); router.refresh(); }
  }
  async function disconnect() {
    const r = await call(`/api/integrations/google/disconnect${deleteEvents ? '?delete_events=true' : ''}`, { method: 'DELETE' }, { success: 'Google Calendar disconnected' });
    if (r !== undefined) { setConfirming(false); await load(); router.refresh(); }
  }

  if (error) return <p role="alert" className="text-[13px] text-danger">{error}</p>;
  if (!st) return <p className="text-[13px] text-dim">Loading…</p>;
  if (!st.configured) return <p className="text-[13px] text-mute">Google Calendar is not set up on this server yet (ask your administrator to add the Google credentials).</p>;

  const flash = initialResult === 'denied' ? 'Google access was not granted, so nothing was connected.'
    : initialResult === 'error' ? 'We could not finish connecting Google Calendar. Please try again.' : null;

  return (
    <div className="flex flex-col gap-4 text-[13px] text-soft">
      {st.mock ? <p className="rounded-xl border border-line-2 bg-sunken p-2 text-xs text-warn">Mock mode: no real Google account is used.</p> : null}
      {flash ? <p role="status" className="text-warn">{flash}</p> : null}

      {!st.connected ? (
        <>
          <p>Connect your Google Calendar so the receptionist never books over your own appointments, and your booked jobs appear in your calendar. We read only the times of your events, never their titles or guests.</p>
          <div><a href="/api/integrations/google/connect" className={buttonClass('primary')}>Connect Google Calendar</a></div>
        </>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-dim">Account</dt><dd>{st.account_email}</dd>
            <dt className="text-dim">Status</dt>
            <dd className={st.status === 'active' ? 'text-success' : 'text-warn'}>
              {st.status === 'active' ? 'Connected' : st.status === 'needs_reauth' ? 'Needs to be reconnected' : 'Problem syncing (will retry)'}
            </dd>
            <dt className="text-dim">Last sync</dt><dd>{when(st.last_sync_at)}{st.push_channel ? '' : ' (checked every 15 minutes)'}</dd>
          </dl>

          {st.status === 'needs_reauth' ? (
            <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg p-3 text-danger">
              Google stopped accepting our access{st.last_error ? ` (${st.last_error})` : ''}. Until you reconnect, your calendar is NOT blocking time for the receptionist.
              <div className="mt-2"><a href="/api/integrations/google/connect" className={buttonClass('primary')}>Reconnect</a></div>
            </div>
          ) : st.last_error ? <p className="text-warn">Last error: {st.last_error}</p> : null}

          {st.status !== 'needs_reauth' ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-white">Calendar to use</span>
                <select
                  value={st.calendar_id ?? 'primary'} disabled={busy} aria-label="Calendar to use"
                  onChange={(e) => { if (window.confirm('Switch calendar? Booked jobs are moved to the new calendar.')) void patch({ calendar_id: e.target.value }, 'Calendar changed'); }}
                  className="min-h-11 max-w-sm rounded-xl border border-line-3 bg-sunken px-2.5 text-[13px] text-soft"
                >
                  {!calendars.some((c) => c.id === st.calendar_id) ? <option value={st.calendar_id ?? 'primary'}>{st.calendar_id === 'primary' ? 'Primary calendar' : st.calendar_id}</option> : null}
                  {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}{c.primary ? ' (primary)' : ''}</option>)}
                </select>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1 h-4 w-4" checked={st.block_on_busy} disabled={busy} onChange={(e) => void patch({ block_on_busy: e.target.checked }, 'Saved')} />
                <span>
                  <span className="font-medium text-white">Block the times my calendar shows as busy</span>
                  <span className="block text-xs text-dim">Events marked &quot;free&quot; in Google never block. Turn this off to only add jobs to your calendar.</span>
                </span>
              </label>
            </>
          ) : null}

          {st.external_changes.length > 0 ? (
            <div role="status" className="rounded-xl border border-line-2 bg-sunken p-3">
              <p className="font-medium text-white">Changes made in Google Calendar</p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {st.external_changes.map((c, i) => <li key={`${c.booking_id}-${i}`}>A job {CHANGE_TEXT[c.change] ?? 'was changed in Google Calendar.'} ({when(c.at)}) Change the booking from the dashboard to tell the customer.</li>)}
              </ul>
            </div>
          ) : null}

          {confirming ? (
            <div className="flex flex-col gap-2 rounded-xl border border-line-2 p-3">
              <p>Disconnect Google Calendar? Your calendar will stop blocking time and no new jobs will be added.</p>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={deleteEvents} onChange={(e) => setDeleteEvents(e.target.checked)} /> Also remove the jobs we added to your calendar</label>
              <div className="flex gap-2"><Button variant="danger" disabled={busy} onClick={disconnect}>Disconnect</Button><Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button></div>
            </div>
          ) : <div><Button variant="outline" onClick={() => setConfirming(true)}>Disconnect</Button></div>}
        </>
      )}
    </div>
  );
}
