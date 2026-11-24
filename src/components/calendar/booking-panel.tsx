'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBadge } from './status';
import { RefundSection } from './refund-section';
import { RescheduleDialog } from './reschedule-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { allowedActions } from '@/lib/calendar';
import { dayET, money, timeET } from '@/lib/format';
import { ApiError, apiRequest } from '@/hooks/use-api';
import type { BookingDetail, BookingPatchResult } from '@/app/api/bookings/[id]/route';
import type { ResendResult } from '@/app/api/bookings/[id]/resend-confirmation/route';
import { POLICY_LABEL } from '@/lib/refunds';
import type { RescheduleRouteResult } from '@/app/api/bookings/[id]/reschedule/route';
import type { NoticeResult } from '@/lib/booking-changes';
import type { Booking } from '@/lib/types';

const FOCUSABLE = 'a[href], button:not([disabled]), select, input, textarea, [tabindex]:not([tabindex="-1"])';

/** What happened to the customer's text about a cancel / move (never claims a blocked text was sent). */
function noticeText(n: NoticeResult | null | undefined): string {
  if (!n || n.status === 'duplicate') return '';
  if (n.delivered) return ' The customer was texted.';
  if (n.status === 'skipped') return n.reason === 'not_requested' ? ' The customer was not texted.' : ' The customer could not be texted (no number on file).';
  if (n.status === 'blocked_opt_out') return ' The customer opted out of texts, so they were not texted.';
  if (n.status === 'blocked_quiet_hours') return ' It is quiet hours for the customer, so the text was held back. Use "Text the customer" later.';
  if (n.status === 'blocked_cap') return ' This month\'s text allowance is used up, so the customer was not texted.';
  return ' The text to the customer could not be sent. Use "Text the customer" to try again.';
}

const RESEND_TEXT: Record<string, string> = {
  sent: 'Confirmation text sent.',
  mock: 'Confirmation text logged (no SMS provider is connected).',
  failed: 'The text could not be sent. Try again in a minute.',
  blocked_opt_out: 'Not sent: this customer replied STOP to your texts.',
  blocked_quiet_hours: 'Not sent: it is outside texting hours for the customer. Try again later.',
  blocked_cap: 'Not sent: this month\'s text allowance is used up.',
  blocked_no_consent: 'Not sent: there is no consent on file for this text.',
  blocked_owner_unverified: 'Not sent: the destination is not verified.',
};

export interface BookingPanelProps {
  booking: Booking;
  tz: string;
  canManage: boolean;
  onClose: () => void;
  /** The booking changed on the server (cancel / complete): the calendar replaces its copy. */
  onChanged: (b: Booking) => void;
}

/** Side panel (right drawer on desktop, bottom sheet on a phone) with everything about one booking and the owner's actions. */
export function BookingPanel({ booking, tz, canManage, onClose, onChanged }: BookingPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'cancel' | 'complete' | 'resend' | 'notify'>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [refundInfo, setRefundInfo] = useState<BookingDetail['refund'] | undefined>(undefined);
  const [openedAt] = useState(() => Date.now());
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // Load the call behind the booking (its summary is the job's notes). The list item already has everything else.
  useEffect(() => {
    const ctrl = new AbortController();
    apiRequest<BookingDetail>(`/api/bookings/${booking.id}`, { signal: ctrl.signal })
      .then((d) => { setDetail(d); setDetailError(null); })
      .catch((err) => { if (!ctrl.signal.aborted) setDetailError((err as Error).message); });
    return () => ctrl.abort();
  }, [booking.id]);

  // Focus the heading on open, close on Escape, keep Tab inside the panel while it is open.
  useEffect(() => {
    headingRef.current?.focus();
    const root = rootRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (e.defaultPrevented) return; e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = useCallback(async (kind: 'cancel' | 'complete') => {
    setBusy(kind);
    setMessage(null);
    try {
      const r = await apiRequest<BookingPatchResult>(`/api/bookings/${booking.id}`, { method: 'PATCH', body: { status: kind === 'cancel' ? 'cancelled' : 'completed' } });
      onChanged(r.booking);
      setConfirmCancel(false);
      if (kind === 'cancel' && r.refund) setRefundInfo({ ...r.refund, policy_label: POLICY_LABEL[r.refund.policy] });
      setMessage({
        tone: 'ok',
        text: kind === 'cancel'
          ? `Booking cancelled. The time is free again.${noticeText(r.notice)}${r.deposit_refund_needed ? ' The deposit qualifies for a refund under your policy: refund it below.' : r.booking.deposit_paid ? ' A deposit was paid; your policy does not refund it, but you can still refund it below.' : ''}`
          : 'Marked completed.',
      });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Something went wrong. Try again.' });
    } finally {
      setBusy(null);
    }
  }, [booking.id, onChanged]);

  const moved = useCallback((r: RescheduleRouteResult) => {
    setRescheduling(false);
    onChanged(r.booking);
    setMessage({ tone: 'ok', text: r.changed ? `Booking moved to ${dayET(r.booking.scheduled_at, tz)}, ${timeET(r.booking.scheduled_at, tz)}.${noticeText(r.notice)}` : 'That is the time it already has. Nothing changed.' });
  }, [onChanged, tz]);

  const notify = useCallback(async () => {
    setBusy('notify');
    setMessage(null);
    try {
      const n = await apiRequest<NoticeResult>(`/api/bookings/${booking.id}/notify`, { method: 'POST', body: {} });
      if (n.delivered) onChanged({ ...booking, customer_notified_at: new Date().toISOString() });
      setMessage({ tone: n.delivered ? 'ok' : 'error', text: noticeText(n).trim() || 'Nothing was sent.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Something went wrong. Try again.' });
    } finally {
      setBusy(null);
    }
  }, [booking, onChanged]);

  const resend = useCallback(async () => {
    setBusy('resend');
    setMessage(null);
    try {
      const r = await apiRequest<ResendResult>(`/api/bookings/${booking.id}/resend-confirmation`, { method: 'POST', body: {} });
      const text = r.deduped ? 'A confirmation was already texted a moment ago; nothing new was sent.' : (RESEND_TEXT[r.status] ?? `Text status: ${r.status}.`);
      setMessage({ tone: r.deduped || r.status === 'sent' || r.status === 'mock' ? 'ok' : 'error', text });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Something went wrong. Try again.' });
    } finally {
      setBusy(null);
    }
  }, [booking.id]);

  const startMs = new Date(booking.scheduled_at).getTime();
  const endIso = new Date(startMs + (booking.duration_minutes ?? 60) * 60_000).toISOString();
  const actions = allowedActions(booking.status, startMs, openedAt);
  const dispute = booking.dispute_status && booking.dispute_status !== 'none' ? booking.dispute_status : null;
  const depositLine = booking.deposit_amount
    ? `${money(booking.deposit_amount)} ${booking.deposit_paid ? 'paid' : 'requested, not paid yet'}`
    : 'No deposit';

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/55" aria-hidden="true" onClick={onClose} />
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="booking-panel-title"
        className="absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col overflow-y-auto rounded-t-2xl border border-line-3 bg-panel p-5 shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[400px] md:rounded-none md:rounded-l-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="booking-panel-title" ref={headingRef} tabIndex={-1} className="truncate text-[17px] font-semibold text-white outline-none">
              {booking.customer_name}
            </h2>
            <p className="mt-0.5 text-[13px] text-mute">{booking.service}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close booking details" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-soft hover:bg-raised">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <div className="mt-3"><StatusBadge status={booking.status} /></div>

        <dl className="mt-5 grid grid-cols-[88px_1fr] gap-x-3 gap-y-3 text-[13px]">
          <dt className="text-dim">When</dt>
          <dd className="text-soft">{dayET(booking.scheduled_at, tz)}, {timeET(booking.scheduled_at, tz)} to {timeET(endIso, tz)}<span className="block text-xs text-dim">{booking.duration_minutes ?? 60} min · {tz.replace('_', ' ')}</span></dd>
          <dt className="text-dim">Phone</dt>
          <dd>{booking.anonymized_at ? <span className="text-dim">Removed (privacy request)</span> : <a href={`tel:${booking.customer_phone}`} className="font-mono text-brand-soft hover:underline">{booking.customer_phone}</a>}</dd>
          <dt className="text-dim">Address</dt>
          <dd className="text-soft">{booking.address || <span className="text-dim">Not given</span>}</dd>
          <dt className="text-dim">Price</dt>
          <dd className="tabular-nums text-soft">{money(booking.price_estimate)} <span className="text-dim">estimate</span></dd>
          <dt className="text-dim">Deposit</dt>
          <dd className={booking.deposit_amount ? (booking.deposit_paid ? 'text-mint-text' : 'text-warn') : 'text-dim'}>{depositLine}</dd>
          {dispute ? (
            <>
              <dt className="text-dim">Card dispute</dt>
              <dd className={dispute === 'open' || dispute === 'lost' ? 'text-warn' : 'text-mint-text'}>
                {dispute === 'open' ? 'Open: answer it in Stripe before the deadline' : dispute === 'won' ? 'Won' : 'Lost: the funds went back to the cardholder'}
              </dd>
            </>
          ) : null}
          {booking.reschedule_count ? (<><dt className="text-dim">Moved</dt><dd className="text-soft">{booking.reschedule_count} {booking.reschedule_count === 1 ? 'time' : 'times'}</dd></>) : null}
          <dt className="text-dim">Call</dt>
          <dd>
            {booking.call_id
              ? <Link href={`/dashboard/calls?call=${booking.call_id}`} className="text-brand-soft hover:underline">Open the call and transcript</Link>
              : <span className="text-dim">Not from a phone call</span>}
          </dd>
          <dt className="text-dim">Notes</dt>
          <dd className="text-body">
            {detail ? (detail.call?.summary || detail.call?.flagged_reason || <span className="text-dim">No notes from the call.</span>)
              : detailError ? <span className="text-dim">Notes could not be loaded.</span>
              : <Skeleton className="h-4 w-40" />}
          </dd>
        </dl>

        {message ? (
          <p role={message.tone === 'error' ? 'alert' : 'status'} className={`mt-4 rounded-xl border px-3 py-2 text-[13px] ${message.tone === 'error' ? 'border-danger-line bg-danger-bg text-danger' : 'border-mint-line bg-mint-bg text-mint-text'}`}>
            {message.text}
          </p>
        ) : null}

        {canManage ? (
          <div className="mt-6 flex flex-col gap-2.5 border-t border-line pt-5">
            <Button variant="outline" onClick={resend} disabled={busy !== null || !actions.resend}>
              {busy === 'resend' ? 'Sending…' : 'Resend confirmation text'}
            </Button>
            <Button variant="outline" onClick={() => setRescheduling(true)} disabled={busy !== null || !(booking.status === 'pending' || booking.status === 'confirmed')}>
              Reschedule
            </Button>
            <Button variant="outline" onClick={() => act('complete')} disabled={busy !== null || !actions.complete} title={!actions.complete && (booking.status === 'pending' || booking.status === 'confirmed') ? 'Available once the job has started' : undefined}>
              {busy === 'complete' ? 'Saving…' : 'Mark completed'}
            </Button>
            {confirmCancel ? (
              <div role="group" aria-label="Confirm cancellation" className="rounded-xl border border-danger-line bg-danger-bg p-3">
                <p className="text-[13px] text-danger">Cancel this booking? The time becomes free for new bookings. The customer is texted (unless they opted out).</p>
                <div className="mt-3 flex gap-2">
                  <Button variant="danger" className="flex-1" onClick={() => act('cancel')} disabled={busy !== null}>{busy === 'cancel' ? 'Cancelling…' : 'Yes, cancel it'}</Button>
                  <Button variant="outline" className="flex-1" onClick={() => setConfirmCancel(false)} disabled={busy !== null}>Keep it</Button>
                </div>
              </div>
            ) : (
              <Button variant="danger" onClick={() => setConfirmCancel(true)} disabled={busy !== null || !actions.cancel}>Cancel booking</Button>
            )}
            {booking.deposit_paid && actions.cancel ? <p className="text-xs text-dim">A deposit was paid. Cancelling never refunds it by itself: you decide, after cancelling.</p> : null}
            {!booking.customer_notified_at && !booking.anonymized_at && (booking.status === 'cancelled' || (booking.reschedule_count ?? 0) > 0) ? (
              <Button variant="outline" onClick={notify} disabled={busy !== null}>{busy === 'notify' ? 'Sending…' : 'Text the customer about this change'}</Button>
            ) : null}
            {booking.deposit_paid ? (
              <RefundSection booking={booking} refund={refundInfo === undefined ? detail?.refund ?? null : refundInfo} onChanged={(b, m) => { onChanged(b); setMessage(m); }} />
            ) : null}
          </div>
        ) : (
          <p className="mt-6 border-t border-line pt-4 text-xs text-dim">You can view bookings. Only the account owner can cancel, complete or re-text them.</p>
        )}

      </div>
      {rescheduling ? <RescheduleDialog booking={booking} tz={tz} onClose={() => setRescheduling(false)} onMoved={moved} /> : null}
    </div>
  );
}
