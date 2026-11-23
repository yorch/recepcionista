import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getBusiness, listBusinesses } from '@/lib/db';
import { getServerPrincipal } from '@/lib/session';
import { planPriceDisplay } from '@/app/site-config';
import { OnboardingFlow } from './flow';
import { STEP_IDS, type StepId } from './steps';

export const metadata: Metadata = { title: 'Set up your front desk', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await getServerPrincipal();
  if (!principal) redirect('/login?next=/onboarding');
  const sp = await searchParams;

  const isAdmin = principal.kind === 'admin';
  let businessId: string | null = null;
  let resumable: { id: string; name: string }[] = [];

  if (principal.kind === 'user') {
    businessId = principal.business_id;
  } else {
    const requested = first(sp.b);
    if (requested && (await getBusiness(requested))) businessId = requested;
    if (!businessId) {
      resumable = (await listBusinesses()).filter((b) => b.status === 'onboarding').slice(0, 5).map((b) => ({ id: b.id, name: b.name }));
    }
  }

  const step = first(sp.step);
  const checkout = first(sp.checkout);
  return (
    <OnboardingFlow
      businessId={businessId}
      isAdmin={isAdmin}
      priceDisplay={planPriceDisplay()}
      requestedStep={STEP_IDS.includes(step as StepId) ? (step as StepId) : null}
      checkout={checkout === 'success' || checkout === 'cancel' ? checkout : null}
      resumable={resumable}
    />
  );
}
