import type { Metadata } from 'next';
import { AuthLink, AuthShell } from '@/components/auth/auth-ui';
import { ResendVerificationForm } from '@/components/auth/resend-form';
import { VerifyEmailForm } from '@/components/auth/verify-email-form';
import { peekEmailToken } from '@/lib/db';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
// The token is in the URL: never leak it through the Referer header.
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.meta.verify'), referrer: 'no-referrer', robots: { index: false } };
}

/** GET only renders: the token is consumed by the POST the button sends (link scanners that open URLs cannot use it up). */
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const t = await getT();
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' ? raw : '';
  const valid = token ? await peekEmailToken('verify', token).catch(() => null) : null;
  if (!valid) {
    return (
      <AuthShell
        title={t('auth.reset.badTitle')}
        subtitle={t('auth.verify.badSubtitle')}
        footer={<AuthLink href="/login">{t('auth.forgot.back')}</AuthLink>}
      >
        <ResendVerificationForm />
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t('auth.verify.title')} subtitle={t('auth.verify.subtitle')}>
      <VerifyEmailForm token={token} />
    </AuthShell>
  );
}
