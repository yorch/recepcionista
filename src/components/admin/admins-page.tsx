'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { apiRequest } from '@/hooks/use-api';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { useAdmin } from './provider';
import type { AdminView } from './tenant-api';
import { ReasonAction } from './tenant-action';
import { useJson } from './use-json';
import { tenantErrorText } from './tenant-errors';
import { ErrorPanel, LoadingBlock } from './ui';
import { Problems } from './tenant-errors';

interface Listing { admins: AdminView[]; roles: string[] }

/** At least one enabled owner must remain: would disabling or demoting `a` leave none? (The server enforces it too: 409 `last_owner`.) Pure. */
export function isLastOwner(admins: readonly AdminView[], a: AdminView): boolean {
  return a.platform_role === 'owner' && !a.disabled && admins.filter((x) => x.platform_role === 'owner' && !x.disabled && x.id !== a.id).length === 0;
}

export function AdminsPage() {
  const t = useT();
  const { can } = useAdmin();
  const list = useJson<Listing>('/api/admin/admins');
  if (list.loading && !list.data) return <LoadingBlock />;
  if (list.error && !list.data) return <ErrorPanel error={list.error} onRetry={list.reload} />;
  if (!list.data) return null;
  const { admins, roles } = list.data;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={t('at.page.eyebrow')} title={t('at.admins.title')} subtitle={t('at.admins.sub')} />
      {can('admins.manage') || can('admins.recover') ? <InviteForm roles={roles} onDone={list.reload} /> : null}
      <Card>
        <CardHead title={t('at.admins.list')} subtitle={t('at.admins.count', { n: admins.length })} />
        <ul className="divide-y divide-line">
          {admins.map((a) => <AdminRow key={a.id} a={a} all={admins} roles={roles} reload={list.reload} />)}
        </ul>
      </Card>
    </div>
  );
}

function InviteForm({ roles, onDone }: { roles: string[]; onDone: () => void }) {
  const t = useT();
  const { guard, can } = useAdmin();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('ops');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await guard(async () => {
        const res = await apiRequest<{ email_sent: boolean }>('/api/admin/admins', { method: 'POST', body: { email: email.trim(), platform_role: role } });
        if (res.email_sent) toast.success(t('at.admins.invited')); else toast.warning(t('at.admins.inviteNoMail'));
      });
      setEmail(''); onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <Card>
      <CardHead title={t('at.admins.invite')} subtitle={t('at.admins.inviteHint')} />
      <form onSubmit={submit} className="grid gap-4 p-5 sm:grid-cols-[1fr_200px_auto] sm:items-end" aria-label={t('at.admins.invite')}>
        <TextField label={t('at.admins.email')} type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        <SelectField label={t('at.admins.role')} value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => <option key={r} value={r}>{t(`ac.role.${r}` as MessageKey)}</option>)}
        </SelectField>
        <Button type="submit" disabled={busy || !email.includes('@') || !can('admins.manage')}>{busy ? t('common.loading') : t('at.admins.send')}</Button>
        {error ? <div className="sm:col-span-3"><Problems error={error} /></div> : null}
      </form>
    </Card>
  );
}

function AdminRow({ a, all, roles, reload }: { a: AdminView; all: AdminView[]; roles: string[]; reload: () => void }) {
  const t = useT();
  const { can, me, guard } = useAdmin();
  const [role, setRole] = useState<string>(a.platform_role ?? 'read_only');
  const [error, setError] = useState<unknown>(null);
  const isSelf = me.email !== null && me.email.toLowerCase() === a.email.toLowerCase();
  const last = isLastOwner(all, a);
  const patch = (body: Record<string, unknown>) => apiRequest(`/api/admin/admins/${a.id}`, { method: 'PATCH', body });
  async function changeRole() {
    setError(null);
    try { await guard(async () => { await patch({ platform_role: role }); }); toast.success(t('at.action.done')); reload(); } catch (err) { setError(err); }
  }
  const noReason = async (fn: () => Promise<unknown>) => { setError(null); try { await guard(async () => { await fn(); }); toast.success(t('at.action.done')); reload(); } catch (err) { setError(err); } };
  return (
    <li className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium text-white">{a.email}{isSelf ? ` (${t('at.admins.you')})` : ''}</p>
          <p className="text-xs text-mute">{t('at.admins.sessions', { n: a.sessions })}</p>
        </div>
        <span className="flex flex-wrap gap-1">
          <Badge tone="brand">{t(`ac.role.${a.platform_role ?? 'read_only'}` as MessageKey)}</Badge>
          {a.disabled ? <Badge tone="emergency">{t('at.admins.disabled')}</Badge> : null}
          <Badge tone={a.two_factor ? 'routine' : 'unsure'}>{t(a.two_factor ? 'at.admins.twoFactorOn' : 'at.admins.twoFactorOff')}</Badge>
          {last ? <Badge tone="sky">{t('at.admins.lastOwner')}</Badge> : null}
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {can('admins.role') && !isSelf ? (
          <>
            <SelectField label={t('at.admins.changeRole')} value={role} onChange={(e) => setRole(e.target.value)} className="w-48" disabled={last}>
              {roles.map((r) => <option key={r} value={r}>{t(`ac.role.${r}` as MessageKey)}</option>)}
            </SelectField>
            <Button variant="outline" onClick={() => void changeRole()} disabled={role === (a.platform_role ?? 'read_only') || last}>{t('at.admins.applyRole')}</Button>
          </>
        ) : null}
        {can('admins.manage') && !isSelf && !a.disabled ? <Button variant="outline" disabled={last} onClick={() => void noReason(() => patch({ disabled: true }))}>{t('at.admins.disable')}</Button> : null}
        {can('admins.recover') && a.disabled ? <Button variant="outline" onClick={() => void noReason(() => patch({ disabled: false }))}>{t('at.admins.enable')}</Button> : null}
        {can('admins.recover') && a.sessions > 0 ? <Button variant="outline" onClick={() => void noReason(() => apiRequest(`/api/admin/admins/${a.id}/sessions`, { method: 'DELETE' }))}>{t('at.admins.revoke')}</Button> : null}
        {can('admins.manage') && a.two_factor ? (
          <ReasonAction label={t('at.admins.reset2fa')} description={t('at.admins.reset2faHint')} variant="danger" phrase={a.email.toLowerCase()} run={() => apiRequest(`/api/admin/admins/${a.id}/two-factor`, { method: 'DELETE' })} onDone={reload} />
        ) : null}
      </div>
      {last ? <p className="text-xs text-mute">{t('at.admins.lastOwnerHint')}</p> : null}
      {error ? <p role="alert" className="text-xs text-danger">{tenantErrorText(t, error)}</p> : null}
    </li>
  );
}
