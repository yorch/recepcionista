/**
 * Billing summary for a business (status route + dashboard page). Node runtime only.
 */
import { billingEnforced, isProvisioningAllowed, callMinutesCapFor, getUsage, pastDueGraceDays, smsCapFor } from '@/lib/db';
import type { BillingStatus, Business } from '@/lib/types';

export interface BillingSummary {
  billing_status: BillingStatus;
  plan: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  /** Null unless past_due: when the grace period ends and service stops. */
  grace_ends_at: string | null;
  /** True only when BILLING_ENFORCED=true (otherwise nothing is refused). */
  enforced: boolean;
  /** Would provisioning be allowed right now (always true when not enforced). */
  provisioning_allowed: boolean;
  has_customer: boolean;
  usage: {
    period_start: string | null;
    sms: { used: number; cap: number };
    call_minutes: { used: number; used_seconds: number; cap: number };
  };
}

export function graceEndsAt(b: Pick<Business, 'billing_status' | 'past_due_since'>, env: NodeJS.ProcessEnv = process.env): string | null {
  if (b.billing_status !== 'past_due' || !b.past_due_since) return null;
  return new Date(new Date(b.past_due_since).getTime() + pastDueGraceDays(env) * 86_400_000).toISOString();
}

export async function billingSummary(b: Business, now: Date = new Date()): Promise<BillingSummary> {
  const usage = await getUsage(b.id, now);
  const status = b.billing_status ?? 'none';
  const seconds = usage?.call_seconds ?? 0;
  return {
    billing_status: status,
    plan: b.plan ?? null,
    trial_ends_at: b.trial_ends_at ?? null,
    current_period_end: b.current_period_end ?? null,
    cancel_at_period_end: b.cancel_at_period_end ?? false,
    grace_ends_at: graceEndsAt(b),
    enforced: billingEnforced(),
    provisioning_allowed: isProvisioningAllowed(b, now),
    has_customer: Boolean(b.stripe_customer_id),
    usage: {
      period_start: usage?.period_start ?? null,
      sms: { used: usage?.sms_count ?? 0, cap: smsCapFor(b) },
      call_minutes: { used: Math.floor(seconds / 60), used_seconds: seconds, cap: callMinutesCapFor(b) },
    },
  };
}
