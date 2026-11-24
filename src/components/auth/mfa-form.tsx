'use client';
import { useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { safeNextPath } from '@/lib/safe-redirect';
import { AuthShell, Field, FormError, SubmitButton, friendly, go, sendJson } from './auth-ui';

export function MfaForm() {
  const t = useT();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await sendJson('/api/auth/mfa', useRecovery ? { recovery_code: code } : { code });
    if (!r.ok) {
      setBusy(false);
      setCode('');
      if (r.status === 401 && r.error !== 'invalid code') {
        // pending session gone (too many wrong codes, or it expired): back to the password step
        go('/login');
        return;
      }
      setError(friendly(t, r.error));
      return;
    }
    go(safeNextPath(new URLSearchParams(window.location.search).get('next')));
  }

  async function cancel() {
    await sendJson('/api/auth/logout', {});
    go('/login');
  }

  return (
    <AuthShell
      title={t('auth.mfa.title')}
      subtitle={useRecovery ? t('auth.mfa.subtitleRecovery') : t('auth.mfa.subtitleCode')}
    >
      <form onSubmit={submit}>
        <Field
          key={useRecovery ? 'r' : 't'}
          label={useRecovery ? t('auth.mfa.labelRecovery') : t('auth.mfa.labelCode')}
          name="code"
          autoComplete="one-time-code"
          inputMode={useRecovery ? 'text' : 'numeric'}
          pattern={useRecovery ? undefined : '[0-9 ]*'}
          maxLength={useRecovery ? 16 : 8}
          required
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <FormError message={error} />
        <SubmitButton busy={busy} disabled={!code}>{busy ? t('common.checking') : t('auth.mfa.verify')}</SubmitButton>
      </form>
      <button type="button" onClick={() => { setUseRecovery((v) => !v); setCode(''); setError(null); }} className="mt-4 w-full text-center text-[13px] text-[#8b98ab] hover:text-white">
        {useRecovery ? t('auth.mfa.useApp') : t('auth.mfa.useRecovery')}
      </button>
      <button type="button" onClick={cancel} className="mt-2 w-full text-center text-[12px] text-[#6b7b91] hover:text-[#cbd7e6]">{t('auth.mfa.cancel')}</button>
    </AuthShell>
  );
}
