'use client';
import { useState } from 'react';
import { go } from '@/components/auth/auth-ui';
import { PasskeyLogin } from '@/components/auth/passkey-login';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
import { apiErrorMessage } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';
import { safeNextPath } from '@/lib/safe-redirect';

const inputCls =
  'mt-1 w-full rounded-lg border border-[#1b2430] bg-[#080b10] px-3 py-2 text-[14px] text-white outline-none focus:border-[#ff6b35]';

export default function LoginPage() {
  const t = useT();
  const [adminMode, setAdminMode] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const q = new URLSearchParams(window.location.search);
    if (q.get('reset') === '1') return 'reset';
    return null;
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(adminMode ? { token } : { email, password }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setError(json?.error ? apiErrorMessage(t, json.error) : t('auth.login.failed'));
        return;
      }
      const next = new URLSearchParams(window.location.search).get('next');
      const json = await res.json().catch(() => null);
      if (json?.data?.mfa_required) {
        go(`/login/mfa${next ? `?next=${encodeURIComponent(safeNextPath(next))}` : ''}`);
        return;
      }
      go(safeNextPath(next));
    } catch {
      setError(t('err.network'));
    } finally {
      setBusy(false);
    }
  }

  const ready = adminMode ? Boolean(token) : Boolean(email && password);

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-[#1b2430] bg-[#0b1017] p-6">
        <h1 className="text-lg font-semibold text-white">Recepcionista</h1>
        <p className="mt-1 text-[13px] text-[#8b98ab]">
          {adminMode ? t('auth.login.subtitleAdmin') : t('auth.login.subtitleUser')}
        </p>

        {adminMode ? (
          <>
            <label htmlFor="token" className="mt-5 block text-[12px] text-[#8b98ab]">{t('auth.login.adminToken')}</label>
            <input
              id="token"
              type="password"
              autoComplete="off"
              autoFocus
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className={inputCls}
            />
          </>
        ) : (
          <>
            <label htmlFor="email" className="mt-5 block text-[12px] text-[#8b98ab]">{t('auth.login.email')}</label>
            <input
              id="email"
              type="email"
              autoComplete="username webauthn"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
            />
            <label htmlFor="password" className="mt-3 block text-[12px] text-[#8b98ab]">{t('auth.login.password')}</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputCls}
            />
          </>
        )}

        <p role="status" suppressHydrationWarning className="mt-2 text-[12px] text-[#8fe3b4]">{error ? '' : notice === 'reset' ? t('auth.login.resetDone') : notice}</p>
        {error && <p role="alert" className="mt-2 text-[12px] text-[#ff7b7b]">{error}</p>}
        <button
          type="submit"
          disabled={busy || !ready}
          className="mt-4 w-full rounded-lg bg-[#ff6b35] px-3 py-2 text-[14px] font-semibold text-[#150800] disabled:opacity-50"
        >
          {busy ? t('auth.login.signingIn') : t('auth.login.signIn')}
        </button>
        {!adminMode && <PasskeyLogin disabled={busy} />}
        <button
          type="button"
          onClick={() => { setAdminMode((v) => !v); setError(null); }}
          className="mt-3 w-full text-center text-[12px] text-[#6b7b91] hover:text-[#cbd7e6]"
        >
          {adminMode ? t('auth.login.useEmail') : t('auth.login.useAdmin')}
        </button>
        {!adminMode && (
          <p className="mt-4 flex justify-between text-[12px] text-[#8b98ab]">
            <a href="/forgot-password" className="hover:text-white">{t('auth.login.forgot')}</a>
            <a href="/signup" className="hover:text-white">{t('auth.login.create')}</a>
          </p>
        )}
        <div className="mt-5 flex justify-center border-t border-[#1b2430] pt-4"><LocaleSwitcher /></div>
      </form>
    </main>
  );
}
