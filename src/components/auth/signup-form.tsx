'use client';
import { useCallback, useState } from 'react';
import { AuthLink, AuthShell, Field, FormError, SubmitButton, friendly, go, sendJson } from './auth-ui';
import { Turnstile } from './turnstile';

export function SignupForm({ turnstileSiteKey, disabled = false }: { turnstileSiteKey: string | null; disabled?: boolean }) {
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
      setError(friendly(r.error));
      return;
    }
    try { sessionStorage.setItem('rc_signup_email', email); } catch { /* private mode */ }
    go('/verify-email-sent');
  }

  if (disabled) {
    return (
      <AuthShell
        title="Sign-up is invite-only"
        subtitle="New accounts are currently by invitation only."
        footer={<>Already have an account? <AuthLink href="/login">Sign in</AuthLink></>}
      >
        <p role="status" data-testid="signup-disabled" className="rounded-lg border border-[#2a3546] bg-[#080b10] p-3 text-[13px] text-[#c8d2e0]">
          Public sign-up is currently disabled. If your team already uses Recepcionista, ask an owner to send you an invitation; the
          link in that email lets you create your account.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Start with your business name. We will email you a link to confirm your address."
      footer={<>Already have an account? <AuthLink href="/login">Sign in</AuthLink></>}
    >
      <form onSubmit={submit} noValidate={false}>
        <Field label="Business name" name="business_name" autoComplete="organization" required minLength={2} maxLength={120} value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
        <Field label="Work email" type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field
          label="Password" type="password" name="password" autoComplete="new-password" required minLength={12} maxLength={256}
          hint="At least 12 characters." value={password} onChange={(e) => setPassword(e.target.value)}
        />
        {/* Honeypot: invisible to people and to screen readers, irresistible to form-filling bots. */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
          <label>Leave this empty<input type="text" name="company_website" tabIndex={-1} autoComplete="off" value={bait} onChange={(e) => setBait(e.target.value)} /></label>
        </div>
        <Turnstile siteKey={turnstileSiteKey} onToken={onToken} />
        <FormError message={error} />
        <SubmitButton busy={busy} disabled={Boolean(turnstileSiteKey) && !captcha}>{busy ? 'Creating account...' : 'Create account'}</SubmitButton>
        <p className="mt-3 text-center text-[12px] text-[#6b7b91]">Creating an account does not start any paid service.</p>
      </form>
    </AuthShell>
  );
}
