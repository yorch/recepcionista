import type { Metadata } from 'next';
import { SignupForm } from '@/components/auth/signup-form';
import { getT } from '@/lib/i18n/server';
import { signupAvailability } from '@/lib/signup-config';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.meta.signup') };
}
export const dynamic = 'force-dynamic';

export default function SignupPage() {
  const siteKey = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '').trim() || null;
  return <SignupForm turnstileSiteKey={siteKey} disabled={!signupAvailability().open} />;
}
