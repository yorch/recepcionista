/**
 * Bookings the OWNER makes or edits from the dashboard. Same engine as the AI: db/createBooking and db/rescheduleBooking do the locking,
 * opening hours, closed dates, lead time / horizon (whatever those validators enforce), per-crew overlap and the Google busy check, so a
 * dashboard booking can never double-book or land on a closed day. What is different:
 *  - `created_via = 'dashboard'`, an audit row (`booking.created_dashboard` / `booking.edited`) with the acting user,
 *  - the customer text is OPTIONAL (owner decides; quiet hours apply because the owner initiates it),
 *  - the Google push hook (`emitBookingChanged`) fires after the commit.
 */
import { BookingRejectedError, createBooking, getBooking, getBusiness, recordAudit, updateBooking, type BookingRejection } from '@/lib/db';
import { emitBookingChanged } from '@/lib/booking-hooks';
import { customerLanguage, rescheduleAndNotify, type ChangeActor, type NoticeResult } from '@/lib/booking-changes';
import { sendConfirmation } from '@/lib/messaging/actions';
import { isQuietHour } from '@/lib/messaging/policy';
import { smsDelivered } from '@/lib/messaging/delivery';
import { clampDuration } from '@/lib/availability';
import { toE164 } from '@/lib/phone';
import { countryForBusiness } from '@/lib/db';
import { tzOf } from '@/lib/time';
import type { Booking, Business } from '@/lib/types';

export const MAX_PRICE_CENTS = 10_000_000; // $100k sanity cap (same as the voice tool)

/** Owner-readable reason + HTTP status for each slot rejection (shared by the create and edit routes). */
export const BOOKING_REJECTIONS: Record<string, { status: number; error: string }> = {
  calendar_busy: { status: 409, error: 'That time is blocked on the connected calendar. Pick another.' },
  slot_taken: { status: 409, error: 'That time is no longer free. Pick another.' },
  past: { status: 422, error: 'That time is in the past.' },
  closed_day: { status: 422, error: 'The business is closed that day.' },
  closed_date: { status: 422, error: 'The business is closed that date (holiday closure).' },
  before_open: { status: 422, error: 'That is before opening time.' },
  after_close: { status: 422, error: 'The job would run past closing time.' },
  too_soon: { status: 422, error: 'That is sooner than the minimum notice the business requires.' },
  too_far: { status: 422, error: 'That is further ahead than the business takes bookings.' },
  invalid_time: { status: 422, error: 'That is not a valid date and time.' },
  invalid_crew: { status: 422, error: 'That crew does not exist.' },
  not_reschedulable: { status: 409, error: 'Only a pending or confirmed booking can be moved.' },
  booking_not_found: { status: 404, error: 'booking not found' },
  business_not_found: { status: 404, error: 'business not found' },
};

export function rejectionResponse(reason: BookingRejection | string): { status: number; error: string } {
  return BOOKING_REJECTIONS[reason] ?? { status: 422, error: 'That time cannot be booked.' };
}

export interface BookingFields {
  customer_name?: unknown;
  customer_phone?: unknown;
  service?: unknown;
  address?: unknown;
  /** INTEGER CENTS (null clears it on an edit). */
  price_estimate?: unknown;
}

type Valid<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate the free fields of a booking. `partial`: only the keys present are checked (an edit). */
export function validateBookingFields(f: BookingFields, business: Pick<Business, 'phone_e164'> | null, partial: boolean): Valid<{
  customer_name?: string; customer_phone?: string; service?: string; address?: string | null; price_estimate?: number | null;
}> {
  const out: { customer_name?: string; customer_phone?: string; service?: string; address?: string | null; price_estimate?: number | null } = {};
  const text = (v: unknown, label: string, max: number, required: boolean): Valid<string> => {
    if (typeof v !== 'string') return { ok: false, error: `${label} must be text` };
    const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s && required) return { ok: false, error: `${label} is required` };
    if (s.length > max) return { ok: false, error: `${label} must be at most ${max} characters` };
    return { ok: true, value: s };
  };
  if (!partial || f.customer_name !== undefined) {
    const r = text(f.customer_name, 'customer_name', 120, true); if (!r.ok) return r; out.customer_name = r.value;
  }
  if (!partial || f.service !== undefined) {
    const r = text(f.service, 'service', 120, true); if (!r.ok) return r; out.service = r.value;
  }
  if (f.address !== undefined) {
    if (f.address === null || f.address === '') out.address = null;
    else { const r = text(f.address, 'address', 200, false); if (!r.ok) return r; out.address = r.value || null; }
  }
  if (!partial || f.customer_phone !== undefined) {
    // A walk-in may have no number: the booking then simply cannot be texted. A number that is given must be a real one.
    const raw = typeof f.customer_phone === 'string' ? f.customer_phone.trim() : '';
    if (f.customer_phone !== undefined && typeof f.customer_phone !== 'string') return { ok: false, error: 'customer_phone must be text' };
    if (raw && raw.length > 40) return { ok: false, error: 'customer_phone is not a valid phone number' };
    if (raw) {
      const e164 = toE164(raw, countryForBusiness({ phone_e164: business?.phone_e164 ?? null }));
      if (!e164) return { ok: false, error: 'customer_phone is not a valid phone number' };
      out.customer_phone = e164;
    } else out.customer_phone = '';
  }
  if (f.price_estimate !== undefined) {
    if (f.price_estimate === null) out.price_estimate = null;
    else if (typeof f.price_estimate !== 'number' || !Number.isInteger(f.price_estimate) || f.price_estimate < 0 || f.price_estimate > MAX_PRICE_CENTS) return { ok: false, error: `price_estimate must be a whole number of cents between 0 and ${MAX_PRICE_CENTS}` };
    else out.price_estimate = f.price_estimate;
  }
  return { ok: true, value: out };
}

export type DashboardCreate = {
  business: Business; customer_name: string; customer_phone: string; service: string; scheduled_at: string; duration_minutes?: number;
  address?: string | null; price_estimate?: number | null; crew?: number | null; notify?: boolean; actor: ChangeActor;
};

export async function createDashboardBooking(input: DashboardCreate): Promise<{ booking: Booking; notice: NoticeResult | null }> {
  const booking = await createBooking({
    business_id: input.business.id, customer_name: input.customer_name, customer_phone: input.customer_phone, service: input.service,
    scheduled_at: input.scheduled_at, duration_minutes: input.duration_minutes != null ? clampDuration(input.duration_minutes) : undefined,
    address: input.address ?? null, price_estimate: input.price_estimate ?? null, created_via: 'dashboard', crew: input.crew ?? undefined,
  }, { ownerInitiated: true }); // the owner may book inside the minimum lead and beyond the horizon (hours, overlap and buffer still apply)
  await recordAudit({
    actor_kind: input.actor.kind, actor_user_id: input.actor.user_id ?? null, business_id: booking.business_id, action: 'booking.created_dashboard',
    target: `booking:${booking.id}`, ip: input.actor.ip ?? null,
    meta: { ...(input.actor.meta ?? {}), at: booking.scheduled_at, minutes: booking.duration_minutes, crew: booking.crew ?? 1, notify: input.notify === true },
  });
  await emitBookingChanged(booking.id, 'created', booking.business_id);
  let notice: NoticeResult | null = null;
  if (input.notify === true) notice = await confirmationNotice(booking, input.business);
  return { booking: (await getBooking(booking.id)) ?? booking, notice };
}

/** The optional confirmation text. Quiet hours apply (the owner initiated it); the answer is the truth about what happened. Never throws. */
export async function confirmationNotice(booking: Booking, business: Business, now: Date = new Date()): Promise<NoticeResult> {
  if (booking.anonymized_at) return { status: 'skipped', reason: 'anonymized', delivered: false };
  if (!booking.customer_phone?.trim()) return { status: 'skipped', reason: 'no_phone', delivered: false };
  if (isQuietHour(now, tzOf(business))) return { status: 'blocked_quiet_hours', delivered: false };
  try {
    const out = await sendConfirmation(booking.id, await customerLanguage(booking, business));
    return { status: out.sms.status, delivered: smsDelivered(out.sms.status) };
  } catch {
    return { status: 'failed', delivered: false };
  }
}

export type DashboardEdit = {
  businessId: string; bookingId: string;
  fields: { customer_name?: string; customer_phone?: string; service?: string; address?: string | null; price_estimate?: number | null };
  scheduled_at?: string; duration_minutes?: number; notify?: boolean; actor: ChangeActor;
};

export type EditOutcome =
  | { ok: true; booking: Booking; changed: boolean; moved: boolean; notice: NoticeResult | null }
  | { ok: false; reason: 'not_found' | 'closed' | 'rejected'; status: number; error: string };

/**
 * Edit a booking: the plain fields (name, number, service, address, price estimate) are written directly; a new time or length goes through
 * the reschedule engine (all slot checks), which also texts the customer when `notify` is on. Cancelled / completed bookings are read-only.
 * Order: the move first (it can be refused), then the plain fields, so a refused move changes nothing.
 */
export async function editDashboardBooking(input: DashboardEdit): Promise<EditOutcome> {
  const cur = await getBooking(input.bookingId);
  if (!cur || cur.business_id !== input.businessId) return { ok: false, reason: 'not_found', status: 404, error: 'booking not found' };
  if (cur.status !== 'pending' && cur.status !== 'confirmed') return { ok: false, reason: 'closed', status: 409, error: `a ${cur.status} booking cannot be edited` };
  const business = await getBusiness(input.businessId);
  if (!business) return { ok: false, reason: 'not_found', status: 404, error: 'business not found' };

  let moved = false;
  let notice: NoticeResult | null = null;
  const wantsMove = (input.scheduled_at !== undefined && new Date(input.scheduled_at).getTime() !== new Date(cur.scheduled_at).getTime())
    || (input.duration_minutes !== undefined && clampDuration(input.duration_minutes) !== (cur.duration_minutes ?? 60));
  if (wantsMove) {
    try {
      const out = await rescheduleAndNotify({
        businessId: input.businessId, bookingId: input.bookingId, scheduled_at: input.scheduled_at ?? cur.scheduled_at,
        duration_minutes: input.duration_minutes, notify: input.notify, actor: input.actor,
      });
      moved = out.result.changed;
      notice = out.notice;
    } catch (err) {
      if (err instanceof BookingRejectedError) { const r = rejectionResponse(err.reason); return { ok: false, reason: 'rejected', status: r.status, error: r.error }; }
      throw err;
    }
  }

  const patch: Partial<Booking> = {};
  const f = input.fields;
  if (f.customer_name !== undefined && f.customer_name !== cur.customer_name) patch.customer_name = f.customer_name;
  if (f.customer_phone !== undefined && f.customer_phone !== cur.customer_phone) {
    patch.customer_phone = f.customer_phone;
    // The follow-up consent was recorded for the OLD number: it does not carry over to a different one.
    patch.followup_consent_at = null; patch.followup_consent_source = null;
  }
  if (f.service !== undefined && f.service !== cur.service) patch.service = f.service;
  if (f.address !== undefined && (f.address ?? null) !== (cur.address ?? null)) patch.address = f.address;
  if (f.price_estimate !== undefined && (f.price_estimate ?? null) !== (cur.price_estimate ?? null)) patch.price_estimate = f.price_estimate;
  const fields = Object.keys(patch);
  if (fields.length > 0) {
    await updateBooking(input.bookingId, patch);
    await recordAudit({
      actor_kind: input.actor.kind, actor_user_id: input.actor.user_id ?? null, business_id: input.businessId, action: 'booking.edited',
      target: `booking:${input.bookingId}`, ip: input.actor.ip ?? null, meta: { ...(input.actor.meta ?? {}), fields },
    });
    await emitBookingChanged(input.bookingId, 'updated', input.businessId);
  }
  return { ok: true, booking: (await getBooking(input.bookingId)) ?? cur, changed: moved || fields.length > 0, moved, notice };
}
