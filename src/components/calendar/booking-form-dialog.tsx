'use client';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { timeET } from '@/lib/format';
import { centsToDollars, dollarsToCents } from '@/lib/money';
import { isDateKey, localDateKey } from '@/lib/time';
import { useDialogKeys } from './use-dialog-keys';
import type { BookingCreateResult } from '@/app/api/bookings/route';
import type { BookingEditResult } from '@/app/api/bookings/[id]/route';
import type { NewBookingSlotsResult } from '@/app/api/bookings/slots/route';
import type { Booking } from '@/lib/types';

const DURATIONS = [30, 45, 60, 90, 120, 180, 240] as const;

/** Wall-clock "HH:MM" of an instant in the business zone (24 h). */
function hhmmIn(iso: string, tz: string): string {
  const p = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(iso));
  return p.replace(/^24:/, '00:');
}

export interface BookingFormDialogProps {
  tz: string;
  /** Create: the day / time to prefill (a click on an empty calendar slot). Edit: the booking being edited. */
  mode: 'create' | 'edit';
  booking?: Booking;
  prefill?: { date: string; time?: string | null };
  /** Admin only: the business the new booking belongs to. */
  businessId?: string;
  onClose: () => void;
  onCreated?: (result: BookingCreateResult) => void;
  onEdited?: (result: BookingEditResult) => void;
}

/**
 * New booking / edit booking. Create uses the same availability as the AI (hours, closed dates, bookings, the Google calendar's busy time): pick a
 * day, a length and one of the free times; the server re-checks under the booking lock and reports a time taken a moment ago (409: the list reloads).
 * Edit changes the plain fields (name, number, service, address, price estimate, length); moving the booking in time is the Reschedule dialog's job.
 * Keyboard: Escape closes, Tab stays inside, the times are a radio group.
 */
export function BookingFormDialog({ tz, mode, booking, prefill, businessId, onClose, onCreated, onEdited }: BookingFormDialogProps) {
  const t = useT();
  const locale = useLocale();
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const create = mode === 'create';
  const today = localDateKey(new Date(), tz);
  const [name, setName] = useState(booking?.customer_name ?? '');
  const [phone, setPhone] = useState(booking?.customer_phone ?? '');
  const [service, setService] = useState(booking?.service ?? '');
  const [address, setAddress] = useState(booking?.address ?? '');
  const [price, setPrice] = useState(booking?.price_estimate != null ? String(centsToDollars(booking.price_estimate)) : '');
  const [duration, setDuration] = useState<number>(booking?.duration_minutes ?? 60);
  const [date, setDate] = useState(prefill?.date && isDateKey(prefill.date) ? prefill.date : today);
  const [wantTime, setWantTime] = useState<string | null>(prefill?.time ?? null);
  const [picked, setPicked] = useState<string | null>(null);
  const [slots, setSlots] = useState<NewBookingSlotsResult['slots'] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; service?: string; phone?: string; price?: string }>({});

  useEffect(() => { rootRef.current?.querySelector<HTMLInputElement>('input')?.focus(); }, []);
  useDialogKeys(rootRef, onClose);

  useEffect(() => {
    if (!create || !isDateKey(date)) return;
    const ctrl = new AbortController();
    const tm = setTimeout(() => { setSlots(null); setLoadError(null); }, 0);
    const q = new URLSearchParams({ date, duration: String(duration) });
    if (businessId) q.set('business_id', businessId);
    apiRequest<NewBookingSlotsResult>(`/api/bookings/slots?${q}`, { signal: ctrl.signal })
      .then((r) => {
        setSlots(r.slots);
        // Keep a picked time that is still free; else the prefilled one if it is on the list.
        setPicked((cur) => {
          if (cur && r.slots.some((s) => s.start === cur && s.available)) return cur;
          const want = wantTime ? r.slots.find((s) => s.available && hhmmIn(s.start, tz) === wantTime) : null;
          return want?.start ?? null;
        });
      })
      .catch((err) => { if (!ctrl.signal.aborted) setLoadError(errorText(t, err, 'nb.slotsFailed')); });
    return () => { clearTimeout(tm); ctrl.abort(); };
  }, [create, date, duration, reload, businessId, wantTime, tz, t]);

  const free = useMemo(() => slots?.filter((s) => s.available) ?? [], [slots]);
  const prefilledMissing = create && slots !== null && wantTime !== null && !picked && !free.some((s) => hhmmIn(s.start, tz) === wantTime);

  const submit = useCallback(async () => {
    if (busy) return;
    setError(null);
    const fe: typeof fieldErrors = {};
    if (!name.trim()) fe.name = t('nb.err.name');
    if (!service.trim()) fe.service = t('nb.err.service');
    const cents = price.trim() === '' ? null : dollarsToCents(price);
    if (price.trim() !== '' && (cents === null || cents < 0)) fe.price = t('nb.err.price');
    if (phone.trim() !== '' && phone.replace(/\D/g, '').length < 7) fe.phone = t('nb.err.phone');
    setFieldErrors(fe);
    if (Object.keys(fe).length > 0) return;
    if (create && !picked) { setError(t('nb.err.time')); return; }
    setBusy(true);
    try {
      if (create) {
        const r = await apiRequest<BookingCreateResult>('/api/bookings', {
          method: 'POST',
          body: {
            ...(businessId ? { business_id: businessId } : {}), customer_name: name.trim(), customer_phone: phone.trim(), service: service.trim(),
            scheduled_at: picked, duration_minutes: duration, ...(address.trim() ? { address: address.trim() } : {}), ...(cents !== null ? { price_estimate: cents } : {}),
            notify,
          },
        });
        onCreated?.(r);
      } else if (booking) {
        const r = await apiRequest<BookingEditResult>(`/api/bookings/${booking.id}`, {
          method: 'PATCH',
          body: {
            customer_name: name.trim(), customer_phone: phone.trim(), service: service.trim(), address: address.trim() || null, price_estimate: cents,
            ...(duration !== (booking.duration_minutes ?? 60) ? { duration_minutes: duration, notify } : {}),
          },
        });
        onEdited?.(r);
      }
    } catch (err) {
      setError(errorText(t, err));
      if (err instanceof ApiError && err.status === 409) setReload((n) => n + 1); // someone took it: show what is free now
    } finally {
      setBusy(false);
    }
  }, [busy, name, service, price, phone, create, picked, businessId, duration, address, notify, booking, onCreated, onEdited, t]);

  const durationChanged = !create && booking ? duration !== (booking.duration_minutes ?? 60) : false;
  const selectClass = 'mt-1.5 min-h-11 w-full rounded-xl border border-line-2 bg-sunken px-3 text-[15px] text-white sm:text-sm';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center">
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" onClick={onClose} />
      <div ref={rootRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative flex max-h-[92vh] w-full flex-col overflow-y-auto rounded-t-2xl border border-line-3 bg-panel p-5 shadow-2xl md:max-w-lg md:rounded-2xl">
        <h2 id={titleId} className="text-[17px] font-semibold text-white">{create ? t('nb.title') : t('be.title', { name: booking?.customer_name ?? '' })}</h2>
        <p className="mt-1 text-[13px] text-mute">{create ? t('nb.lead') : t('be.lead')}</p>

        <form className="mt-4 space-y-3.5" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
          <TextField label={t('nb.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" error={fieldErrors.name} />
          <TextField label={t('nb.phone')} optional type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} autoComplete="off" hint={t('nb.phoneHint')} error={fieldErrors.phone} />
          <TextField label={t('nb.service')} value={service} onChange={(e) => setService(e.target.value)} maxLength={120} autoComplete="off" error={fieldErrors.service} />
          <TextField label={t('nb.address')} optional value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} autoComplete="off" />
          <div className="grid grid-cols-2 gap-3">
            <TextField label={t('nb.price')} optional inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" hint={t('nb.priceHint')} error={fieldErrors.price} />
            <div>
              <label htmlFor={`${titleId}-dur`} className="block text-xs font-medium uppercase tracking-wider text-dim">{t('nb.duration')}</label>
              <select id={`${titleId}-dur`} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={selectClass}>
                {[...new Set<number>([...DURATIONS, duration])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{t('nb.minutes', { minutes: m })}</option>)}
              </select>
            </div>
          </div>

          {create ? (
            <>
              <div>
                <label htmlFor={`${titleId}-date`} className="block text-xs font-medium uppercase tracking-wider text-dim">{t('rs.newDay')}</label>
                <input
                  id={`${titleId}-date`} type="date" value={date} min={today}
                  onChange={(e) => { if (isDateKey(e.target.value)) { setDate(e.target.value); setWantTime(null); } }}
                  className="mt-1.5 min-h-11 w-full rounded-xl border border-line-3 bg-sunken px-3 text-[15px] text-soft [color-scheme:dark] sm:text-sm"
                />
              </div>
              <fieldset className="min-w-0">
                <legend className="text-xs font-medium uppercase tracking-wider text-dim">{t('rs.newTime')}</legend>
                <div aria-live="polite" className="mt-1.5">
                  {loadError ? (
                    <p role="alert" className="text-[13px] text-danger">{loadError} <button type="button" className="underline" onClick={() => setReload((n) => n + 1)}>{t('common.retry')}</button></p>
                  ) : slots === null ? (
                    <Skeleton className="h-24 w-full" />
                  ) : free.length === 0 ? (
                    <p className="rounded-xl border border-line px-3 py-3 text-[13px] text-mute">{t('rs.none')}</p>
                  ) : (
                    <div role="radiogroup" aria-label={t('rs.available')} className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {free.map((s) => (
                        <label key={s.start} className="relative">
                          <input type="radio" name={`${titleId}-slot`} value={s.start} checked={picked === s.start} onChange={() => setPicked(s.start)} className="peer sr-only" />
                          <span className="flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-line-3 text-[13px] text-soft tabular-nums peer-checked:border-brand peer-checked:bg-brand-bg peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-brand-soft">
                            {timeET(s.start, tz, locale)}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  {prefilledMissing ? <p className="mt-2 text-xs text-warn">{t('nb.prefillTaken')}</p> : null}
                </div>
                <p className="mt-1.5 text-xs text-dim">{t('nb.tzNote', { tz: tz.replace('_', ' ') })}</p>
              </fieldset>
            </>
          ) : null}

          {create || durationChanged ? (
            <div>
              <label className="flex min-h-11 items-center gap-2.5 text-[13px] text-soft">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="h-5 w-5 accent-[#ff6b35]" />
                {create ? t('nb.notify') : t('rs.notify')}
              </label>
              <p className="text-xs text-dim">{create ? t('nb.notifyNote') : t('rs.notifyNote')}</p>
            </div>
          ) : null}

          {error ? <p role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-3 py-2 text-[13px] text-danger">{error}</p> : null}

          <div className="flex gap-2 pt-1">
            <Button type="submit" className="flex-1" disabled={busy || (create && !picked)}>{busy ? t('bp.saving') : create ? t('nb.create') : t('be.save')}</Button>
            <Button variant="outline" className="flex-1" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
