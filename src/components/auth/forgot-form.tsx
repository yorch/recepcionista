'use client';
import { useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { Field, FormError, FormNotice, SubmitButton, friendly, sendJson } from './auth-ui';

export function ForgotPasswordForm() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await sendJson('/api/auth/forgot-password', { email });
    setBusy(false);
    if (r.ok) setDone(true);
    else setError(friendly(t, r.error));
  }

  return (
    <form onSubmit={submit}>
      <Field label={t('auth.login.email')} type="email" name="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      <FormError message={error} />
      {done ? <FormNotice>{t('auth.forgot.sent')}</FormNotice> : null}
      <SubmitButton busy={busy}>{busy ? t('common.sending') : t('auth.forgot.submit')}</SubmitButton>
    </form>
  );
}
