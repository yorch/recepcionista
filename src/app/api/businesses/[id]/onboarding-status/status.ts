import type { BillingStatus } from '@/lib/types';

/** Types and pure helpers for the onboarding status API (kept out of route.ts: Next restricts route exports). */

export type OnboardingStep = 'info' | 'review' | 'verify' | 'plan' | 'provision' | 'connect' | 'test' | 'done';

/**
 * Facts the onboarding flow derives its steps from. Everything is read from the database, so a refresh
 * (or opening onboarding on another device) resumes exactly where the account really is.
 */
export interface OnboardingStatus {
  business_id: string;
  name: string;
  url: string | null;
  owner_name: string | null;
  /** The owner's own number (owner/admin only), E.164 or as entered. */
  owner_phone: string | null;
  owner_phone_verified: boolean;
  owner_phone_verified_at: string | null;
  has_knowledge: boolean;
  knowledge: { services: number; faqs: number; updated_at: string } | null;
  last_extracted: { url: string | null; at: string } | null;
  billing_status: BillingStatus;
  billing_enforced: boolean;
  /** True when billing would allow provisioning (always true when billing is not enforced, or for admins). */
  provisioning_allowed: boolean;
  trial_ends_at: string | null;
  provisioned: boolean;
  /** The business's own AI number once provisioned. */
  phone: string | null;
  /** True for the mock number pool (+1<area>555xxxx): it cannot receive real calls. */
  phone_mock: boolean;
  status: string;
  first_call_at: string | null;
  latest_call: { started_at: string; language: string | null; duration_sec: number | null; status: string } | null;
  first_booking_at: string | null;
  /** The first step whose fact is still missing (the step to resume at). */
  current_step: OnboardingStep;
}

export function nextStep(f: Pick<OnboardingStatus, 'has_knowledge' | 'owner_phone_verified' | 'provisioning_allowed' | 'provisioned' | 'first_call_at'>): OnboardingStep {
  if (!f.has_knowledge) return 'info';
  if (!f.owner_phone_verified) return 'verify';
  if (!f.provisioning_allowed && !f.provisioned) return 'plan';
  if (!f.provisioned) return 'provision';
  if (!f.first_call_at) return 'connect';
  return 'done';
}

