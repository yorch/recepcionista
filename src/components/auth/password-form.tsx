'use client';
import { useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { Field, FormError, SubmitButton, friendly, go, sendJson } from './auth-ui';

/** Choose a password for a token link: reset-password (`/api/auth/reset-password`) or accept-invite. */
export function SetPasswordForm({ token, endpoint, submitLabel, redirectTo }: {
  token: string; endpoint: '/api/auth/reset-password' | '/api/auth/accept-invite'; submitLabel: string; redirectTo: string;
}) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== again) {
      setError(t('auth.password.mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    const r = await sendJson(endpoint, { token, password });
    if (!r.ok) {
      setBusy(false);
      setError(friendly(t, r.error));
      return;
    }
    go(redirectTo);
  }

  return (
    <form onSubmit={submit}>
      <Field label={t('auth.password.new')} type="password" name="password" autoComplete="new-password" required minLength={12} maxLength={256} hint={t('auth.signup.passwordHint')} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      <Field label={t('auth.password.repeat')} type="password" name="password2" autoComplete="new-password" required minLength={12} maxLength={256} value={again} onChange={(e) => setAgain(e.target.value)} />
      <FormError message={error} />
      <SubmitButton busy={busy}>{busy ? t('common.saving') : submitLabel}</SubmitButton>
    </form>
  );
}
