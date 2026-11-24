import type { Metadata } from 'next';
import { SignupForm } from '@/components/auth/signup-form';
import { signupAvailability } from '@/lib/signup-config';

export const metadata: Metadata = { title: 'Create your account' };
export const dynamic = 'force-dynamic';

export default function SignupPage() {
  const siteKey = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '').trim() || null;
  return <SignupForm turnstileSiteKey={siteKey} disabled={!signupAvailability().open} />;
}
