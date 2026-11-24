'use client';
import { utcDate } from '@/components/dashboard/dates';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { inputCls, friendly, sendJson } from './auth-ui';

export interface MemberView { id: string; email: string; role: 'owner' | 'staff'; disabled: boolean; verified: boolean; totp: boolean; isSelf: boolean }
export interface InviteView { id: string; email: string; role: 'owner' | 'staff'; expires_at: string; invited_by_email: string | null }

export function TeamPanel({ businessId, isAdmin, canInvite, members, invites }: {
  businessId: string; isAdmin: boolean; canInvite: boolean; members: MemberView[]; invites: InviteView[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'staff'>('staff');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Owners are pinned server-side; admins must name the business.
  const q = isAdmin ? `?business_id=${encodeURIComponent(businessId)}` : '';

  async function act(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) {
    setBusy(key); setError(null); setNotice(null);
    const r = await fn();
    setBusy(null);
    if (!r.ok) { setError(friendly(r.error)); return; }
    if (done) setNotice(done);
    router.refresh();
  }

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    void act('invite', () => sendJson('/api/team/invite', { email, role, ...(isAdmin ? { business_id: businessId } : {}) }), `Invitation sent to ${email}.`)
      .then(() => setEmail(''));
  };

  return (
    <>
      {error ? <p role="alert" className="mt-4 rounded-lg bg-[#3a1512] px-3 py-2 text-[13px] text-[#ff9b86]">{error}</p> : null}
      {notice ? <p role="status" className="mt-4 rounded-lg bg-[#10261c] px-3 py-2 text-[13px] text-[#8fe3b4]">{notice}</p> : null}

      <Card className="mt-6">
        <CardHead title="Invite a teammate" subtitle="They get an email link, valid for 7 days, to choose a password." />
        {canInvite ? (
          <form onSubmit={invite} className="flex flex-wrap items-end gap-3 p-5">
            <label className="min-w-0 flex-1 basis-56 text-[13px] text-[#a8b6c8]">
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} autoComplete="off" />
            </label>
            <label className="text-[13px] text-[#a8b6c8]">
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'staff')} className={inputCls}>
                <option value="staff">Staff (read-mostly)</option>
                <option value="owner">Owner (full access)</option>
              </select>
            </label>
            <Button type="submit" disabled={busy === 'invite' || !email}>{busy === 'invite' ? 'Sending...' : 'Send invitation'}</Button>
          </form>
        ) : (
          <p className="p-5 text-[13px] text-[#a8b6c8]">Confirm your own email address first (Security page) to invite people.</p>
        )}
      </Card>

      <Card className="mt-6">
        <CardHead title="Team" subtitle={`${members.length} member${members.length === 1 ? '' : 's'}`} />
        <ul className="divide-y divide-[#1f2937]">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0 text-[13px]">
                <p className="truncate text-white">
                  {m.email} {m.isSelf ? <span className="text-[#8b98ab]">(you)</span> : null}
                </p>
                <p className="mt-1 flex flex-wrap gap-1.5">
                  <Badge tone={m.role === 'owner' ? 'brand' : 'neutral'}>{m.role}</Badge>
                  {m.disabled ? <Badge tone="emergency">disabled</Badge> : null}
                  {!m.verified ? <Badge tone="unsure">email not confirmed</Badge> : null}
                  {m.totp ? <Badge tone="routine">2FA</Badge> : null}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button" variant="outline" disabled={busy === `role-${m.id}`}
                  onClick={() => act(`role-${m.id}`, () => sendJson(`/api/team/users/${m.id}${q}`, { role: m.role === 'owner' ? 'staff' : 'owner' }, 'PATCH'))}
                >{m.role === 'owner' ? 'Make staff' : 'Make owner'}</Button>
                {!m.isSelf ? (
                  <>
                    <Button
                      type="button" variant="outline" disabled={busy === `dis-${m.id}`}
                      onClick={() => act(`dis-${m.id}`, () => sendJson(`/api/team/users/${m.id}${q}`, { disabled: !m.disabled }, 'PATCH'))}
                    >{m.disabled ? 'Enable' : 'Disable'}</Button>
                    <Button
                      type="button" variant="ghost" disabled={busy === `rev-${m.id}`}
                      onClick={() => act(`rev-${m.id}`, () => sendJson(`/api/team/users/${m.id}/revoke-sessions${q}`, {}), 'Signed out everywhere.')}
                    >Sign out everywhere</Button>
                    <Button
                      type="button" variant="danger" disabled={busy === `del-${m.id}`}
                      onClick={() => { if (window.confirm(`Remove ${m.email} from the team?`)) void act(`del-${m.id}`, () => sendJson(`/api/team/users/${m.id}${q}`, undefined, 'DELETE')); }}
                    >Remove</Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-6">
        <CardHead title="Pending invitations" subtitle={invites.length ? undefined : 'None'} />
        {invites.length ? (
          <ul className="divide-y divide-[#1f2937]">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0 text-[13px]">
                  <p className="truncate text-white">{i.email} <Badge tone="neutral">{i.role}</Badge></p>
                  <p className="text-[12px] text-[#8b98ab]">Expires {utcDate(i.expires_at)}{i.invited_by_email ? ` · invited by ${i.invited_by_email}` : ''}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button" variant="outline" disabled={busy === `re-${i.id}` || !canInvite}
                    onClick={() => act(`re-${i.id}`, () => sendJson(`/api/team/invites/${i.id}/resend${q}`, {}), `Invitation re-sent to ${i.email}.`)}
                  >Resend</Button>
                  <Button
                    type="button" variant="danger" disabled={busy === `rv-${i.id}`}
                    onClick={() => act(`rv-${i.id}`, () => sendJson(`/api/team/invites/${i.id}${q}`, undefined, 'DELETE'))}
                  >Revoke</Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </>
  );
}
