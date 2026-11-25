import { demoModeEnabled } from '@/lib/auth';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getBusiness, listBusinesses } from '@/lib/db';
import { getServerPrincipal } from '@/lib/session';
import { planPriceDisplay, planPriceDisplayAnnual } from '@/app/site-config';
import { annualAvailable } from '@/lib/providers/stripe-billing';
import { getLocale, getT } from '@/lib/i18n/server';
import { OnboardingFlow } from './flow';
import { STEP_IDS, type StepId } from './steps';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('ob.metaTitle'), robots: { index: false, follow: false } };
}
export const dynamic = 'force-dynamic';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await getServerPrincipal();
  if (!principal) redirect('/login?next=/onboarding');
  const locale = await getLocale();
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
      demoEnabled={demoModeEnabled()}
      priceDisplay={planPriceDisplay(locale)}
      annualAvailable={annualAvailable()}
      annualDisplay={planPriceDisplayAnnual(locale)}
      requestedStep={STEP_IDS.includes(step as StepId) ? (step as StepId) : null}
      checkout={checkout === 'success' || checkout === 'cancel' ? checkout : null}
      resumable={resumable}
    />
  );
}
