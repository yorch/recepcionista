/**
 * Booking changes with their side effects, shared by the dashboard routes and the voice tools so both behave identically:
 *  - cancelBooking: status change, refund-eligibility bookkeeping, the customer's text, the change hook
 *  - rescheduleAndNotify: the atomic move (db/rescheduleBooking), the customer's text, the change hook
 *  - notifyBookingChange: the customer text on its own (also the "text them now" retry)
 *
 * The customer's text goes through sendAndLog (the one outbound path): opt-outs, the destination-country allow-list, the plan's SMS cap
 * and segment metering all apply. On top of that, a change the OWNER made does not text during quiet hours (9pm-8am business time);
 * a change the CUSTOMER made on the phone does (they are on the line). A blocked or failed text never marks the customer notified and is
 * reported honestly to the caller, who can retry with `notifyBookingChange` later.
 */
import {
  claimEvent, completeEvent, getBooking, getBusiness, getCall, logSms, markCustomerNotified, markRefundNotApplicable, recordAudit,
  releaseEvent, rescheduleBooking, transitionBooking, type RescheduleResult, countryForBusiness,
} from '@/lib/db';
import { emitBookingChanged } from '@/lib/booking-hooks';
import { sendAndLog } from '@/lib/messaging';
import { isQuietHour } from '@/lib/messaging/policy';
import { cancelSms, refundSms, rescheduleSms, type Lang } from '@/lib/messaging/templates';
import { bookingRefundEligibility, type Eligibility } from '@/lib/refunds';
import { tzOf } from '@/lib/time';
import { logger } from '@/lib/log';
import type { AuditActorKind, Booking, Business, SmsLog } from '@/lib/types';

const log = logger('booking-changes');

export interface ChangeActor {
  kind: AuditActorKind;
  user_id?: string | null;
  ip?: string | null;
  /** Free context for the audit row, e.g. { actor_role: 'owner' } or { source: 'voice' }. */
  meta?: Record<string, unknown>;
}

export type NoticeStatus = SmsLog['status'] | 'skipped' | 'duplicate';

export interface NoticeResult {
  status: NoticeStatus;
  /** Why nothing was sent (skipped): 'anonymized' | 'no_phone' | 'not_requested' | 'nothing_to_tell'. */
  reason?: string;
  /** True when a text really went out (or was logged in mock mode): the customer was told. */
  delivered: boolean;
}

const DELIVERED: ReadonlySet<string> = new Set(['sent', 'mock']);

/** The language to text a customer in: the language of the call that made the booking, else the business default. */
export async function customerLanguage(booking: Booking, business: Business): Promise<Lang> {
  const call = booking.call_id ? await getCall(booking.call_id).catch(() => null) : null;
  if (call && call.business_id === business.id && (call.language === 'es' || call.language === 'mixed' || call.language === 'en')) return call.language;
  return business.locale_default === 'es' ? 'es' : 'en';
}

async function sendChangeText(
  business: Business, booking: Booking, kind: 'rescheduled' | 'cancelled', body: string, initiator: 'owner' | 'customer', now: Date,
): Promise<NoticeResult> {
  if (booking.anonymized_at) return { status: 'skipped', reason: 'anonymized', delivered: false };
  if (!booking.customer_phone?.trim()) return { status: 'skipped', reason: 'no_phone', delivered: false };
  const claim = `${kind}:${booking.id}:${booking.reschedule_count ?? 0}`;
  if (!(await claimEvent('booking_change_sms', claim, 60_000))) return { status: 'duplicate', delivered: false };
  let delivered = false;
  try {
    if (initiator === 'owner' && isQuietHour(now, tzOf(business))) {
      await logSms({
        business_id: business.id, to_phone: booking.customer_phone, body, kind: 'other', booking_id: booking.id, provider_id: null,
        status: 'blocked_quiet_hours', consent_basis: 'transactional_booking',
      }, { country: countryForBusiness(business) });
      return { status: 'blocked_quiet_hours', delivered: false };
    }
    const { sms } = await sendAndLog({
      business_id: business.id, to: booking.customer_phone, body, kind: 'other', booking_id: booking.id,
      consent_basis: initiator === 'customer' ? 'caller_initiated' : 'transactional_booking', now,
    });
    delivered = DELIVERED.has(sms.status);
    if (delivered) await markCustomerNotified(booking.id, now);
    return { status: sms.status, delivered };
  } catch (err) {
    log.warn('notice.failed', { booking: booking.id, kind, err });
    return { status: 'failed', delivered: false };
  } finally {
    // A delivered notice is final (a duplicate request must not text again); anything else may be retried by the owner.
    if (delivered) await completeEvent('booking_change_sms', claim); else await releaseEvent('booking_change_sms', claim);
  }
}

/** The text for a booking's latest change: cancelled, or moved. `initiator` decides whether quiet hours apply. */
export async function notifyBookingChange(
  bookingId: string, opts: { initiator?: 'owner' | 'customer'; now?: Date; language?: Lang } = {},
): Promise<NoticeResult & { kind?: 'rescheduled' | 'cancelled' }> {
  const booking = await getBooking(bookingId);
  if (!booking) return { status: 'skipped', reason: 'not_found', delivered: false };
  const business = await getBusiness(booking.business_id);
  if (!business) return { status: 'skipped', reason: 'not_found', delivered: false };
  const now = opts.now ?? new Date();
  const language = opts.language ?? await customerLanguage(booking, business);
  if (booking.status === 'cancelled') {
    const e = bookingRefundEligibility(booking, business.refund_policy, now);
    const deposit = e.reason === 'no_deposit' ? { state: 'none' as const } : { state: e.eligible ? ('refundable' as const) : ('not_refundable' as const), amount_cents: booking.deposit_amount ?? 0 };
    return { ...(await sendChangeText(business, booking, 'cancelled', cancelSms({ business, booking, language, deposit }), opts.initiator ?? 'owner', now)), kind: 'cancelled' };
  }
  if ((booking.reschedule_count ?? 0) > 0) {
    return { ...(await sendChangeText(business, booking, 'rescheduled', rescheduleSms({ business, booking, language }), opts.initiator ?? 'owner', now)), kind: 'rescheduled' };
  }
  return { status: 'skipped', reason: 'nothing_to_tell', delivered: false };
}

export type CancelOutcome =
  | { ok: true; booking: Booking; changed: boolean; previous: Booking['status']; refund: Eligibility; notice: NoticeResult | null }
  | { ok: false; reason: 'not_found' | 'invalid_transition' | 'not_started'; current?: Booking['status'] };

/**
 * Cancel a booking (pending/confirmed only; idempotent). Bookkeeping: with no paid deposit, or when the policy says the deposit is not
 * refundable, the booking's refund_status becomes 'not_applicable' (the owner can still refund anyway: an audited override); with an
 * eligible paid deposit it stays 'none' so the dashboard offers the refund. The app NEVER refunds by itself. Texts the customer unless
 * `notify` is false.
 */
export async function cancelBooking(input: {
  businessId: string; bookingId: string; actor: ChangeActor; reason?: string | null; notify?: boolean;
  initiator?: 'owner' | 'customer'; language?: Lang; now?: Date;
}): Promise<CancelOutcome> {
  const now = input.now ?? new Date();
  const result = await transitionBooking(input.businessId, input.bookingId, 'cancelled', now, { reason: input.reason ?? null });
  if (!result.ok) return result;
  const business = await getBusiness(input.businessId);
  const booking = result.booking;
  const refund = bookingRefundEligibility(booking, business?.refund_policy, now);
  let notice: NoticeResult | null = null;
  if (result.changed) {
    if (!refund.eligible && (booking.refund_status ?? 'none') === 'none') await markRefundNotApplicable(booking.id);
    await recordAudit({
      actor_kind: input.actor.kind, actor_user_id: input.actor.user_id ?? null, business_id: booking.business_id, action: 'booking.cancelled',
      target: `booking:${booking.id}`, ip: input.actor.ip ?? null,
      meta: { ...(input.actor.meta ?? {}), from: result.previous, deposit_paid: booking.deposit_paid, refund_eligible: refund.eligible, refund_reason: refund.reason, hours_before: refund.hours_before, notify: input.notify !== false },
    });
    if (business && input.notify !== false) {
      notice = await notifyBookingChange(booking.id, { initiator: input.initiator ?? 'owner', now, language: input.language });
    } else if (input.notify === false) notice = { status: 'skipped', reason: 'not_requested', delivered: false };
    await emitBookingChanged(booking.id, 'cancelled', booking.business_id);
  }
  const fresh = (await getBooking(booking.id)) ?? booking;
  return { ok: true, booking: fresh, changed: result.changed, previous: result.previous, refund, notice };
}

export type RescheduleOutcome = { result: RescheduleResult; booking: Booking; notice: NoticeResult | null };

/**
 * Move a booking (db/rescheduleBooking does the locking, hours, overlap and audit; it throws BookingRejectedError, which the caller maps)
 * and tell the customer. Fires the change hook only when something moved.
 */
export async function rescheduleAndNotify(input: {
  businessId: string; bookingId: string; scheduled_at: string; duration_minutes?: number; actor: ChangeActor; notify?: boolean;
  initiator?: 'owner' | 'customer'; language?: Lang; now?: Date;
}): Promise<RescheduleOutcome> {
  const result = await rescheduleBooking({
    business_id: input.businessId, booking_id: input.bookingId, scheduled_at: input.scheduled_at, duration_minutes: input.duration_minutes,
    actor: { kind: input.actor.kind, user_id: input.actor.user_id ?? null, ip: input.actor.ip ?? null, reason: typeof input.actor.meta?.source === 'string' ? input.actor.meta.source : null },
  });
  let notice: NoticeResult | null = null;
  if (result.changed) {
    notice = input.notify === false
      ? { status: 'skipped', reason: 'not_requested', delivered: false }
      : await notifyBookingChange(input.bookingId, { initiator: input.initiator ?? 'owner', now: input.now, language: input.language });
    await emitBookingChanged(input.bookingId, 'rescheduled', input.businessId);
  }
  const booking = (await getBooking(input.bookingId)) ?? result.booking;
  return { result, booking, notice };
}

/** Tell the customer a refund was issued (transactional; quiet hours apply because the owner initiated it). Never throws. */
export async function notifyRefund(bookingId: string, amountCents: number, now: Date = new Date()): Promise<NoticeResult> {
  try {
    const booking = await getBooking(bookingId);
    const business = booking ? await getBusiness(booking.business_id) : null;
    if (!booking || !business) return { status: 'skipped', reason: 'not_found', delivered: false };
    if (booking.anonymized_at) return { status: 'skipped', reason: 'anonymized', delivered: false };
    const claim = `refunded:${booking.id}:${amountCents}`;
    if (!(await claimEvent('booking_change_sms', claim, 60_000))) return { status: 'duplicate', delivered: false };
    let delivered = false;
    try {
      const body = refundSms({ business, amount_cents: amountCents, language: await customerLanguage(booking, business) });
      if (isQuietHour(now, tzOf(business))) {
        await logSms({
          business_id: business.id, to_phone: booking.customer_phone, body, kind: 'other', booking_id: booking.id, provider_id: null,
          status: 'blocked_quiet_hours', consent_basis: 'transactional_booking',
        }, { country: countryForBusiness(business) });
        return { status: 'blocked_quiet_hours', delivered: false };
      }
      const { sms } = await sendAndLog({ business_id: business.id, to: booking.customer_phone, body, kind: 'other', booking_id: booking.id, consent_basis: 'transactional_booking', now });
      delivered = DELIVERED.has(sms.status);
      return { status: sms.status, delivered };
    } finally {
      if (delivered) await completeEvent('booking_change_sms', claim); else await releaseEvent('booking_change_sms', claim);
    }
  } catch (err) {
    log.warn('refund_notice.failed', { booking: bookingId, err });
    return { status: 'failed', delivered: false };
  }
}
