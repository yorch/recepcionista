import type { Metadata } from 'next';
import { AuthLink, AuthShell } from '@/components/auth/auth-ui';
import { ResendVerificationForm } from '@/components/auth/resend-form';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.meta.verifySent') };
}

export default async function VerifyEmailSentPage() {
  const t = await getT();
  return (
    <AuthShell
      title={t('auth.verifySent.title')}
      subtitle={t('auth.verifySent.subtitle')}
      footer={<>{t('auth.verifySent.already')} <AuthLink href="/login?next=/onboarding">{t('auth.signup.signIn')}</AuthLink></>}
    >
      <p className="text-[13px] text-body">{t('auth.verifySent.hint')}</p>
      <div className="mt-3"><ResendVerificationForm /></div>
    </AuthShell>
  );
}
