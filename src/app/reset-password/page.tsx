import type { Metadata } from 'next';
import { AuthLink, AuthShell } from '@/components/auth/auth-ui';
import { SetPasswordForm } from '@/components/auth/password-form';
import { peekEmailToken } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Choose a new password', referrer: 'no-referrer', robots: { index: false } };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' ? raw : '';
  const valid = token ? await peekEmailToken('reset', token).catch(() => null) : null;
  if (!valid) {
    return (
      <AuthShell
        title="This link does not work"
        subtitle="Reset links work once and expire after one hour."
        footer={<AuthLink href="/login">Back to sign in</AuthLink>}
      >
        <p className="text-center text-[14px]"><AuthLink href="/forgot-password">Send me a new link</AuthLink></p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Choose a new password" subtitle="You will be signed out of every device.">
      <SetPasswordForm token={token} endpoint="/api/auth/reset-password" submitLabel="Save password" redirectTo="/login?reset=1" />
    </AuthShell>
  );
}
