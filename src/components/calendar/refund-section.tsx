'use client';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useReauth } from '@/components/dashboard/reauth';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { intlTag } from '@/lib/i18n/core';
import { money } from '@/lib/format';
import { dollarsToCents } from '@/lib/money';
import type { RefundRouteResult } from '@/app/api/bookings/[id]/refund/route';
import type { BookingDetail } from '@/app/api/bookings/[id]/route';
import type { Booking } from '@/lib/types';

/**
 * Deposit refunds, for the owner, on a CANCELLED booking with a paid deposit. The app only offers; the owner decides:
 *  - the policy allows it: "Refund deposit ($X, policy allows)";
 *  - the policy says no: "Policy says no refund. Refund anyway?" (a second click confirms; the override is audited);
 *  - an optional smaller amount (a partial refund).
 * Moving money asks for a fresh password / 2FA check (the shared step-up panel), then retries once.
 */
export function RefundSection({ booking, refund, onChanged }: {
  booking: Booking;
  refund: BookingDetail['refund'];
  onChanged: (b: Booking, message: { tone: 'ok' | 'error'; text: string }) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [partial, setPartial] = useState(false);
  const [dollars, setDollars] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { guard, panel } = useReauth((err) => setError(errorText(t, err)));

  const paid = booking.deposit_paid ? booking.deposit_amount ?? 0 : 0;
  const status = booking.refund_status ?? 'none';

  const run = useCallback(async (override: boolean) => {
    setError(null);
    const cents = partial ? dollarsToCents(dollars) : null;
    if (partial && (cents === null || cents <= 0 || cents > paid)) { setError(t('refund.amountError', { max: money(paid, locale) })); return; }
    setBusy(true);
    try {
      await guard(async () => {
        const r = await apiRequest<RefundRouteResult>(`/api/bookings/${booking.id}/refund`, {
          method: 'POST', body: { ...(cents !== null && cents < paid ? { amount_cents: cents } : {}), ...(override ? { override: true } : {}) },
        });
        setConfirm(false);
        onChanged(r.booking, {
          tone: 'ok',
          text: r.status === 'refunded'
            ? t('refund.resultRefunded', { amount: money(r.amount_cents, locale), texted: r.notice?.delivered ? t('refund.texted') : '' })
            : t('refund.resultStarted', { amount: money(r.amount_cents, locale) }),
        });
      });
    } catch (err) {
      if (err instanceof ApiError && (err.payload as { code?: string } | undefined)?.code === 'policy_ineligible') setConfirm(true);
      else setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }, [booking.id, dollars, guard, onChanged, paid, partial, t, locale]);

  if (!booking.deposit_paid || paid <= 0) return null;

  if (status === 'refunded') {
    return <p className="mt-3 text-[13px] text-mint-text">{t('refund.done', { amount: money(booking.refund_amount_cents, locale), date: booking.refunded_at ? t('refund.doneOn', { date: new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(booking.refunded_at)) }) : '' })}</p>;
  }
  if (booking.status !== 'cancelled') {
    return <p className="mt-3 text-xs text-dim">{t('refund.cancelFirst')}</p>;
  }

  const allowed = Boolean(refund?.eligible);
  return (
    <section aria-label={t('refund.region')} className="mt-3 rounded-xl border border-line-3 bg-sunken p-3">
      <h3 className="text-[13px] font-semibold text-white">{t('refund.depositPaid', { amount: money(paid, locale) })}</h3>
      <p className="mt-1 text-xs text-dim">
        {refund ? `${t(`refundPolicy.${refund.policy}` as const)}. ` : ''}
        {allowed ? t('refund.qualifies') : t('refund.notQualifies')}
        {status === 'pending' ? t('refund.processing') : ''}
        {status === 'failed' ? t('refund.lastFailed') : ''}
      </p>
      <label className="mt-2 flex min-h-11 items-center gap-2 text-xs text-soft">
        <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} className="h-5 w-5 accent-[#ff6b35]" />
        {t('refund.partial')}
      </label>
      {partial ? (
        <div className="mb-2">
          <label htmlFor="refund-amount" className="block text-xs text-dim">{t('refund.amountLabel', { max: money(paid, locale) })}</label>
          <input id="refund-amount" inputMode="decimal" value={dollars} onChange={(e) => setDollars(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line-3 bg-panel px-3 text-[15px] text-white sm:text-sm" />
        </div>
      ) : null}
      {error ? <p role="alert" className="mb-2 text-xs text-danger">{error}</p> : null}
      {allowed ? (
        <Button className="w-full" onClick={() => run(false)} disabled={busy}>{busy ? t('refund.refunding') : t('refund.button', { amount: money(partial && dollarsToCents(dollars) ? dollarsToCents(dollars) : paid, locale) })}</Button>
      ) : confirm ? (
        <div role="group" aria-label={t('refund.confirmGroup')} className="rounded-xl border border-danger-line bg-danger-bg p-3">
          <p className="text-[13px] text-danger">{t('refund.confirmBody')}</p>
          <div className="mt-3 flex gap-2">
            <Button variant="danger" className="flex-1" onClick={() => run(true)} disabled={busy}>{busy ? t('refund.refunding') : t('refund.yesAnyway')}</Button>
            <Button variant="outline" className="flex-1" onClick={() => setConfirm(false)} disabled={busy}>{t('refund.keepPolicy')}</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" className="w-full" onClick={() => setConfirm(true)} disabled={busy}>{t('refund.anyway')}</Button>
      )}
      {/* Escape inside the step-up panel closes only that panel: mark the event handled so the booking panel's own Escape handler skips it. */}
      <div onKeyDownCapture={(e) => { if (e.key === 'Escape') e.preventDefault(); }}>{panel}</div>
    </section>
  );
}
