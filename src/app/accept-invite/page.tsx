import type { Metadata } from 'next';
import Link from 'next/link';
import { AcceptExistingForm } from '@/components/auth/accept-existing-form';
import { AuthLink, AuthShell } from '@/components/auth/auth-ui';
import { SetPasswordForm } from '@/components/auth/password-form';
import { getBusiness, getUserByEmail, peekEmailToken } from '@/lib/db';
import { getT } from '@/lib/i18n/server';
import { getServerPrincipal } from '@/lib/session';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.invite.pageTitle'), referrer: 'no-referrer', robots: { index: false } };
}

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const t = await getT();
  const raw = (await searchParams).token;
  const roleName = (r: string | null) => (r === 'owner' ? t('auth.role.owner') : t('auth.role.staff'));
  const token = typeof raw === 'string' ? raw : '';
  const invite = token ? await peekEmailToken('invite', token).catch(() => null) : null;
  const business = invite?.business_id ? await getBusiness(invite.business_id).catch(() => null) : null;
  if (!invite || !business) {
    return (
      <AuthShell
        title={t('auth.invite.badTitle')}
        subtitle={t('auth.invite.badSubtitle')}
        footer={<AuthLink href="/login">{t('auth.forgot.back')}</AuthLink>}
      >
        <p className="text-center text-[13px] text-mute">{t('auth.invite.badNote')}</p>
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
          title={t('auth.invite.joinTitle', { business: business.name })}
          subtitle={t('auth.invite.joinSubtitleSigned', { role: roleName(invite.role), email: me.email })}
          footer={<AuthLink href="/dashboard">{t('auth.invite.notNow')}</AuthLink>}
        >
          <AcceptExistingForm token={token} businessName={business.name} />
        </AuthShell>
      );
    }
    const next = `/accept-invite?token=${encodeURIComponent(token)}`;
    return (
      <AuthShell
        title={t('auth.invite.signInTitle', { business: business.name })}
        subtitle={me
          ? t('auth.invite.signInOther', { invited: invite.email, email: me.email })
          : t('auth.invite.signInExisting', { email: invite.email, role: roleName(invite.role) })}
        footer={<AuthLink href="/forgot-password">{t('auth.invite.forgot')}</AuthLink>}
      >
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="block w-full rounded-lg bg-[#ff6b35] px-3 py-2.5 text-center text-[14px] font-semibold text-[#150800] hover:bg-[#ff8558]">
          {t('auth.invite.signInContinue')}
        </Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell
      title={t('auth.invite.joinTitle', { business: business.name })}
      subtitle={t('auth.invite.newSubtitle', { role: roleName(invite.role), email: invite.email })}
    >
      <SetPasswordForm token={token} endpoint="/api/auth/accept-invite" submitLabel={t('auth.invite.createAccount')} redirectTo="/dashboard" />
    </AuthShell>
  );
}
