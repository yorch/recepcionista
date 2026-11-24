/**
 * Deposit refund policy. PURE (no I/O, no clock reads): the eligibility of a deposit refund is computed from the business's
 * `refund_policy`, the time of the cancellation and the scheduled start of the job, so it is the same answer whenever it is asked
 * (the booking row keeps `cancelled_at`, so the dashboard recomputes it later without storing a verdict).
 *
 * The policy only decides what the app OFFERS. The owner can always refund anyway (an override, audited); the app never refunds on its own
 * (no money moves without an owner action: see docs/refunds.md).
 */
import { formatCents } from '@/lib/money';
import type { Booking, RefundPolicy } from '@/lib/types';

const HOUR_MS = 3_600_000;

/** Hours of notice a policy asks for (0 = any time, Infinity = never). */
export const POLICY_NOTICE_HOURS: Record<RefundPolicy, number> = { none: Infinity, full_24h: 24, full_48h: 48, full_always: 0 };

export const POLICY_LABEL: Record<RefundPolicy, string> = {
  none: 'No refunds',
  full_24h: 'Full refund if cancelled 24 hours or more before',
  full_48h: 'Full refund if cancelled 48 hours or more before',
  full_always: 'Full refund whenever the booking is cancelled',
};

/** One plain sentence for a customer (a text, the pay page). */
export function policySentence(policy: RefundPolicy | undefined | null, lang: 'en' | 'es' = 'en'): string {
  const p: RefundPolicy = policy ?? 'full_24h';
  if (lang === 'es') {
    switch (p) {
      case 'none': return 'El depósito no es reembolsable.';
      case 'full_48h': return 'Depósito reembolsable si cancela con 48 horas o más de anticipación.';
      case 'full_always': return 'Depósito reembolsable si cancela.';
      default: return 'Depósito reembolsable si cancela con 24 horas o más de anticipación.';
    }
  }
  switch (p) {
    case 'none': return 'The deposit is non-refundable.';
    case 'full_48h': return 'Deposit refundable if you cancel 48+ hours ahead.';
    case 'full_always': return 'Deposit refundable if you cancel.';
    default: return 'Deposit refundable if you cancel 24+ hours ahead.';
  }
}

export interface EligibilityInput {
  policy: RefundPolicy | undefined | null;
  /** ISO: when the job was to start. */
  scheduled_at: string;
  /** When the booking was cancelled (default: `now`). */
  cancelled_at?: string | Date | null;
  /** Integer cents actually paid as a deposit (0 / null = nothing to refund). */
  deposit_paid_cents: number | null | undefined;
  now?: Date;
}

export interface Eligibility {
  /** The policy says the paid deposit is refundable in full. */
  eligible: boolean;
  /** What the policy would refund (the whole deposit when eligible, else 0). */
  amount_cents: number;
  /** Whole hours (floored, can be negative) between the cancellation and the start. */
  hours_before: number;
  policy: RefundPolicy;
  /** Why: 'no_deposit' | 'policy_none' | 'too_late' | 'within_policy' | 'policy_always'. */
  reason: 'no_deposit' | 'policy_none' | 'too_late' | 'within_policy' | 'policy_always';
}

/**
 * The boundary is INCLUSIVE: a cancellation exactly 24 h (or 48 h) before the start is still within `full_24h` (`full_48h`); one
 * millisecond later is not. A cancellation after the job started has negative notice and only `full_always` refunds it.
 */
export function refundEligibility(input: EligibilityInput): Eligibility {
  const policy: RefundPolicy = input.policy ?? 'full_24h';
  const paid = input.deposit_paid_cents && input.deposit_paid_cents > 0 ? Math.round(input.deposit_paid_cents) : 0;
  const at = input.cancelled_at ? new Date(input.cancelled_at) : (input.now ?? new Date());
  const startMs = new Date(input.scheduled_at).getTime();
  const noticeMs = startMs - at.getTime();
  const hours_before = Number.isFinite(noticeMs) ? Math.floor(noticeMs / HOUR_MS) : 0;
  const base = { policy, hours_before };
  if (paid <= 0) return { ...base, eligible: false, amount_cents: 0, reason: 'no_deposit' };
  if (policy === 'none') return { ...base, eligible: false, amount_cents: 0, reason: 'policy_none' };
  if (policy === 'full_always') return { ...base, eligible: true, amount_cents: paid, reason: 'policy_always' };
  const need = POLICY_NOTICE_HOURS[policy] * HOUR_MS;
  return Number.isFinite(noticeMs) && noticeMs >= need
    ? { ...base, eligible: true, amount_cents: paid, reason: 'within_policy' }
    : { ...base, eligible: false, amount_cents: 0, reason: 'too_late' };
}

/** Eligibility of a stored booking (uses its own cancelled_at). */
export function bookingRefundEligibility(
  booking: Pick<Booking, 'scheduled_at' | 'cancelled_at' | 'deposit_amount' | 'deposit_paid'>, policy: RefundPolicy | undefined | null, now: Date = new Date(),
): Eligibility {
  return refundEligibility({
    policy, scheduled_at: booking.scheduled_at, cancelled_at: booking.cancelled_at ?? null,
    deposit_paid_cents: booking.deposit_paid ? booking.deposit_amount : 0, now,
  });
}

/** Cents a refund request may ask for: at most the deposit that was paid (and nothing once it was refunded). */
export function maxRefundable(booking: Pick<Booking, 'deposit_amount' | 'deposit_paid' | 'refund_status' | 'refund_amount_cents'>): number {
  if (!booking.deposit_paid || !booking.deposit_amount || booking.deposit_amount <= 0) return 0;
  if (booking.refund_status === 'refunded') return 0;
  return Math.round(booking.deposit_amount);
}

export type AmountCheck = { ok: true; amount_cents: number } | { ok: false; error: string };

/** Validate a requested amount: an integer number of cents, > 0 and <= what was paid. Omitted = the whole deposit. */
export function checkRefundAmount(raw: unknown, max: number): AmountCheck {
  if (max <= 0) return { ok: false, error: 'there is no paid deposit to refund' };
  if (raw === undefined) return { ok: true, amount_cents: max }; // only an ABSENT amount means the whole deposit (null / NaN are mistakes)
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false, error: 'amount_cents must be a whole number of cents' };
  if (raw <= 0) return { ok: false, error: 'amount_cents must be greater than zero' };
  if (raw > max) return { ok: false, error: `amount_cents cannot be more than the deposit paid (${formatCents(max, { fractionalAlways: max % 100 !== 0 })})` };
  return { ok: true, amount_cents: raw };
}

/** The stable Stripe Idempotency-Key for one refund of one booking: the same booking and amount always map to the same key. */
export const refundIdempotencyKey = (bookingId: string, amountCents: number, attempt = 0): string =>
  `rc-refund-${bookingId}-${amountCents}${attempt > 0 ? `-a${attempt}` : ''}`;

/** The refund note shown beside Stripe's Pay button (and the link to the platform's refunds page). Plain text, <= 1200 chars. */
export function checkoutRefundNote(business: { refund_policy?: RefundPolicy | null; refund_policy_text?: string | null }, baseUrl: string): string {
  const own = business.refund_policy_text ? ` ${business.refund_policy_text.replace(/\s+/g, ' ').trim()}` : '';
  return `${policySentence(business.refund_policy)}${own} Details: ${baseUrl.replace(/\/+$/, '')}/refunds`.slice(0, 1200);
}
