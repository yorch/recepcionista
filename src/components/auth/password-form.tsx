'use client';
import { useState } from 'react';
import { Field, FormError, SubmitButton, friendly, go, sendJson } from './auth-ui';

/** Choose a password for a token link: reset-password (`/api/auth/reset-password`) or accept-invite. */
export function SetPasswordForm({ token, endpoint, submitLabel, redirectTo }: {
  token: string; endpoint: '/api/auth/reset-password' | '/api/auth/accept-invite'; submitLabel: string; redirectTo: string;
}) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== again) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await sendJson(endpoint, { token, password });
    if (!r.ok) {
      setBusy(false);
      setError(friendly(r.error));
      return;
    }
    go(redirectTo);
  }

  return (
    <form onSubmit={submit}>
      <Field label="New password" type="password" name="password" autoComplete="new-password" required minLength={12} maxLength={256} hint="At least 12 characters." autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      <Field label="Repeat the password" type="password" name="password2" autoComplete="new-password" required minLength={12} maxLength={256} value={again} onChange={(e) => setAgain(e.target.value)} />
      <FormError message={error} />
      <SubmitButton busy={busy}>{busy ? 'Saving...' : submitLabel}</SubmitButton>
    </form>
  );
}
