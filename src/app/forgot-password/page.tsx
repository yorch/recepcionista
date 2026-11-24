import type { Metadata } from 'next';
import { AuthLink, AuthShell } from '@/components/auth/auth-ui';
import { ForgotPasswordForm } from '@/components/auth/forgot-form';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.meta.forgot') };
}

export default async function ForgotPasswordPage() {
  const t = await getT();
  return (
    <AuthShell
      title={t('auth.forgot.title')}
      subtitle={t('auth.forgot.subtitle')}
      footer={<><AuthLink href="/login">{t('auth.forgot.back')}</AuthLink> <LocaleSwitcher compact className="ml-2" /></>}
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
