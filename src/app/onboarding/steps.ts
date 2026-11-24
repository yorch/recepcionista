import type { OnboardingStatus } from '@/app/api/businesses/[id]/onboarding-status/status';

export const STEP_IDS = ['info', 'review', 'verify', 'plan', 'provision', 'connect', 'test'] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABELS: Record<StepId, string> = {
  info: 'Your business',
  review: 'Review',
  verify: 'Your phone',
  plan: 'Plan',
  provision: 'Her number',
  connect: 'Connect',
  test: 'Test call',
};

/** Furthest step the facts allow (earlier steps are always reachable; later ones need their prerequisite). */
export function maxStepFor(s: OnboardingStatus | null): StepId {
  if (!s || !s.has_knowledge) return 'info';
  if (!s.owner_phone_verified) return 'verify';
  if (s.provisioned) return 'test';
  if (!s.provisioning_allowed) return 'plan';
  return 'provision';
}

export function isStepAllowed(step: StepId, s: OnboardingStatus | null): boolean {
  return STEP_IDS.indexOf(step) <= STEP_IDS.indexOf(maxStepFor(s));
}

/** The step to open on: the requested one when allowed, otherwise where the account really is. */
export function resolveStep(requested: StepId | null, s: OnboardingStatus | null): StepId {
  if (requested && isStepAllowed(requested, s)) return requested;
  if (!s) return 'info';
  switch (s.current_step) {
    case 'info': return 'info';
    case 'review': return 'review';
    case 'verify': return s.has_knowledge ? 'review' : 'info';
    case 'plan': return 'plan';
    case 'provision': return 'provision';
    case 'connect': return 'connect';
    default: return 'test';
  }
}

export function stepDone(step: StepId, s: OnboardingStatus | null): boolean {
  if (!s) return false;
  switch (step) {
    case 'info': case 'review': return s.has_knowledge;
    case 'verify': return s.owner_phone_verified;
    case 'plan': return s.provisioned || (s.provisioning_allowed && (s.billing_status === 'trialing' || s.billing_status === 'active' || !s.billing_enforced));
    case 'provision': return s.provisioned;
    case 'connect': case 'test': return Boolean(s.first_call_at);
  }
}
