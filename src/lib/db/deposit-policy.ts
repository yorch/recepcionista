/**
 * Per-business deposit policy and manual deposit operations.
 *
 * Policy: stored on `businesses` (deposit_enabled / deposit_mode / deposit_fixed_cents / deposit_percent / deposit_min_cents / deposit_max_cents),
 * validated as a WHOLE (platform limits: cents 100..100000, percent 1..100) and mirrored by CHECK constraints. The amount a booking asks for is
 * `computeDepositCents(policy, price_estimate)` (src/lib/business-config.ts).
 *
 * Manual ops: the owner may mark a deposit as paid outside Stripe (cash, Zelle...) and undo that. `bookings.deposit_source` says which: 'stripe' (set by
 * markDepositPaid) | 'manual' (these helpers) | NULL. A manual mark never overrides a Stripe payment, and Stripe's webhook replaces a manual mark (and tells the owner the customer paid twice: markDepositPaid / payments webhook).
 */
import { prisma } from './client';
import { toBooking, toBusiness } from './index';
import { depositPolicyOf, validateDepositPolicy, type DepositPolicy } from '@/lib/business-config';
import { logger } from '@/lib/log';
import type { AuditActorKind, Booking, ID } from '@/lib/types';

const log = logger('db.deposit');

export async function getDepositPolicy(businessId: ID): Promise<DepositPolicy | null> {
  const row = await prisma.business.findUnique({ where: { id: businessId } });
  return row ? depositPolicyOf(toBusiness(row)) : null;
}

export type SetDepositPolicyResult = { ok: true; policy: DepositPolicy } | { ok: false; reason: 'invalid' | 'not_found'; error?: string };

/** Replace the business's deposit policy (the COMPLETE policy; see validateDepositPolicy). */
export async function setDepositPolicy(businessId: ID, input: unknown): Promise<SetDepositPolicyResult> {
  const v = validateDepositPolicy(input);
  if (!v.ok) return { ok: false, reason: 'invalid', error: v.error };
  const p = v.value;
  const res = await prisma.business.updateMany({
    where: { id: businessId },
    data: {
      depositEnabled: p.enabled, depositMode: p.mode, depositFixedCents: p.fixed_cents, depositPercent: p.percent,
      depositMinCents: p.min_cents, depositMaxCents: p.max_cents,
    },
  });
  if (res.count !== 1) return { ok: false, reason: 'not_found' };
  log.info('deposit_policy.set', { business: businessId, enabled: p.enabled, mode: p.mode });
  return { ok: true, policy: p };
}

export interface DepositActor { kind: AuditActorKind; user_id?: string | null; ip?: string | null }

export type ManualDepositResult =
  | { ok: true; booking: Booking; changed: boolean }
  | { ok: false; reason: 'not_found' | 'cancelled' | 'already_paid' | 'invalid_amount' | 'not_manual' | 'refunded' | 'card_payment_on_file' };

const actorId = (a: DepositActor): string => (a.kind === 'user' && a.user_id ? a.user_id : a.kind).slice(0, 100);

/**
 * Mark a deposit as received outside Stripe. `amount_cents` defaults to the booking's requested deposit_amount; it must be a whole number > 0.
 * Refused: another business's booking (`not_found`), a cancelled booking, a deposit already paid by Stripe or in any way other than a previous
 * manual mark (`already_paid`). Idempotent for a repeat of the same manual mark (`changed: false`). Only a `pending` booking becomes `confirmed`.
 */
export async function markDepositPaidManually(
  businessId: ID, bookingId: ID, actor: DepositActor, opts: { amount_cents?: number | null; now?: Date } = {},
): Promise<ManualDepositResult> {
  const now = opts.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const cur = await tx.booking.findFirst({ where: { id: bookingId, businessId } });
    if (!cur) return { ok: false, reason: 'not_found' } as const;
    if (cur.status === 'cancelled') return { ok: false, reason: 'cancelled' } as const;
    const amount = opts.amount_cents ?? cur.depositAmount;
    if (amount == null || !Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) return { ok: false, reason: 'invalid_amount' } as const;
    if (cur.depositPaid) {
      if (cur.depositSource === 'manual' && cur.depositAmount === amount) return { ok: true, booking: toBooking(cur), changed: false } as const;
      return { ok: false, reason: 'already_paid' } as const;
    }
    const row = await tx.booking.update({
      where: { id: bookingId },
      data: {
        depositPaid: true, depositAmount: amount, depositSource: 'manual', depositMarkedBy: actorId(actor), depositMarkedAt: now,
        ...(cur.status === 'pending' ? { status: 'confirmed' } : {}),
      },
    });
    await tx.auditEvent.create({
      data: {
        actorKind: actor.kind, actorUserId: actor.kind === 'user' ? actor.user_id ?? null : null, businessId, action: 'booking.deposit_marked_manual',
        target: `booking:${bookingId}`, ip: actor.ip ? actor.ip.slice(0, 64) : null, meta: { amount_cents: amount },
      },
    });
    log.info('deposit.marked_manual', { booking: bookingId, business: businessId, amount_cents: amount });
    return { ok: true, booking: toBooking(row), changed: true } as const;
  });
}

/**
 * Undo a MANUAL mark (the money did not arrive after all). Only a manual deposit can be undone (`not_manual` otherwise: a Stripe payment is
 * refunded, not unmarked), not one that has a refund recorded (`refunded`) and not one with a card payment reference on file (`card_payment_on_file`). The requested `deposit_amount` stays so a payment link can still be sent.
 */
export async function unmarkManualDeposit(businessId: ID, bookingId: ID, actor: DepositActor): Promise<ManualDepositResult> {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.booking.findFirst({ where: { id: bookingId, businessId } });
    if (!cur) return { ok: false, reason: 'not_found' } as const;
    if (!cur.depositPaid || cur.depositSource !== 'manual') return { ok: false, reason: 'not_manual' } as const;
    if (cur.refundStatus !== 'none') return { ok: false, reason: 'refunded' } as const;
    // A card payment reference on the row means Stripe took money for this deposit as well: unmarking would leave a captured payment behind an unpaid booking.
    if (cur.stripePaymentIntentId || cur.stripeCheckoutSessionId) return { ok: false, reason: 'card_payment_on_file' } as const;
    const row = await tx.booking.update({
      where: { id: bookingId },
      data: { depositPaid: false, depositSource: null, depositMarkedBy: null, depositMarkedAt: null },
    });
    await tx.auditEvent.create({
      data: {
        actorKind: actor.kind, actorUserId: actor.kind === 'user' ? actor.user_id ?? null : null, businessId, action: 'booking.deposit_unmarked_manual',
        target: `booking:${bookingId}`, ip: actor.ip ? actor.ip.slice(0, 64) : null, meta: { amount_cents: cur.depositAmount },
      },
    });
    log.info('deposit.unmarked_manual', { booking: bookingId, business: businessId });
    return { ok: true, booking: toBooking(row), changed: true } as const;
  });
}

