'use client';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useReauth } from '@/components/dashboard/reauth';
import { ApiError, apiRequest } from '@/hooks/use-api';
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
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [partial, setPartial] = useState(false);
  const [dollars, setDollars] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { guard, panel } = useReauth((err) => setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.'));

  const paid = booking.deposit_paid ? booking.deposit_amount ?? 0 : 0;
  const status = booking.refund_status ?? 'none';

  const run = useCallback(async (override: boolean) => {
    setError(null);
    const cents = partial ? dollarsToCents(dollars) : null;
    if (partial && (cents === null || cents <= 0 || cents > paid)) { setError(`Enter an amount between $0.01 and ${money(paid)}.`); return; }
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
            ? `Refunded ${money(r.amount_cents)}.${r.notice?.delivered ? ' The customer was texted.' : ''} It can take 5-10 business days to reach their statement.`
            : `Refund of ${money(r.amount_cents)} started; Stripe is processing it.`,
        });
      });
    } catch (err) {
      if (err instanceof ApiError && (err.payload as { code?: string } | undefined)?.code === 'policy_ineligible') setConfirm(true);
      else setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }, [booking.id, dollars, guard, onChanged, paid, partial]);

  if (!booking.deposit_paid || paid <= 0) return null;

  if (status === 'refunded') {
    return <p className="mt-3 text-[13px] text-mint-text">Deposit refunded: {money(booking.refund_amount_cents)}{booking.refunded_at ? ` on ${new Date(booking.refunded_at).toLocaleDateString('en-US')}` : ''}.</p>;
  }
  if (booking.status !== 'cancelled') {
    return <p className="mt-3 text-xs text-dim">A deposit was paid. Cancel the booking first, then you can refund it here.</p>;
  }

  const allowed = Boolean(refund?.eligible);
  return (
    <section aria-label="Deposit refund" className="mt-3 rounded-xl border border-line-3 bg-sunken p-3">
      <h3 className="text-[13px] font-semibold text-white">Deposit {money(paid)} paid</h3>
      <p className="mt-1 text-xs text-dim">
        {refund ? `${refund.policy_label}. ` : ''}
        {allowed ? 'This cancellation qualifies.' : 'This cancellation does not qualify.'}
        {status === 'pending' ? ' A refund is already processing.' : ''}
        {status === 'failed' ? ' The last refund attempt failed; you can try again.' : ''}
      </p>
      <label className="mt-2 flex min-h-11 items-center gap-2 text-xs text-soft">
        <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} className="h-5 w-5 accent-[#ff6b35]" />
        Refund only part of it
      </label>
      {partial ? (
        <div className="mb-2">
          <label htmlFor="refund-amount" className="block text-xs text-dim">Amount in dollars (up to {money(paid)})</label>
          <input id="refund-amount" inputMode="decimal" value={dollars} onChange={(e) => setDollars(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line-3 bg-panel px-3 text-[15px] text-white sm:text-sm" />
        </div>
      ) : null}
      {error ? <p role="alert" className="mb-2 text-xs text-danger">{error}</p> : null}
      {allowed ? (
        <Button className="w-full" onClick={() => run(false)} disabled={busy}>{busy ? 'Refunding…' : `Refund deposit (${money(partial && dollarsToCents(dollars) ? dollarsToCents(dollars) : paid)}, policy allows)`}</Button>
      ) : confirm ? (
        <div role="group" aria-label="Confirm refund override" className="rounded-xl border border-danger-line bg-danger-bg p-3">
          <p className="text-[13px] text-danger">Your policy says no refund for this one. Refund it anyway? This is recorded in your audit log.</p>
          <div className="mt-3 flex gap-2">
            <Button variant="danger" className="flex-1" onClick={() => run(true)} disabled={busy}>{busy ? 'Refunding…' : 'Yes, refund anyway'}</Button>
            <Button variant="outline" className="flex-1" onClick={() => setConfirm(false)} disabled={busy}>Keep policy</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" className="w-full" onClick={() => setConfirm(true)} disabled={busy}>Policy says no refund. Refund anyway?</Button>
      )}
      {/* Escape inside the step-up panel closes only that panel: mark the event handled so the booking panel's own Escape handler skips it. */}
      <div onKeyDownCapture={(e) => { if (e.key === 'Escape') e.preventDefault(); }}>{panel}</div>
    </section>
  );
}
