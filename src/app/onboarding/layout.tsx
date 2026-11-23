import { redirect } from 'next/navigation';
import { getServerPrincipal } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Onboarding creates and provisions businesses: admin-only (tenants already have their business). */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const principal = await getServerPrincipal();
  if (!principal) redirect('/login?next=/onboarding');
  if (principal.kind !== 'admin') redirect('/dashboard');
  return children;
}
