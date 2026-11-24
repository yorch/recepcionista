'use client';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { go } from '@/components/auth/auth-ui';
import { ApiError, apiRequest } from '@/hooks/use-api';

export interface SwitcherMembership { business_id: string; business_name: string; role: 'owner' | 'staff' }

const selectCls = 'min-h-11 w-full rounded-lg border border-[#1b2430] bg-sunken px-2 py-1 text-[13px] text-soft lg:min-h-9';

/**
 * Business switcher for accounts that belong to several businesses (and the "Add another location" entry for owners). Switching is a
 * server call (POST /api/auth/switch-business: the membership is checked there, the role comes from it); the page then re-renders for the
 * new business. Admins use their own switcher in the shell.
 */
export function BusinessSwitcher({ memberships, currentBusinessId, canAddBusiness }: {
  memberships: SwitcherMembership[]; currentBusinessId: string; canAddBusiness: boolean;
}) {
  const router = useRouter();
  const selectId = useId();
  const nameId = useId();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function switchTo(id: string) {
    if (id === currentBusinessId) return;
    setBusy(true); setError(null);
    try {
      await apiRequest('/api/auth/switch-business', { method: 'POST', body: { business_id: id } });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not switch business.');
    } finally {
      setBusy(false);
    }
  }

  async function addLocation(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await apiRequest('/api/businesses/mine', { method: 'POST', body: { name } });
      go('/onboarding'); // full navigation: the new business is now the session's active one
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 403 && (err.payload as { code?: string } | undefined)?.code === 'email_not_verified' ? 'Confirm your email address first.' : err.message) : 'Could not add the location.');
      setBusy(false);
    }
  }

  if (memberships.length < 2 && !canAddBusiness) return null;
  return (
    <div className="mb-2">
      {memberships.length >= 2 ? (
        <>
          <label htmlFor={selectId} className="sr-only">Switch business</label>
          <select id={selectId} value={currentBusinessId} disabled={busy} onChange={(e) => void switchTo(e.target.value)} className={selectCls}>
            {memberships.map((m) => (
              <option key={m.business_id} value={m.business_id}>{m.business_name} ({m.role})</option>
            ))}
          </select>
        </>
      ) : null}
      {canAddBusiness ? (
        adding ? (
          <form onSubmit={addLocation} className="mt-2">
            <label htmlFor={nameId} className="block text-xs text-mute">Name of the new location</label>
            <input
              id={nameId} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} autoFocus autoComplete="off"
              className="mt-1 min-h-11 w-full rounded-lg border border-[#1b2430] bg-sunken px-2 py-1 text-[13px] text-soft lg:min-h-9"
              onKeyDown={(e) => { if (e.key === 'Escape') { setAdding(false); setError(null); } }}
            />
            <div className="mt-2 flex gap-2">
              <button type="submit" disabled={busy || name.trim().length < 2} className="min-h-11 flex-1 rounded-lg bg-brand px-2 text-[13px] font-semibold text-on-brand disabled:opacity-50 lg:min-h-9">
                {busy ? 'Adding...' : 'Add location'}
              </button>
              <button type="button" onClick={() => { setAdding(false); setError(null); }} className="min-h-11 rounded-lg px-2 text-[13px] text-mute hover:text-soft lg:min-h-9">Cancel</button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="mt-1 min-h-11 w-full rounded-lg px-2 text-left text-xs text-brand-soft hover:underline lg:min-h-9">
            + Add another location
          </button>
        )
      ) : null}
      {error ? <p role="alert" className="mt-1 text-xs text-[#ff9b86]">{error}</p> : null}
    </div>
  );
}
