'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { dayET, timeET } from '@/lib/format';
import { isDateKey, localDateKey } from '@/lib/time';
import type { RescheduleRouteResult } from '@/app/api/bookings/[id]/reschedule/route';
import type { MoveSlotsResult } from '@/app/api/bookings/[id]/slots/route';
import type { Booking } from '@/lib/types';

const FOCUSABLE = 'a[href], button:not([disabled]), select, input:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

export interface RescheduleDialogProps {
  booking: Booking;
  tz: string;
  onClose: () => void;
  /** The booking moved on the server. */
  onMoved: (result: RescheduleRouteResult) => void;
}

/**
 * Move a booking: pick a date (business time zone) and one of the free times the server lists for it (opening hours minus every other
 * booking), choose whether to text the customer, confirm. Keyboard: the date field, the times (a radio group: arrow keys move, Space
 * selects) and the buttons are all reachable; Escape closes; Tab stays inside. The server re-checks the time under a lock, so a time taken a
 * moment ago is reported (409) and the list refreshes.
 */
export function RescheduleDialog({ booking, tz, onClose, onMoved }: RescheduleDialogProps) {
  const t = useT();
  const locale = useLocale();
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState(() => localDateKey(booking.scheduled_at, tz));
  const today = localDateKey(new Date(), tz);
  const [slots, setSlots] = useState<MoveSlotsResult['slots'] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => { dateRef.current?.focus(); }, []);

  // Escape and Tab are handled in the CAPTURE phase on window so the booking panel underneath (document-level listeners) never sees them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !rootRef.current) return;
      const items = [...rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!rootRef.current.contains(active)) { e.preventDefault(); e.stopPropagation(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); e.stopPropagation(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); e.stopPropagation(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (!isDateKey(date)) return;
    const ctrl = new AbortController();
    const tm = setTimeout(() => { setSlots(null); setPicked(null); setLoadError(null); }, 0);
    apiRequest<MoveSlotsResult>(`/api/bookings/${booking.id}/slots?date=${date}`, { signal: ctrl.signal })
      .then((r) => setSlots(r.slots))
      .catch((err) => { if (!ctrl.signal.aborted) setLoadError(errorText(t, err, 'rs.loadFailed')); });
    return () => { clearTimeout(tm); ctrl.abort(); };
  }, [booking.id, date, reload, t]);

  const submit = useCallback(async () => {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<RescheduleRouteResult>(`/api/bookings/${booking.id}/reschedule`, { method: 'POST', body: { scheduled_at: picked, notify } });
      onMoved(r);
    } catch (err) {
      setError(errorText(t, err));
      if (err instanceof ApiError && err.status === 409) setReload((n) => n + 1); // someone took it: show what is free now
    } finally {
      setBusy(false);
    }
  }, [picked, busy, booking.id, notify, onMoved, t]);

  const free = slots?.filter((s) => s.available && !s.current) ?? [];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center">
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" onClick={onClose} />
      <div ref={rootRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative flex max-h-[92vh] w-full flex-col overflow-y-auto rounded-t-2xl border border-line-3 bg-panel p-5 shadow-2xl md:max-w-md md:rounded-2xl">
        <h2 id={titleId} className="text-[17px] font-semibold text-white">{t('rs.title', { name: booking.customer_name })}</h2>
        <p className="mt-1 text-[13px] text-mute">
          {t('rs.now', { day: dayET(booking.scheduled_at, tz, locale), time: timeET(booking.scheduled_at, tz, locale), minutes: booking.duration_minutes ?? 60, tz: tz.replace('_', ' ') })}
        </p>

        <label htmlFor={`${titleId}-date`} className="mt-4 block text-xs font-medium uppercase tracking-wider text-dim">{t('rs.newDay')}</label>
        <input
          id={`${titleId}-date`} ref={dateRef} type="date" value={date} min={today}
          onChange={(e) => { if (isDateKey(e.target.value)) setDate(e.target.value); }}
          className="mt-1.5 min-h-11 w-full rounded-xl border border-line-3 bg-sunken px-3 text-[15px] text-soft [color-scheme:dark] sm:text-sm"
        />

        <fieldset className="mt-4 min-w-0" aria-describedby={`${titleId}-slots-note`}>
          <legend className="text-xs font-medium uppercase tracking-wider text-dim">{t('rs.newTime')}</legend>
          <div aria-live="polite" className="mt-1.5">
            {loadError ? (
              <p role="alert" className="text-[13px] text-danger">{loadError} <button type="button" className="underline" onClick={() => setReload((n) => n + 1)}>{t('common.retry')}</button></p>
            ) : slots === null ? (
              <Skeleton className="h-24 w-full" />
            ) : free.length === 0 ? (
              <p id={`${titleId}-slots-note`} className="rounded-xl border border-line px-3 py-3 text-[13px] text-mute">{t('rs.none')}</p>
            ) : (
              <div id={`${titleId}-slots-note`} role="radiogroup" aria-label={t('rs.available')} className="grid grid-cols-3 gap-2">
                {free.map((s) => (
                  <label key={s.start} className="relative">
                    <input
                      type="radio" name={`${titleId}-slot`} value={s.start} checked={picked === s.start} onChange={() => setPicked(s.start)}
                      className="peer sr-only"
                    />
                    <span className="flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-line-3 text-[13px] text-soft tabular-nums peer-checked:border-brand peer-checked:bg-brand-bg peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-brand-soft">
                      {timeET(s.start, tz, locale)}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </fieldset>

        <label className="mt-4 flex min-h-11 items-center gap-2.5 text-[13px] text-soft">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="h-5 w-5 accent-[#ff6b35]" />
          {t('rs.notify')}
        </label>
        {notify ? <p className="text-xs text-dim">{t('rs.notifyNote')}</p> : null}

        {error ? <p role="alert" className="mt-3 rounded-xl border border-danger-line bg-danger-bg px-3 py-2 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-5 flex gap-2">
          <Button className="flex-1" onClick={submit} disabled={!picked || busy}>{busy ? t('rs.moving') : t('rs.move')}</Button>
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        </div>
      </div>
    </div>
  );
}
