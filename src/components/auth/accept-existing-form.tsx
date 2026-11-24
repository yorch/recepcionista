'use client';
import { useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { FormError, SubmitButton, friendly, go, sendJson } from './auth-ui';

/** One-click acceptance of an invitation by the signed-in account it was sent to (POST /api/auth/accept-invite with just the token). */
export function AcceptExistingForm({ token, businessName }: { token: string; businessName: string }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await sendJson('/api/auth/accept-invite', { token });
    if (!r.ok) {
      setBusy(false);
      setError(r.code === 'already_member' ? t('err.alreadyMember') : friendly(t, r.error));
      return;
    }
    go('/dashboard');
  }

  return (
    <form onSubmit={submit}>
      <FormError message={error} />
      <SubmitButton busy={busy}>{busy ? t('auth.invite.joining') : t('auth.invite.join', { business: businessName })}</SubmitButton>
    </form>
  );
}
