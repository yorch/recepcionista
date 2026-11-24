'use client';
import { useCallback, useState } from 'react';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
import { useT } from '@/lib/i18n/client';
import { AuthLink, AuthShell, Field, FormError, SubmitButton, friendly, go, sendJson } from './auth-ui';
import { Turnstile } from './turnstile';

export function SignupForm({ turnstileSiteKey, disabled = false }: { turnstileSiteKey: string | null; disabled?: boolean }) {
  const t = useT();
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [bait, setBait] = useState('');
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onToken = useCallback((t: string | null) => setCaptcha(t), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await sendJson('/api/auth/signup', {
      email, password, business_name: businessName, company_website: bait, turnstile_token: captcha,
    });
    setBusy(false);
    if (!r.ok) {
      setError(friendly(t, r.error));
      return;
    }
    try { sessionStorage.setItem('rc_signup_email', email); } catch { /* private mode */ }
    go('/verify-email-sent');
  }

  if (disabled) {
    return (
      <AuthShell
        title={t('auth.signup.closedTitle')}
        subtitle={t('auth.signup.closedSubtitle')}
        footer={<>{t('auth.signup.haveAccount')} <AuthLink href="/login">{t('auth.signup.signIn')}</AuthLink> <LocaleSwitcher compact className="ml-2" /></>}
      >
        <p role="status" data-testid="signup-disabled" className="rounded-lg border border-[#2a3546] bg-[#080b10] p-3 text-[13px] text-[#c8d2e0]">
          {t('auth.signup.closedBody')}
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.signup.title')}
      subtitle={t('auth.signup.subtitle')}
      footer={<>{t('auth.signup.haveAccount')} <AuthLink href="/login">{t('auth.signup.signIn')}</AuthLink> <LocaleSwitcher compact className="ml-2" /></>}
    >
      <form onSubmit={submit} noValidate={false}>
        <Field label={t('auth.signup.businessName')} name="business_name" autoComplete="organization" required minLength={2} maxLength={120} value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
        <Field label={t('auth.signup.email')} type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field
          label={t('auth.signup.password')} type="password" name="password" autoComplete="new-password" required minLength={12} maxLength={256}
          hint={t('auth.signup.passwordHint')} value={password} onChange={(e) => setPassword(e.target.value)}
        />
        {/* Honeypot: invisible to people and to screen readers, irresistible to form-filling bots. */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
          <label>{t('auth.signup.honeypot')}<input type="text" name="company_website" tabIndex={-1} autoComplete="off" value={bait} onChange={(e) => setBait(e.target.value)} /></label>
        </div>
        <Turnstile siteKey={turnstileSiteKey} onToken={onToken} />
        <FormError message={error} />
        <SubmitButton busy={busy} disabled={Boolean(turnstileSiteKey) && !captcha}>{busy ? t('auth.signup.submitting') : t('auth.signup.submit')}</SubmitButton>
        <p className="mt-3 text-center text-[12px] text-[#6b7b91]">{t('auth.signup.noCharge')}</p>
      </form>
    </AuthShell>
  );
}
