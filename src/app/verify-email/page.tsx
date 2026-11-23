import type { Metadata } from 'next';
import { AuthLink, AuthShell } from '@/components/auth/auth-ui';
import { ResendVerificationForm } from '@/components/auth/resend-form';
import { VerifyEmailForm } from '@/components/auth/verify-email-form';
import { peekEmailToken } from '@/lib/db';

export const dynamic = 'force-dynamic';
// The token is in the URL: never leak it through the Referer header.
export const metadata: Metadata = { title: 'Confirm your email', referrer: 'no-referrer', robots: { index: false } };

/** GET only renders: the token is consumed by the POST the button sends (link scanners that open URLs cannot use it up). */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' ? raw : '';
  const valid = token ? await peekEmailToken('verify', token).catch(() => null) : null;
  if (!valid) {
    return (
      <AuthShell
        title="This link does not work"
        subtitle="It may have expired or already been used. Ask for a new one below."
        footer={<AuthLink href="/login">Back to sign in</AuthLink>}
      >
        <ResendVerificationForm />
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Confirm your email" subtitle="One more click to finish setting up your account.">
      <VerifyEmailForm token={token} />
    </AuthShell>
  );
}
