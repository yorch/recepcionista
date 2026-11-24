'use client';
import { useState } from 'react';
import { Field, FormError, FormNotice, SubmitButton, friendly, sendJson } from './auth-ui';

export function ForgotPasswordForm() {
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
    else setError(friendly(r.error));
  }

  return (
    <form onSubmit={submit}>
      <Field label="Email" type="email" name="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      <FormError message={error} />
      {done ? <FormNotice>If that address has an account, we sent a link to choose a new password. It works once for one hour.</FormNotice> : null}
      <SubmitButton busy={busy}>{busy ? 'Sending...' : 'Send reset link'}</SubmitButton>
    </form>
  );
}
