/**
 * Which billing banner (if any) to show. Pure: unit-tested without a database.
 */
import { configEnv } from '@/lib/config';
import { billingEnforced, billingStateAllows, pastDueGraceDays } from '@/lib/db/usage';
import { makeT } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n/core';
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

export function bannerFor(
  b: Pick<Business, 'billing_status' | 'past_due_since' | 'trial_ends_at' | 'cancel_at_period_end' | 'current_period_end'>,
  usage: BannerUsage | null,
  canManage: boolean,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = configEnv(),
  locale: Locale = 'en',
): BannerState | null {
  const t = makeT(locale);
  const status: BillingStatus = b.billing_status ?? 'none';
  const enforced = billingEnforced(env);
  const cta = (label: string) => (canManage ? label : null);

  // Legacy / demo tenants (nothing enforced, no subscription): stay quiet.
  if (!enforced && status === 'none') return null;

  if (status === 'none') {
    return {
      kind: 'none', tone: 'danger', title: t('banner.none.title'),
      message: t(canManage ? 'banner.none.owner' : 'banner.none.staff'),
      cta: cta(t('banner.none.cta')),
    };
  }
  if (status === 'canceled') {
    return {
      kind: 'canceled', tone: 'danger', title: t('banner.canceled.title'),
      message: t(canManage ? 'banner.canceled.owner' : 'banner.canceled.staff'),
      cta: cta(t('banner.canceled.cta')),
    };
  }
  if (status === 'unpaid') {
    return {
      kind: 'unpaid', tone: 'danger', title: t('banner.unpaid.title'),
      message: t(canManage ? 'banner.unpaid.owner' : 'banner.unpaid.staff'),
      cta: cta(t('banner.updateCard')),
    };
  }
  if (status === 'past_due') {
    const grace = b.past_due_since ? new Date(new Date(b.past_due_since).getTime() + pastDueGraceDays(env) * DAY) : null;
    const left = daysLeft(grace, now);
    const stillWorks = billingStateAllows({ billing_status: status, past_due_since: b.past_due_since }, now, env);
    return {
      kind: 'past_due', tone: stillWorks ? 'warning' : 'danger', title: t('banner.pastDue.title'),
      message: stillWorks
        ? t(canManage ? 'banner.pastDue.grace.owner' : 'banner.pastDue.grace.staff', { days: left !== null ? t('banner.pastDue.days', { count: left }) : t('banner.pastDue.fewDays') })
        : t(canManage ? 'banner.pastDue.paused.owner' : 'banner.pastDue.paused.staff'),
      cta: cta(t('banner.updateCard')),
    };
  }
  if (status === 'trialing') {
    const left = daysLeft(b.trial_ends_at, now);
    if (left !== null && left <= TRIAL_BANNER_DAYS) {
      return {
        kind: 'trial_ending', tone: 'info',
        title: left === 0 ? t('banner.trial.today') : t('banner.trial.days', { count: left }),
        message: b.cancel_at_period_end ? t('banner.trial.cancels') : t('banner.trial.charge'),
        cta: cta(t('banner.manageBilling')),
      };
    }
  }
  if (usage && (status === 'trialing' || status === 'active')) {
    const smsOver = usage.sms_count >= usage.sms_cap;
    const callOver = usage.call_seconds >= usage.call_minutes_cap * 60;
    if (smsOver || callOver) {
      const what = t(smsOver && callOver ? 'banner.cap.what.both' : smsOver ? 'banner.cap.what.sms' : 'banner.cap.what.call');
      return {
        kind: 'over_cap', tone: 'warning', title: t('banner.cap.title'),
        message: t('banner.cap.message', { what, paused: enforced ? t('banner.cap.paused') : '' }) + (canManage ? t('banner.cap.contact') : t('banner.cap.askOwner')),
        cta: cta(t('banner.cap.view')),
      };
    }
  }
  return null;
}
