'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';
import { passkeyErrorMessage, reauthWithPasskey, useWebAuthnSupport } from '@/lib/passkey-client';

/** Did the server ask for a fresh proof of identity (`requireRecentAuth`, 403 `reauth_required`)? */
export function isReauthRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && (err.payload as { code?: string } | undefined)?.code === 'reauth_required';
}

/**
 * Step-up for sensitive changes (call mode / forwarding number). Wrap the action in `guard(action)`: when the server answers
 * `reauth_required` the `panel` appears (password; an authenticator code for an account with 2FA, which the server REQUIRES; the admin
 * token for a break-glass admin session), the proof is checked at /api/auth/reauth and the action is retried ONCE. Focus moves into the panel and goes back to the control that started the action when it closes.
 */
export function useReauth(onError: (err: unknown) => void = () => undefined) {
  const [pending, setPending] = useState<{ retry: () => Promise<void> } | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const guard = useCallback(async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (err) {
      if (!isReauthRequired(err)) throw err;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPending({ retry: action });
    }
  }, []);

  const close = useCallback(() => {
    setPending(null);
    const el = opener.current;
    opener.current = null;
    // after the panel unmounts, put focus back where the person was
    requestAnimationFrame(() => { if (el && el.isConnected) el.focus(); });
  }, []);

  const panel = pending ? <ReauthPanel onCancel={close} onDone={async () => { const p = pending; close(); try { await p.retry(); } catch (err) { onError(err); } }} /> : null;
  return { guard, panel };
}

function ReauthPanel({ onCancel, onDone }: { onCancel: () => void; onDone: () => Promise<void> }) {
  const t = useT();
  const headingId = useId();
  const [mode, setMode] = useState<'password' | 'code' | 'token'>('password');
  const useCode = mode === 'code';
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => { ref.current?.querySelector('input')?.focus(); }, [mode]);
  const canPasskey = useWebAuthnSupport() === true;

  async function viaPasskey() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await reauthWithPasskey();
      setBusy(false);
      await onDone();
    } catch (err) {
      setBusy(false);
      // 409 no_passkey: this account has none registered
      setError(err instanceof ApiError ? (err.status === 409 ? t('reauth.noPasskeys') : errorText(t, err)) : passkeyErrorMessage(err, t));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !secret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/api/auth/reauth', {
        method: 'POST', body: mode === 'code' ? { code: secret.replace(/\s/g, '') } : mode === 'token' ? { admin_token: secret } : { password: secret },
      });
      setBusy(false);
      await onDone();
    } catch (err) {
      setBusy(false);
      // A 2FA account must use its authenticator code: switch to it instead of asking for the password again.
      if (err instanceof ApiError && (err.payload as { code?: string } | undefined)?.code === 'totp_required') { setMode('code'); setSecret(''); }
      setError(err instanceof ApiError ? errorText(t, err) : t('err.generic'));
    }
  }

  return (
    <form
      ref={ref} onSubmit={submit} role="group" aria-labelledby={headingId}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      className="mt-2 flex max-w-md flex-col gap-3 rounded-xl border border-line-3 bg-sunken p-4"
    >
      <div>
        <h3 id={headingId} className="text-sm font-semibold text-white">{t('reauth.title')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-dim">{t('reauth.body')}</p>
      </div>
      <TextField
        label={useCode ? t('reauth.authCode') : mode === 'token' ? t('auth.login.adminToken') : t('auth.login.password')}
        type={useCode ? 'text' : 'password'}
        inputMode={useCode ? 'numeric' : undefined}
        autoComplete={useCode ? 'one-time-code' : mode === 'token' ? 'off' : 'current-password'}
        value={secret} onChange={(e) => setSecret(e.target.value)} mono={useCode}
        error={error}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !secret.trim()}>{busy ? t('common.checking') : t('common.confirm')}</Button>
        <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
        <button
          type="button" onClick={() => { setMode(useCode ? 'password' : 'code'); setSecret(''); setError(null); }}
          className="min-h-11 rounded-xl px-2 text-xs text-brand-soft hover:underline"
        >
          {useCode ? t('reauth.usePassword') : t('reauth.useCode')}
        </button>
        {canPasskey && mode !== 'token' ? (
          <button type="button" onClick={viaPasskey} disabled={busy} className="min-h-11 rounded-xl px-2 text-xs text-brand-soft hover:underline disabled:opacity-50">
            {t('reauth.usePasskey')}
          </button>
        ) : null}
        <button
          type="button" onClick={() => { setMode(mode === 'token' ? 'password' : 'token'); setSecret(''); setError(null); }}
          className="min-h-11 rounded-xl px-2 text-xs text-brand-soft hover:underline"
        >
          {mode === 'token' ? t('reauth.usePassword') : t('reauth.signedWithToken')}
        </button>
      </div>
    </form>
  );
}
