'use client';
import { splitAuto } from '@/lib/auto-label';
import { smsDelivered } from '@/lib/messaging/delivery';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBadge } from './status';
import { RefundSection } from './refund-section';
import { RescheduleDialog } from './reschedule-dialog';
import { BookingFormDialog } from './booking-form-dialog';
import { DepositSection } from './deposit-section';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { allowedActions } from '@/lib/calendar';
import { dayET, money, timeET } from '@/lib/format';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { formatPhoneDisplay, type TFunction } from '@/lib/i18n/core';
import type { BookingDetail, BookingPatchResult } from '@/app/api/bookings/[id]/route';
import type { ResendResult } from '@/app/api/bookings/[id]/resend-confirmation/route';
import type { RescheduleRouteResult } from '@/app/api/bookings/[id]/reschedule/route';
import type { NoticeResult } from '@/lib/booking-changes';
import type { Booking } from '@/lib/types';

const FOCUSABLE = 'a[href], button:not([disabled]), select, input, textarea, [tabindex]:not([tabindex="-1"])';

/** What happened to the customer's text about a cancel / move (never claims a blocked text was sent). */
function noticeText(t: TFunction, n: NoticeResult | null | undefined): string {
  if (!n || n.status === 'duplicate') return '';
  if (n.delivered) return t('notice.texted');
  if (n.status === 'skipped') return n.reason === 'not_requested' ? t('notice.notRequested') : t('notice.noNumber');
  if (n.status === 'blocked_opt_out') return t('notice.optOut');
  if (n.status === 'blocked_quiet_hours') return t('notice.quiet');
  if (n.status === 'blocked_cap') return t('notice.cap');
  return t('notice.failed');
}

const RESEND_KEYS = ['sent', 'mock', 'failed', 'blocked_opt_out', 'blocked_quiet_hours', 'blocked_cap', 'blocked_no_consent', 'blocked_owner_unverified'] as const;

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
  const t = useT();
  const locale = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'cancel' | 'complete' | 'resend' | 'notify' | 'noshow'>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmNoShow, setConfirmNoShow] = useState(false);
  const [refundInfo, setRefundInfo] = useState<BookingDetail['refund'] | undefined>(undefined);
  const [openedAt] = useState(() => Date.now());
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // Load the call behind the booking (its summary is the job's notes). The list item already has everything else.
  useEffect(() => {
    const ctrl = new AbortController();
    apiRequest<BookingDetail>(`/api/bookings/${booking.id}`, { signal: ctrl.signal })
      .then((d) => { setDetail(d); setDetailError(null); })
      .catch((err) => { if (!ctrl.signal.aborted) setDetailError(errorText(t, err)); });
    return () => ctrl.abort();
  }, [booking.id, t]);

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

  const act = useCallback(async (kind: 'cancel' | 'complete' | 'noshow') => {
    setBusy(kind);
    setMessage(null);
    try {
      const body = kind === 'noshow' ? { status: 'cancelled', reason: 'no_show', notify: false } : { status: kind === 'cancel' ? 'cancelled' : 'completed' };
      const r = await apiRequest<BookingPatchResult>(`/api/bookings/${booking.id}`, { method: 'PATCH', body });
      onChanged(r.booking);
      setConfirmCancel(false);
      setConfirmNoShow(false);
      if (kind !== 'complete' && r.refund) setRefundInfo({ ...r.refund, policy_label: '' });
      setMessage({
        tone: 'ok',
        text: kind === 'noshow'
          ? `${t('bp.noShowDone')}${r.booking.deposit_paid ? t('bp.noShowDeposit') : ''}`
          : kind === 'cancel'
          ? `${t('bp.cancelled')}${noticeText(t, r.notice)}${r.deposit_refund_needed ? t('bp.cancelledRefundDue') : r.booking.deposit_paid ? t('bp.cancelledDepositPaid') : ''}`
          : t('bp.completed'),
      });
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  }, [booking.id, onChanged, t]);

  const moved = useCallback((r: RescheduleRouteResult) => {
    setRescheduling(false);
    onChanged(r.booking);
    setMessage({ tone: 'ok', text: r.changed ? `${t('bp.movedTo', { day: dayET(r.booking.scheduled_at, tz, locale), time: timeET(r.booking.scheduled_at, tz, locale) })}${noticeText(t, r.notice)}` : t('bp.sameTime') });
  }, [onChanged, tz, t, locale]);

  const notify = useCallback(async () => {
    setBusy('notify');
    setMessage(null);
    try {
      const n = await apiRequest<NoticeResult>(`/api/bookings/${booking.id}/notify`, { method: 'POST', body: {} });
      if (n.delivered) onChanged({ ...booking, customer_notified_at: new Date().toISOString() });
      setMessage({ tone: n.delivered ? 'ok' : 'error', text: noticeText(t, n).trim() || t('bp.nothingSent') });
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  }, [booking, onChanged, t]);

  const resend = useCallback(async () => {
    setBusy('resend');
    setMessage(null);
    try {
      const r = await apiRequest<ResendResult>(`/api/bookings/${booking.id}/resend-confirmation`, { method: 'POST', body: {} });
      const text = r.deduped ? t('bp.resendDeduped') : ((RESEND_KEYS as readonly string[]).includes(r.status) ? t(`resend.${r.status}` as 'resend.sent') : t('bp.textStatus', { status: r.status }));
      setMessage({ tone: r.deduped || smsDelivered(r.status) ? 'ok' : 'error', text });
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  }, [booking.id, t]);

  const startMs = new Date(booking.scheduled_at).getTime();
  const endIso = new Date(startMs + (booking.duration_minutes ?? 60) * 60_000).toISOString();
  const actions = allowedActions(booking.status, startMs, openedAt);
  const dispute = booking.dispute_status && booking.dispute_status !== 'none' ? booking.dispute_status : null;
  const depositLine = booking.deposit_amount
    ? t(booking.deposit_paid ? (booking.deposit_source === 'manual' ? 'bp.depositPaidManual' : 'bp.depositPaid') : 'bp.depositRequested', { amount: money(booking.deposit_amount, locale) })
    : t('bp.noDeposit');

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
          <button type="button" onClick={onClose} aria-label={t('bp.close')} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-soft hover:bg-raised">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <div className="mt-3"><StatusBadge status={booking.status} /></div>

        <dl className="mt-5 grid grid-cols-[88px_1fr] gap-x-3 gap-y-3 text-[13px]">
          <dt className="text-dim">{t('bp.when')}</dt>
          <dd className="text-soft">{t('bp.whenValue', { day: dayET(booking.scheduled_at, tz, locale), from: timeET(booking.scheduled_at, tz, locale), to: timeET(endIso, tz, locale) })}<span className="block text-xs text-dim">{t('bp.duration', { minutes: booking.duration_minutes ?? 60, tz: tz.replace('_', ' ') })}</span></dd>
          <dt className="text-dim">{t('bp.phone')}</dt>
          <dd>{booking.anonymized_at ? <span className="text-dim">{t('bp.removed')}</span> : <a href={`tel:${booking.customer_phone}`} className="font-mono text-brand-soft hover:underline">{formatPhoneDisplay(booking.customer_phone)}</a>}</dd>
          <dt className="text-dim">{t('bp.address')}</dt>
          <dd className="text-soft">{booking.address || <span className="text-dim">{t('bp.notGiven')}</span>}</dd>
          <dt className="text-dim">{t('bp.price')}</dt>
          <dd className="tabular-nums text-soft">{money(booking.price_estimate, locale)} <span className="text-dim">{t('bp.estimate')}</span></dd>
          <dt className="text-dim">{t('bp.deposit')}</dt>
          <dd className={booking.deposit_amount ? (booking.deposit_paid ? 'text-mint-text' : 'text-warn') : 'text-dim'}>{depositLine}</dd>
          {dispute ? (
            <>
              <dt className="text-dim">{t('bp.dispute')}</dt>
              <dd className={dispute === 'open' || dispute === 'lost' ? 'text-warn' : 'text-mint-text'}>
                {dispute === 'open' ? t('bp.dispute.open') : dispute === 'won' ? t('bp.dispute.won') : t('bp.dispute.lost')}
              </dd>
            </>
          ) : null}
          {booking.reschedule_count ? (<><dt className="text-dim">{t('bp.moved')}</dt><dd className="text-soft">{t('bp.movedTimes', { count: booking.reschedule_count })}</dd></>) : null}
          {booking.created_via === 'dashboard' ? (<><dt className="text-dim">{t('bp.source')}</dt><dd className="text-soft">{t('bp.sourceDashboard')}</dd></>) : null}
          <dt className="text-dim">{t('bp.call')}</dt>
          <dd>
            {booking.call_id
              ? <Link href={`/dashboard/calls?call=${booking.call_id}`} className="text-brand-soft hover:underline">{t('bp.openCall')}</Link>
              : <span className="text-dim">{t('bp.noCall')}</span>}
          </dd>
          <dt className="text-dim">{t('bp.notes')}</dt>
          <dd className="text-body">
            {detail ? ((detail.call?.summary ? splitAuto(detail.call.summary).text : '') || detail.call?.flagged_reason || <span className="text-dim">{t('bp.noNotes')}</span>)
              : detailError ? <span className="text-dim">{t('bp.notesFailed')}</span>
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
              {busy === 'resend' ? t('common.sending') : t('bp.resend')}
            </Button>
            <Button variant="outline" onClick={() => setEditing(true)} disabled={busy !== null || !(booking.status === 'pending' || booking.status === 'confirmed')}>
              {t('bp.edit')}
            </Button>
            <Button variant="outline" onClick={() => setRescheduling(true)} disabled={busy !== null || !(booking.status === 'pending' || booking.status === 'confirmed')}>
              {t('bp.reschedule')}
            </Button>
            <Button variant="outline" onClick={() => act('complete')} disabled={busy !== null || !actions.complete} title={!actions.complete && (booking.status === 'pending' || booking.status === 'confirmed') ? t('bp.completeHint') : undefined}>
              {busy === 'complete' ? t('bp.saving') : t('bp.complete')}
            </Button>
            {actions.complete ? (
              confirmNoShow ? (
                <div role="group" aria-label={t('bp.confirmNoShowGroup')} className="rounded-xl border border-danger-line bg-danger-bg p-3">
                  <p className="text-[13px] text-danger">{t('bp.confirmNoShow')}</p>
                  <div className="mt-3 flex gap-2">
                    <Button variant="danger" className="flex-1" onClick={() => act('noshow')} disabled={busy !== null}>{busy === 'noshow' ? t('bp.saving') : t('bp.yesNoShow')}</Button>
                    <Button variant="outline" className="flex-1" onClick={() => setConfirmNoShow(false)} disabled={busy !== null}>{t('bp.keep')}</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" onClick={() => setConfirmNoShow(true)} disabled={busy !== null}>{t('bp.noShow')}</Button>
              )
            ) : null}
            {confirmCancel ? (
              <div role="group" aria-label={t('bp.confirmCancelGroup')} className="rounded-xl border border-danger-line bg-danger-bg p-3">
                <p className="text-[13px] text-danger">{t('bp.confirmCancel')}</p>
                <div className="mt-3 flex gap-2">
                  <Button variant="danger" className="flex-1" onClick={() => act('cancel')} disabled={busy !== null}>{busy === 'cancel' ? t('bp.cancelling') : t('bp.yesCancel')}</Button>
                  <Button variant="outline" className="flex-1" onClick={() => setConfirmCancel(false)} disabled={busy !== null}>{t('bp.keep')}</Button>
                </div>
              </div>
            ) : (
              <Button variant="danger" onClick={() => setConfirmCancel(true)} disabled={busy !== null || !actions.cancel}>{t('bp.cancel')}</Button>
            )}
            {booking.deposit_paid && actions.cancel ? <p className="text-xs text-dim">{t('bp.depositNote')}</p> : null}
            {!booking.customer_notified_at && !booking.anonymized_at && (booking.status === 'cancelled' || (booking.reschedule_count ?? 0) > 0) ? (
              <Button variant="outline" onClick={notify} disabled={busy !== null}>{busy === 'notify' ? t('common.sending') : t('bp.notify')}</Button>
            ) : null}
            <DepositSection booking={booking} onChanged={(b, m) => { onChanged(b); setMessage(m); }} />
            {booking.deposit_paid ? (
              <RefundSection booking={booking} refund={refundInfo === undefined ? detail?.refund ?? null : refundInfo} onChanged={(b, m) => { onChanged(b); setMessage(m); }} />
            ) : null}
          </div>
        ) : (
          <p className="mt-6 border-t border-line pt-4 text-xs text-dim">{t('bp.viewOnly')}</p>
        )}

      </div>
      {editing ? (
        <BookingFormDialog
          mode="edit" booking={booking} tz={tz} onClose={() => setEditing(false)}
          onEdited={(r) => { setEditing(false); onChanged(r.booking); setMessage({ tone: 'ok', text: `${t(r.changed ? 'be.saved' : 'be.nothingChanged')}${r.moved ? noticeText(t, r.notice) : ''}` }); }}
        />
      ) : null}
      {rescheduling ? <RescheduleDialog booking={booking} tz={tz} onClose={() => setRescheduling(false)} onMoved={moved} /> : null}
    </div>
  );
}
