import type { Metadata } from 'next';
import Link from 'next/link';
import { AcceptExistingForm } from '@/components/auth/accept-existing-form';
import { AuthLink, AuthShell } from '@/components/auth/auth-ui';
import { SetPasswordForm } from '@/components/auth/password-form';
import { getBusiness, getUserByEmail, peekEmailToken } from '@/lib/db';
import { getServerPrincipal } from '@/lib/session';

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
    // The address already has an account: it joins this business with that account (a new membership), after proving it is signed in.
    const principal = await getServerPrincipal().catch(() => null);
    const me = principal && principal.kind === 'user' ? principal.user : null;
    if (me && me.email.toLowerCase() === invite.email.toLowerCase()) {
      return (
        <AuthShell
          title={`Join ${business.name}`}
          subtitle={`You were invited as ${invite.role}. You are signed in as ${me.email}, and you will be able to switch between your businesses from the dashboard.`}
          footer={<AuthLink href="/dashboard">Not now</AuthLink>}
        >
          <AcceptExistingForm token={token} businessName={business.name} />
        </AuthShell>
      );
    }
    const next = `/accept-invite?token=${encodeURIComponent(token)}`;
    return (
      <AuthShell
        title={`Sign in to join ${business.name}`}
        subtitle={me
          ? `This invitation was sent to ${invite.email}, but you are signed in as ${me.email}. Sign in with the invited account to accept it.`
          : `${invite.email} already has an account. Sign in with it to accept this invitation as ${invite.role}.`}
        footer={<AuthLink href="/forgot-password">Forgot your password?</AuthLink>}
      >
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="block w-full rounded-lg bg-[#ff6b35] px-3 py-2.5 text-center text-[14px] font-semibold text-[#150800] hover:bg-[#ff8558]">
          Sign in to continue
        </Link>
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
