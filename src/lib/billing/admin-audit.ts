/**
 * Audit values of an admin billing override (`billing.admin_override`): the before/after of EVERY field the endpoint can change
 * (status, plan, trial / period dates, SMS and call-minute caps), in a sanitized, fixed shape: strings capped, dates as ISO strings,
 * caps as integers or null. Pure (no I/O). Money and secrets never appear here; the free-text note is added by the caller.
 */
import type { Business } from '@/lib/types';

export type AdminBillingValues = {
  billing_status: string;
  plan: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  sms_cap_override: number | null;
  call_minutes_cap_override: number | null;
};

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const cap = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

export function adminBillingValues(b: Pick<Business, 'billing_status' | 'plan' | 'trial_ends_at' | 'current_period_end' | 'sms_cap_override' | 'call_minutes_cap_override'>): AdminBillingValues {
  return {
    billing_status: text(b.billing_status, 20) ?? 'none',
    plan: text(b.plan, 60),
    trial_ends_at: iso(b.trial_ends_at),
    current_period_end: iso(b.current_period_end),
    sms_cap_override: cap(b.sms_cap_override),
    call_minutes_cap_override: cap(b.call_minutes_cap_override),
  };
}
