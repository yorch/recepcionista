import type { Metadata } from 'next';
import { AuthLink, AuthShell } from '@/components/auth/auth-ui';
import { SetPasswordForm } from '@/components/auth/password-form';
import { peekEmailToken } from '@/lib/db';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.meta.reset'), referrer: 'no-referrer', robots: { index: false } };
}

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const t = await getT();
  const raw = (await searchParams).token;
  const token = typeof raw === 'string' ? raw : '';
  const valid = token ? await peekEmailToken('reset', token).catch(() => null) : null;
  if (!valid) {
    return (
      <AuthShell
        title={t('auth.reset.badTitle')}
        subtitle={t('auth.reset.badSubtitle')}
        footer={<AuthLink href="/login">{t('auth.forgot.back')}</AuthLink>}
      >
        <p className="text-center text-[14px]"><AuthLink href="/forgot-password">{t('auth.reset.sendNew')}</AuthLink></p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t('auth.reset.title')} subtitle={t('auth.reset.subtitle')}>
      <SetPasswordForm token={token} endpoint="/api/auth/reset-password" submitLabel={t('auth.reset.save')} redirectTo="/login?reset=1" />
    </AuthShell>
  );
}
