/**
 * Who decides how much a deposit is. Pure (no I/O): the routes and the voice tool call it, the tests exercise it directly.
 *
 *  - AI (voice agent): the amount is ALWAYS computed from the business's deposit policy and the booking's price estimate
 *    (`computeDepositCents`). Whatever the model sends is ignored. No policy (disabled) = the AI cannot request a deposit.
 *    The call script's own cap (AI_DEPOSIT_CAP_CENTS) still applies on top.
 *  - Owner (dashboard / API): an explicit amount is accepted only inside the policy's min/max (or the platform limits when there is no
 *    policy); with no amount, the stored deposit_amount (a resend keeps what was agreed) or the computed one is used.
 */
import { computeDepositCents, DEPOSIT_MAX_CENTS, DEPOSIT_MIN_CENTS, type DepositPolicy } from '@/lib/business-config';
import { planAllows } from '@/lib/admin/plan-catalog';

/** The call script's own cap for AI-requested deposits ($500). The owner policy limit is $1000 (DEPOSIT_MAX_CENTS). */
export const AI_DEPOSIT_CAP_CENTS = 50_000;

export type DepositRefusal = 'disabled' | 'no_amount' | 'out_of_bounds' | 'invalid_amount';

export type DepositDecision =
  | { ok: true; cents: number; source: 'policy' | 'stored' | 'owner'; capped: boolean }
  | { ok: false; reason: DepositRefusal; error: string; min?: number; max?: number };

/** The inclusive range an owner-entered amount must lie in: the policy's min/max when a policy is on, else the platform limits. */
export function depositBounds(policy: DepositPolicy): { min: number; max: number } {
  if (!policy.enabled) return { min: DEPOSIT_MIN_CENTS, max: DEPOSIT_MAX_CENTS };
  return { min: Math.max(DEPOSIT_MIN_CENTS, policy.min_cents ?? DEPOSIT_MIN_CENTS), max: Math.min(DEPOSIT_MAX_CENTS, policy.max_cents ?? DEPOSIT_MAX_CENTS) };
}

export interface ResolveDepositInput {
  policy: DepositPolicy;
  /** The booking's price estimate in cents (null / absent: unknown). */
  priceEstimateCents?: number | null;
  /** What the caller asked for. IGNORED for the AI. */
  requestedCents?: unknown;
  /** The deposit already stored on the booking (a resend keeps it unless the owner asks for another amount). */
  storedCents?: number | null;
  actor: 'ai' | 'owner';
  /** The business's plan: a plan without the `deposits` entitlement refuses (`disabled`). Absent: not checked. */
  plan?: string | null;
}

export function resolveDepositAmount(input: ResolveDepositInput): DepositDecision {
  const { policy } = input;
  if (input.plan !== undefined && !planAllows(input.plan, 'deposits')) return { ok: false, reason: 'disabled', error: 'deposits are not included in this business plan' };
  if (input.actor === 'ai') {
    const computed = computeDepositCents(policy, input.priceEstimateCents);
    if (!policy.enabled) return { ok: false, reason: 'disabled', error: 'deposits are not enabled for this business' };
    if (computed === null) return { ok: false, reason: 'no_amount', error: 'the deposit policy gives no amount for this booking (no price estimate)' };
    const capped = computed > AI_DEPOSIT_CAP_CENTS;
    return { ok: true, cents: capped ? AI_DEPOSIT_CAP_CENTS : computed, source: 'policy', capped };
  }

  const { min, max } = depositBounds(policy);
  const asked = input.requestedCents;
  if (asked !== undefined && asked !== null && asked !== '') {
    const n = typeof asked === 'number' ? asked : Number.NaN;
    if (!Number.isInteger(n)) return { ok: false, reason: 'invalid_amount', error: 'amount_cents must be a whole number of cents', min, max };
    if (n < min || n > max) return { ok: false, reason: 'out_of_bounds', error: `amount_cents must be between ${min} and ${max}`, min, max };
    return { ok: true, cents: n, source: 'owner', capped: false };
  }
  const stored = input.storedCents;
  if (stored != null && Number.isInteger(stored) && stored >= DEPOSIT_MIN_CENTS && stored <= DEPOSIT_MAX_CENTS) return { ok: true, cents: stored, source: 'stored', capped: false };
  const computed = computeDepositCents(policy, input.priceEstimateCents);
  if (computed !== null) return { ok: true, cents: computed, source: 'policy', capped: false };
  return { ok: false, reason: policy.enabled ? 'no_amount' : 'disabled', error: policy.enabled ? 'enter an amount: the policy cannot compute one without a price estimate' : 'enter an amount (no deposit policy is set)', min, max };
}
