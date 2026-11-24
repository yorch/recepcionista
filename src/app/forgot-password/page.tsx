import type { Metadata } from 'next';
import { AuthLink, AuthShell } from '@/components/auth/auth-ui';
import { ForgotPasswordForm } from '@/components/auth/forgot-form';

export const metadata: Metadata = { title: 'Reset your password' };

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email and we will send you a link to choose a new one."
      footer={<AuthLink href="/login">Back to sign in</AuthLink>}
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
