import type { Metadata } from 'next';
import { SignupForm } from '@/components/auth/signup-form';
import { setting } from '@/lib/config';
import { getT } from '@/lib/i18n/server';
import { signupAvailability } from '@/lib/signup-config';
import { legalLinks } from '@/lib/legal-links';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.meta.signup') };
}
export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  const siteKey = (setting('signup.turnstile_site_key') ?? '').trim() || null; // request time, from the config snapshot (never inlined at build time)
  const legal = await legalLinks().catch(() => ({ terms: null, privacy: null, sms_terms: null }));
  return <SignupForm turnstileSiteKey={siteKey} disabled={!signupAvailability().open} legal={{ terms: legal.terms, privacy: legal.privacy }} />;
}
