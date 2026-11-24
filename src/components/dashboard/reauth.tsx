'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { ApiError, apiRequest } from '@/hooks/use-api';

/** Did the server ask for a fresh proof of identity (`requireRecentAuth`, 403 `reauth_required`)? */
export function isReauthRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && (err.payload as { code?: string } | undefined)?.code === 'reauth_required';
}

/**
 * Step-up for sensitive changes (call mode / forwarding number). Wrap the action in `guard(action)`: when the server answers
 * `reauth_required` the `panel` appears (password, or an authenticator code), the password is checked at /api/auth/reauth and the
 * action is retried ONCE. Focus moves into the panel and goes back to the control that started the action when it closes.
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
  const headingId = useId();
  const [useCode, setUseCode] = useState(false);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => { ref.current?.querySelector('input')?.focus(); }, [useCode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !secret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/api/auth/reauth', { method: 'POST', body: useCode ? { code: secret.replace(/\s/g, '') } : { password: secret } });
      setBusy(false);
      await onDone();
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    }
  }

  return (
    <form
      ref={ref} onSubmit={submit} role="group" aria-labelledby={headingId}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      className="mt-2 flex max-w-md flex-col gap-3 rounded-xl border border-line-3 bg-sunken p-4"
    >
      <div>
        <h3 id={headingId} className="text-sm font-semibold text-white">Confirm it is you</h3>
        <p className="mt-1 text-xs leading-relaxed text-dim">Changing how your business line is answered needs a fresh sign-in check. We will also tell you by email and text when it changes.</p>
      </div>
      <TextField
        label={useCode ? 'Authenticator code' : 'Password'}
        type={useCode ? 'text' : 'password'}
        inputMode={useCode ? 'numeric' : undefined}
        autoComplete={useCode ? 'one-time-code' : 'current-password'}
        value={secret} onChange={(e) => setSecret(e.target.value)} mono={useCode}
        error={error}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !secret.trim()}>{busy ? 'Checking…' : 'Confirm'}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <button
          type="button" onClick={() => { setUseCode((v) => !v); setSecret(''); setError(null); }}
          className="min-h-11 rounded-xl px-2 text-xs text-brand-soft hover:underline"
        >
          {useCode ? 'Use my password instead' : 'Use an authenticator code instead'}
        </button>
      </div>
    </form>
  );
}
