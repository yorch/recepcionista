import type { TenantRow } from '@/lib/admin/tenants';
import type { PlanView } from '@/lib/admin/plans';
import type { TenantKnob } from '@/lib/admin/tenant-overrides';
import type { AdminView } from '@/lib/admin/admins';
import type { SupportGrantView } from '@/lib/admin/support';

/** Types of the tenant, plan and administrator pages (only TYPES come from the server modules). */
export type { TenantRow, PlanView, TenantKnob, AdminView, SupportGrantView };

export interface TenantList { items: TenantRow[]; next_cursor: string | null }

export interface TenantUsage { period_start: string; sms_count: number; call_seconds: number; forward_seconds: number; voicemail_seconds: number }

export interface TenantDetail {
  id: string; name: string; status: string; timezone: string | null; vertical: string | null; locale_default: string | null; created_at: string;
  closed_dates: string[];
  contact: { phone: string | null; owner_phone: string | null; owner_name: string | null; owner_phone_verified: boolean };
  provider_ids: { agent_id: string | null; elevenlabs_phone_number_id: string | null; twilio_phone_sid: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null };
  billing: {
    status: string; plan: string | null; plan_comped: boolean; interval: string | null; trial_ends_at: string | null; current_period_end: string | null; past_due_since: string | null;
    sms_cap_override: number | null; call_minutes_cap_override: number | null;
  };
  call_mode: string | null;
  suspension: { suspended: boolean; suspended_at: string | null; reason: string | null; by: string | null };
  users: { id: string; email: string; role: string; disabled: boolean; two_factor: boolean; created_at: string }[];
  usage: TenantUsage | null;
  overrides: TenantKnob[];
  support_grants: { id: string; user_id: string; reason: string; started_at: string; expires_at: string; ended_at: string | null }[];
  audit: AuditRow[];
  platform: { default_vertical: string | null };
}

export interface AuditRow { id: string; at: string; action: string; actor_kind: string; actor_user_id: string | null; target: string | null; meta: unknown }

export const BILLING_STATUSES = ['none', 'trialing', 'active', 'past_due', 'canceled', 'unpaid'] as const;
export const TENANT_STATUSES = ['onboarding', 'live', 'paused'] as const;

/** Minutes with one decimal from seconds. */
export const minutesOf = (seconds: number): number => Math.round((seconds / 60) * 10) / 10;

/** `YYYY-MM-DD` of an ISO instant for a date input, or ''. */
export const dateInput = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '');
/** End of the given calendar day (UTC) as an ISO instant, or null for ''. */
export const endOfDayIso = (d: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T23:59:59.000Z` : null);

/** The phrase to type before a critical tenant action: the action word and the business name, lowercase, trimmed. */
export const tenantPhrase = (verb: string, name: string): string => `${verb} ${name}`.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
