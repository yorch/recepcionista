'use client';
import { useState } from 'react';
import { FormError, SubmitButton, friendly, go, sendJson } from './auth-ui';

/** One-click acceptance of an invitation by the signed-in account it was sent to (POST /api/auth/accept-invite with just the token). */
export function AcceptExistingForm({ token, businessName }: { token: string; businessName: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await sendJson('/api/auth/accept-invite', { token });
    if (!r.ok) {
      setBusy(false);
      setError(r.code === 'already_member' ? 'You are already a member of this business.' : friendly(r.error));
      return;
    }
    go('/dashboard');
  }

  return (
    <form onSubmit={submit}>
      <FormError message={error} />
      <SubmitButton busy={busy}>{busy ? 'Joining...' : `Join ${businessName}`}</SubmitButton>
    </form>
  );
}
