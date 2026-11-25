'use client';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useReauth } from '@/components/dashboard/reauth';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { intlTag } from '@/lib/i18n/core';
import { money } from '@/lib/format';
import { dollarsToCents } from '@/lib/money';
import type { DepositRequestResult } from '@/app/api/bookings/[id]/deposit/route';
import type { MarkPaidResult } from '@/app/api/bookings/[id]/deposit/mark-paid/route';
import type { ManualRefundRouteResult } from '@/app/api/bookings/[id]/refund/manual/route';
import type { Booking } from '@/lib/types';

type Message = { tone: 'ok' | 'error'; text: string };
const SMS_STATES = ['sent', 'mock', 'failed', 'blocked_opt_out', 'blocked_quiet_hours', 'blocked_cap', 'blocked_no_consent', 'blocked_owner_unverified'] as const;
const dateOf = (iso: string, locale: 'en' | 'es') => new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium' }).format(new Date(iso));

/**
 * The owner's deposit tools on one booking: request or resend the payment link (the amount comes from the business's deposit policy unless the
 * owner types one inside the policy's range), copy the link instead of texting it, and mark the deposit as paid manually (cash, Zelle...; step-up,
 * audited, owner only). A manual deposit is never refunded through Stripe: it is shown as "paid manually" and ManualRefund records an off-platform refund.
 */
export function DepositSection({ booking, onChanged }: { booking: Booking; onChanged: (b: Booking, message: Message) => void }) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState<null | 'send' | 'copy' | 'mark' | 'unmark'>(null);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [markOpen, setMarkOpen] = useState(false);
  const { guard, panel } = useReauth((err) => setError(errorText(t, err)));

  const live = booking.status === 'pending' || booking.status === 'confirmed';
  const hasAmount = (booking.deposit_amount ?? 0) > 0;
  const manual = booking.deposit_paid && booking.deposit_source === 'manual';

  const cents = useCallback((): number | null | 'bad' => {
    if (amount.trim() === '') return null;
    const c = dollarsToCents(amount);
    return c === null || c <= 0 ? 'bad' : c;
  }, [amount]);

  const request = useCallback(async (send: boolean) => {
    setError(null);
    const c = cents();
    if (c === 'bad') { setError(t('dep.amountBad')); return; }
    setBusy(send ? 'send' : 'copy');
    try {
      const r = await apiRequest<DepositRequestResult>(`/api/bookings/${booking.id}/deposit`, { method: 'POST', body: { ...(c !== null ? { amount_cents: c } : {}), send } });
      setLink(r.link.url);
      const amountText = money(r.amount_cents, locale);
      const text = !r.sms
        ? t('dep.linkMade', { amount: amountText })
        : (r.sms.delivered ? t(r.resent ? 'dep.resent' : 'dep.requested', { amount: amountText }) : `${t('dep.linkMadeNotTexted', { amount: amountText })} ${(SMS_STATES as readonly string[]).includes(r.sms.status) ? t(`dep.sms.${r.sms.status}` as 'dep.sms.sent') : ''}`.trim());
      onChanged(r.booking, { tone: !r.sms || r.sms.delivered ? 'ok' : 'error', text });
      setAmount('');
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  }, [booking.id, cents, locale, onChanged, t]);

  const markPaid = useCallback(async () => {
    setError(null);
    const c = cents();
    if (c === 'bad') { setError(t('dep.amountBad')); return; }
    if (c === null && !hasAmount) { setError(t('dep.amountNeeded')); return; }
    setBusy('mark');
    try {
      await guard(async () => {
        const r = await apiRequest<MarkPaidResult>(`/api/bookings/${booking.id}/deposit/mark-paid`, { method: 'POST', body: c !== null ? { amount_cents: c } : {} });
        setMarkOpen(false);
        setAmount('');
        onChanged(r.booking, { tone: 'ok', text: t('dep.markedPaid', { amount: money(r.amount_cents, locale) }) });
      });
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  }, [booking.id, cents, guard, hasAmount, locale, onChanged, t]);

  const unmark = useCallback(async () => {
    setError(null);
    setBusy('unmark');
    try {
      await guard(async () => {
        const r = await apiRequest<{ booking: Booking }>(`/api/bookings/${booking.id}/deposit/unmark`, { method: 'POST', body: {} });
        onChanged(r.booking, { tone: 'ok', text: t('dep.unmarked') });
      });
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  }, [booking.id, guard, onChanged, t]);

  if (booking.deposit_paid) {
    if (!manual) return null; // a card deposit: the refund section handles it
    return (
      <section aria-label={t('dep.region')} className="mt-3 rounded-xl border border-line-3 bg-sunken p-3">
        <h3 className="text-[13px] font-semibold text-white">{t('dep.paidManually', { amount: money(booking.deposit_amount, locale) })}</h3>
        <p className="mt-1 text-xs text-dim">{booking.deposit_marked_at ? t('dep.markedOn', { date: dateOf(booking.deposit_marked_at, locale) }) : ''} {t('dep.manualNote')}</p>
        {error ? <p role="alert" className="mt-2 text-xs text-danger">{error}</p> : null}
        {booking.refund_status === 'none' || booking.refund_status === 'not_applicable' || !booking.refund_status ? (
          <Button variant="outline" className="mt-2 w-full" onClick={unmark} disabled={busy !== null}>{busy === 'unmark' ? t('bp.saving') : t('dep.unmark')}</Button>
        ) : null}
        <div onKeyDownCapture={(e) => { if (e.key === 'Escape') e.preventDefault(); }}>{panel}</div>
      </section>
    );
  }
  if (!live) return null;

  return (
    <section aria-label={t('dep.region')} className="mt-3 rounded-xl border border-line-3 bg-sunken p-3">
      <h3 className="text-[13px] font-semibold text-white">{hasAmount ? t('dep.requestedTitle', { amount: money(booking.deposit_amount, locale) }) : t('dep.title')}</h3>
      <p className="mt-1 text-xs text-dim">{hasAmount ? t('dep.resendHint') : t('dep.hint')}</p>
      <label htmlFor={`dep-amount-${booking.id}`} className="mt-2 block text-xs text-dim">{t('dep.amountLabel')}</label>
      <input
        id={`dep-amount-${booking.id}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('dep.amountPlaceholder')}
        className="mt-1 min-h-11 w-full rounded-xl border border-line-3 bg-panel px-3 text-[15px] text-white sm:text-sm"
      />
      {error ? <p role="alert" className="mt-2 text-xs text-danger">{error}</p> : null}
      <div className="mt-2 flex flex-col gap-2">
        <Button className="w-full" onClick={() => request(true)} disabled={busy !== null || booking.anonymized_at != null || !booking.customer_phone}>
          {busy === 'send' ? t('common.sending') : hasAmount ? t('dep.resend') : t('dep.request')}
        </Button>
        <Button variant="outline" className="w-full" onClick={() => request(false)} disabled={busy !== null}>{busy === 'copy' ? t('bp.saving') : t('dep.copyLink')}</Button>
        {!booking.customer_phone ? <p className="text-xs text-dim">{t('dep.noPhone')}</p> : null}
        {link ? (
          <div>
            <label htmlFor={`dep-link-${booking.id}`} className="block text-xs text-dim">{t('dep.linkLabel')}</label>
            <input id={`dep-link-${booking.id}`} readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="mt-1 min-h-11 w-full rounded-xl border border-line-3 bg-panel px-3 font-mono text-xs text-soft" />
          </div>
        ) : null}
        {markOpen ? (
          <div role="group" aria-label={t('dep.markGroup')} className="rounded-xl border border-line-3 bg-panel p-3">
            <p className="text-[13px] text-soft">{t('dep.markBody')}</p>
            <div className="mt-3 flex gap-2">
              <Button className="flex-1" onClick={markPaid} disabled={busy !== null}>{busy === 'mark' ? t('bp.saving') : t('dep.markConfirm')}</Button>
              <Button variant="outline" className="flex-1" onClick={() => setMarkOpen(false)} disabled={busy !== null}>{t('common.cancel')}</Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" className="w-full" onClick={() => setMarkOpen(true)} disabled={busy !== null}>{t('dep.mark')}</Button>
        )}
      </div>
      <div onKeyDownCapture={(e) => { if (e.key === 'Escape') e.preventDefault(); }}>{panel}</div>
    </section>
  );
}

/**
 * The refund of a MANUAL deposit: the owner gives the money back the way it was taken, then records it here. Nothing is sent to Stripe and the
 * customer is not texted. Step-up like every money action.
 */
export function ManualRefund({ booking, onChanged }: { booking: Booking; onChanged: (b: Booking, message: Message) => void }) {
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState(false);
  const [dollars, setDollars] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { guard, panel } = useReauth((err) => setError(errorText(t, err)));
  const paid = booking.deposit_amount ?? 0;

  const run = useCallback(async () => {
    setError(null);
    const c = partial ? dollarsToCents(dollars) : null;
    if (partial && (c === null || c <= 0 || c > paid)) { setError(t('refund.amountError', { max: money(paid, locale) })); return; }
    setBusy(true);
    try {
      await guard(async () => {
        const r = await apiRequest<ManualRefundRouteResult>(`/api/bookings/${booking.id}/refund/manual`, { method: 'POST', body: c !== null && c < paid ? { amount_cents: c } : {} });
        onChanged(r.booking, { tone: 'ok', text: t('mrefund.done', { amount: money(r.amount_cents, locale) }) });
      });
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }, [booking.id, dollars, guard, locale, onChanged, paid, partial, t]);

  if (booking.refund_status === 'refunded') {
    return <p className="mt-3 text-[13px] text-mint-text">{t('mrefund.recorded', { amount: money(booking.refund_amount_cents, locale) })}</p>;
  }
  return (
    <section aria-label={t('mrefund.region')} className="mt-3 rounded-xl border border-line-3 bg-sunken p-3">
      <h3 className="text-[13px] font-semibold text-white">{t('mrefund.title', { amount: money(paid, locale) })}</h3>
      <p className="mt-1 text-xs text-dim">{t('mrefund.body')}</p>
      <label className="mt-2 flex min-h-11 items-center gap-2 text-xs text-soft">
        <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} className="h-5 w-5 accent-[#ff6b35]" />
        {t('refund.partial')}
      </label>
      {partial ? (
        <div className="mb-2">
          <label htmlFor={`mrefund-amount-${booking.id}`} className="block text-xs text-dim">{t('refund.amountLabel', { max: money(paid, locale) })}</label>
          <input id={`mrefund-amount-${booking.id}`} inputMode="decimal" value={dollars} onChange={(e) => setDollars(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line-3 bg-panel px-3 text-[15px] text-white sm:text-sm" />
        </div>
      ) : null}
      {error ? <p role="alert" className="mb-2 text-xs text-danger">{error}</p> : null}
      <Button variant="outline" className="w-full" onClick={run} disabled={busy}>{busy ? t('bp.saving') : t('mrefund.button')}</Button>
      <div onKeyDownCapture={(e) => { if (e.key === 'Escape') e.preventDefault(); }}>{panel}</div>
    </section>
  );
}
