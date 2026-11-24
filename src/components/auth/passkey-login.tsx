'use client';
import { startAuthentication, browserSupportsWebAuthn, browserSupportsWebAuthnAutofill } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { apiErrorMessage } from '@/lib/i18n/api-errors';
import { go } from '@/components/auth/auth-ui';
import { passkeyErrorMessage, useWebAuthnSupport } from '@/lib/passkey-client';
import { safeNextPath } from '@/lib/safe-redirect';

/**
 * "Sign in with a passkey" for the login page. Renders nothing where WebAuthn is unavailable. Where the browser supports it, it also starts
 * CONDITIONAL UI on mount: the email field (autocomplete="username webauthn") offers the site's passkeys in the browser's autofill list,
 * and choosing one signs in without pressing anything. The explicit button runs the modal ceremony (and cancels the autofill one).
 * The server answers every caller the same (no account hint), the assertion carries user verification, and the new session needs no
 * second step even for an account with an authenticator app.
 */
export function PasskeyLogin({ disabled }: { disabled?: boolean }) {
  const t = useT();
  const supported = useWebAuthnSupport() === true;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const run = useCallback(async (auto: boolean) => {
    const res = await fetch('/api/auth/passkeys/login/options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', cache: 'no-store' });
    const json = (await res.json().catch(() => null)) as { data?: { options?: PublicKeyCredentialRequestOptionsJSON }; error?: string } | null;
    if (!res.ok || !json?.data?.options) throw new Error(json?.error === 'passkeys are not configured on this server' ? apiErrorMessage(t, json.error) : t('auth.passkey.unavailable'));
    const response = await startAuthentication({ optionsJSON: json.data.options, useBrowserAutofill: auto });
    const v = await fetch('/api/auth/passkeys/login/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response }) });
    if (!v.ok) {
      const body = (await v.json().catch(() => null)) as { error?: string } | null;
      throw new Error(v.status === 429 ? t('err.rateLimit') : body?.error ? apiErrorMessage(t, body.error) : t('auth.passkey.failed'));
    }
    go(safeNextPath(new URLSearchParams(window.location.search).get('next')));
  }, [t]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!browserSupportsWebAuthn()) return;
    void (async () => {
      try {
        if (!(await browserSupportsWebAuthnAutofill())) return;
        await run(true);
      } catch {
        /* the autofill ceremony ends silently when the person ignores it or starts the button flow */
      }
    })();
  }, [run]);

  if (!supported) return null;

  async function click() {
    setBusy(true);
    setError(null);
    try {
      await run(false);
    } catch (err) {
      setError(passkeyErrorMessage(err, t));
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={click}
        disabled={busy || disabled}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-[#2a3546] px-3 py-2 text-[14px] font-medium text-white hover:bg-[#121a24] disabled:opacity-50"
      >
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 11-5.7M17 14v7m0-4h3m-3 3h2" />
        </svg>
        {busy ? t('auth.passkey.waiting') : t('auth.passkey.signIn')}
      </button>
      {error ? <p role="alert" className="mt-2 text-[12px] text-[#ff7b7b]">{error}</p> : null}
    </div>
  );
}
