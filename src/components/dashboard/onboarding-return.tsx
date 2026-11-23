'use client';
import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * Stripe Checkout returns to /dashboard/billing?checkout=success|cancel. If the business is still being
 * set up, the next step lives in onboarding, so carry the result there instead of stranding the owner.
 */
export function OnboardingReturn({ unprovisioned }: { unprovisioned: boolean }) {
  const router = useRouter();
  const result = useSearchParams().get('checkout');
  useEffect(() => {
    if (unprovisioned && (result === 'success' || result === 'cancel')) {
      router.replace(`/onboarding?checkout=${result}`);
    }
  }, [unprovisioned, result, router]);
  return null;
}
