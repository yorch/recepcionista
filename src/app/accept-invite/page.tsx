import type { Metadata } from 'next';
import { AuthLink, AuthShell } from '@/components/auth/auth-ui';
import { SetPasswordForm } from '@/components/auth/password-form';
import { getBusiness, getUserByEmail, peekEmailToken } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Accept your invitation', referrer: 'no-referrer', robots: { index: false } };

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' ? raw : '';
  const invite = token ? await peekEmailToken('invite', token).catch(() => null) : null;
  const business = invite?.business_id ? await getBusiness(invite.business_id).catch(() => null) : null;
  if (!invite || !business) {
    return (
      <AuthShell
        title="This invitation does not work"
        subtitle="It may have expired, been used, or been withdrawn. Ask the person who invited you to send a new one."
        footer={<AuthLink href="/login">Back to sign in</AuthLink>}
      >
        <p className="text-center text-[13px] text-mute">Invitations work once and expire after 7 days.</p>
      </AuthShell>
    );
  }
  const exists = await getUserByEmail(invite.email).catch(() => null);
  if (exists) {
    return (
      <AuthShell
        title="You already have an account"
        subtitle={`${invite.email} is already registered, and an account belongs to a single business, so this invitation to ${business.name} cannot be accepted with it.`}
        footer={<AuthLink href="/login">Sign in</AuthLink>}
      >
        <p className="text-[13px] text-body">Ask {business.name} to invite a different email address, or sign in with the account you have.</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell
      title={`Join ${business.name}`}
      subtitle={`You were invited as ${invite.role} (${invite.email}). Choose a password to finish.`}
    >
      <SetPasswordForm token={token} endpoint="/api/auth/accept-invite" submitLabel="Create my account" redirectTo="/dashboard" />
    </AuthShell>
  );
}
