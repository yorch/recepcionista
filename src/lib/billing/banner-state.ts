/**
 * Which billing banner (if any) to show. Pure: unit-tested without a database.
 */
import { billingEnforced, billingStateAllows, pastDueGraceDays } from '@/lib/db/usage';
import type { BillingStatus, Business } from '@/lib/types';

export type BannerKind = 'trial_ending' | 'past_due' | 'unpaid' | 'canceled' | 'none' | 'over_cap';
export type BannerTone = 'warning' | 'danger' | 'info';

export interface BannerState {
  kind: BannerKind;
  tone: BannerTone;
  title: string;
  message: string;
  /** Label of the call to action (owners/admins only; null for staff). */
  cta: string | null;
}

export interface BannerUsage {
  sms_count: number;
  call_seconds: number;
  sms_cap: number;
  call_minutes_cap: number;
}

const DAY = 86_400_000;
export const TRIAL_BANNER_DAYS = 3;

export function daysLeft(until: string | Date | null | undefined, now: Date): number | null {
  if (!until) return null;
  const t = new Date(until).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t - now.getTime()) / DAY));
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function bannerFor(
  b: Pick<Business, 'billing_status' | 'past_due_since' | 'trial_ends_at' | 'cancel_at_period_end' | 'current_period_end'>,
  usage: BannerUsage | null,
  canManage: boolean,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): BannerState | null {
  const status: BillingStatus = b.billing_status ?? 'none';
  const enforced = billingEnforced(env);
  const cta = (label: string) => (canManage ? label : null);
  const ask = canManage ? '' : ' Ask the account owner to fix this.';

  // Legacy / demo tenants (nothing enforced, no subscription): stay quiet.
  if (!enforced && status === 'none') return null;

  if (status === 'none') {
    return {
      kind: 'none', tone: 'danger', title: 'Start your free trial',
      message: `Your receptionist is not active yet.${canManage ? ' Add a card to start your free trial; you will not be charged until it ends.' : ask}`,
      cta: cta('Start free trial'),
    };
  }
  if (status === 'canceled') {
    return {
      kind: 'canceled', tone: 'danger', title: 'Subscription canceled',
      message: `Your plan is canceled, so calls and texts are paused.${canManage ? ' Resubscribe to turn your receptionist back on.' : ask}`,
      cta: cta('Resubscribe'),
    };
  }
  if (status === 'unpaid') {
    return {
      kind: 'unpaid', tone: 'danger', title: 'Payment required',
      message: `We could not collect payment and your plan is on hold.${canManage ? ' Update your card to resume service.' : ask}`,
      cta: cta('Update payment method'),
    };
  }
  if (status === 'past_due') {
    const grace = b.past_due_since ? new Date(new Date(b.past_due_since).getTime() + pastDueGraceDays(env) * DAY) : null;
    const left = daysLeft(grace, now);
    const stillWorks = billingStateAllows({ billing_status: status, past_due_since: b.past_due_since }, now, env);
    return {
      kind: 'past_due', tone: stillWorks ? 'warning' : 'danger', title: 'Payment failed',
      message: stillWorks
        ? `We could not charge your card. Service continues for ${left !== null ? plural(left, 'more day') : 'a few more days'}.${canManage ? ' Update your payment method to avoid interruption.' : ask}`
        : `We could not charge your card and the grace period has ended, so service is paused.${canManage ? ' Update your payment method to resume.' : ask}`,
      cta: cta('Update payment method'),
    };
  }
  if (status === 'trialing') {
    const left = daysLeft(b.trial_ends_at, now);
    if (left !== null && left <= TRIAL_BANNER_DAYS) {
      return {
        kind: 'trial_ending', tone: 'info',
        title: left === 0 ? 'Your trial ends today' : `Your trial ends in ${plural(left, 'day')}`,
        message: b.cancel_at_period_end
          ? 'Your subscription is set to cancel; service will stop when the trial ends.'
          : 'Your card will be charged when the trial ends. You can cancel any time before that.',
        cta: cta('Manage billing'),
      };
    }
  }
  if (usage && (status === 'trialing' || status === 'active')) {
    const smsOver = usage.sms_count >= usage.sms_cap;
    const callOver = usage.call_seconds >= usage.call_minutes_cap * 60;
    if (smsOver || callOver) {
      const what = smsOver && callOver ? 'text and call-minute' : smsOver ? 'text' : 'call-minute';
      return {
        kind: 'over_cap', tone: 'warning', title: 'Monthly limit reached',
        message: `You have used all of this month's ${what} allowance${enforced ? ', so that service is paused until the next period' : ''}.${canManage ? ' Contact us to raise your limit.' : ask}`,
        cta: cta('View usage'),
      };
    }
  }
  return null;
}
