import type { Metadata } from 'next';
import { AuthLink, AuthShell } from '@/components/auth/auth-ui';
import { ResendVerificationForm } from '@/components/auth/resend-form';

export const metadata: Metadata = { title: 'Check your email' };

export default function VerifyEmailSentPage() {
  return (
    <AuthShell
      title="Check your email"
      subtitle="If the address can be used, a confirmation link is on its way. It works once and expires in 24 hours."
      footer={<>Already confirmed? <AuthLink href="/login?next=/onboarding">Sign in</AuthLink></>}
    >
      <p className="text-[13px] text-body">Nothing arrived after a few minutes? Check your spam folder, or ask for a new link:</p>
      <div className="mt-3"><ResendVerificationForm /></div>
    </AuthShell>
  );
}
