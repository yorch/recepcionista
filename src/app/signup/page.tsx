import type { Metadata } from 'next';
import { SignupForm } from '@/components/auth/signup-form';

export const metadata: Metadata = { title: 'Create your account' };

export default function SignupPage() {
  const siteKey = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '').trim() || null;
  return <SignupForm turnstileSiteKey={siteKey} />;
}
