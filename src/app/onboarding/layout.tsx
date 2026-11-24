import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getServerPrincipal } from '@/lib/session';

/** Signed-in pages are never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

/**
 * Onboarding teaches, verifies and turns on a business. Allowed: the OWNER of their own (unprovisioned)
 * business, and admins. Staff and everyone else go to the dashboard. The API routes enforce the same
 * rules per request, so this guard is about UX, not security.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const principal = await getServerPrincipal();
  if (!principal) redirect('/login?next=/onboarding');
  if (principal.kind === 'user' && principal.role !== 'owner') redirect('/dashboard');
  return children;
}
