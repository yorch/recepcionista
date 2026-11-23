'use client';
import { useState } from 'react';
import { safeNextPath } from '@/lib/safe-redirect';

export default function LoginPage() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setError(json?.error ?? 'Login failed');
        return;
      }
      const next = new URLSearchParams(window.location.search).get('next');
      const safe = safeNextPath(next);
      window.location.assign(safe);
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-[#1b2430] bg-[#0b1017] p-6">
        <h1 className="text-lg font-semibold text-white">Recepcionista</h1>
        <p className="mt-1 text-[13px] text-[#8b98ab]">Enter the admin token to continue.</p>
        <label htmlFor="token" className="mt-5 block text-[12px] text-[#8b98ab]">Admin token</label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[#1b2430] bg-[#080b10] px-3 py-2 text-[14px] text-white outline-none focus:border-[#ff6b35]"
        />
        {error && <p role="alert" className="mt-2 text-[12px] text-[#ff7b7b]">{error}</p>}
        <button
          type="submit"
          disabled={busy || !token}
          className="mt-4 w-full rounded-lg bg-[#ff6b35] px-3 py-2 text-[14px] font-semibold text-[#150800] disabled:opacity-50"
        >
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
