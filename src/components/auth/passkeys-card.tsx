'use client';
import { useCallback, useId, useState } from 'react';
import { utcStamp } from '@/components/dashboard/dates';
import { useReauth } from '@/components/dashboard/reauth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import { apiErrorMessage } from '@/lib/i18n/api-errors';
import { passkeyErrorMessage, registerPasskey, useWebAuthnSupport } from '@/lib/passkey-client';
import { inputCls } from './auth-ui';

export interface PasskeyView {
  id: string; name: string; created_at: string; last_used_at: string | null; device_type: 'singleDevice' | 'multiDevice'; backed_up: boolean;
}

const MAX = 20;

/**
 * Passkeys of the signed-in account: add, rename, remove. Adding and removing need a recent proof of identity (the shared re-authentication
 * panel appears when the server asks; a passkey can answer it). The password keeps working whatever happens here, so removing the last
 * passkey can never lock the account out.
 */
export function PasskeysCard({ initial }: { initial: PasskeyView[] }) {
  const t = useT();
  const locale = useLocale();
  const [list, setList] = useState(initial);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const supported = useWebAuthnSupport();
  const nameId = useId();
  const showError = useCallback((err: unknown) => setError(err instanceof ApiError ? apiErrorMessage(t, err.message) : passkeyErrorMessage(err, t)), [t]);
  const { guard, panel } = useReauth(showError);

  const reload = useCallback(async () => {
    const r = await apiRequest<{ passkeys: PasskeyView[] }>('/api/auth/passkeys');
    setList(r.passkeys);
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy('add'); setError(null); setNotice(null);
    try {
      await guard(async () => {
        const p = await registerPasskey(name.trim() || t('pk.defaultName'));
        await reload();
        setName('');
        setNotice(t('pk.added', { name: p.name }));
      });
    } catch (err) {
      showError(err);
    } finally {
      setBusy(null);
    }
  }

  async function rename(id: string, value: string) {
    setBusy(id); setError(null); setNotice(null);
    try {
      await apiRequest(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name: value } });
      setList((l) => l.map((p) => (p.id === id ? { ...p, name: value.trim() } : p)));
      setEditing(null);
      setNotice(t('pk.renamed'));
    } catch (err) {
      showError(err);
    } finally {
      setBusy(null);
    }
  }

  async function remove(p: PasskeyView) {
    if (!window.confirm(t('pk.confirmRemove', { name: p.name }))) return;
    setBusy(p.id); setError(null); setNotice(null);
    try {
      await guard(async () => {
        await apiRequest(`/api/auth/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
        setList((l) => l.filter((x) => x.id !== p.id));
        setNotice(t('pk.removed', { name: p.name }));
      });
    } catch (err) {
      showError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mt-6" aria-labelledby="passkeys-heading">
      <CardHead
        title={t('pk.title')}
        subtitle={t('pk.subtitle')}
        right={<Badge tone={list.length > 0 ? 'routine' : 'neutral'}>{list.length > 0 ? t('pk.count', { count: list.length }) : t('common.none')}</Badge>}
      />
      <div className="p-5">
        <ul className="divide-y divide-[#1f2937]" aria-label={t('pk.listLabel')}>
          {list.length === 0 ? <li className="py-2 text-[13px] text-[#8b98ab]">{t('pk.none')}</li> : null}
          {list.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0 text-[13px]">
                {editing?.id === p.id ? (
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(e) => { e.preventDefault(); if (editing.value.trim()) void rename(p.id, editing.value); }}
                  >
                    <label className="sr-only" htmlFor={`rename-${p.id}`}>{t('pk.newNameFor', { name: p.name })}</label>
                    <input
                      id={`rename-${p.id}`} className={`${inputCls} !mt-0 max-w-[16rem]`} maxLength={80} autoFocus value={editing.value}
                      onChange={(e) => setEditing({ id: p.id, value: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
                    />
                    <Button type="submit" disabled={busy === p.id || !editing.value.trim()}>{t('common.save')}</Button>
                    <Button type="button" variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
                  </form>
                ) : (
                  <>
                    <p className="truncate text-white">{p.name} {p.device_type === 'multiDevice' ? <Badge tone="neutral" className="ml-1">{p.backed_up ? t('pk.synced') : t('pk.multiDevice')}</Badge> : null}</p>
                    <p className="text-[12px] text-[#8b98ab]">{t('pk.added.line', { created: utcStamp(p.created_at, locale) })} · {p.last_used_at ? t('pk.lastUsed', { at: utcStamp(p.last_used_at, locale) }) : t('pk.neverUsed')}</p>
                  </>
                )}
              </div>
              {editing?.id === p.id ? null : (
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" aria-label={t('pk.renameLabel', { name: p.name })} onClick={() => setEditing({ id: p.id, value: p.name })}>{t('pk.rename')}</Button>
                  <Button type="button" variant="danger" aria-label={t('pk.removeLabel', { name: p.name })} disabled={busy === p.id} onClick={() => void remove(p)}>{t('common.remove')}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {supported === false ? (
          <p className="mt-3 text-[13px] text-[#a8b6c8]">{t('pk.unsupported')}</p>
        ) : list.length >= MAX ? (
          <p className="mt-3 text-[13px] text-[#a8b6c8]">{t('pk.limit', { max: MAX })}</p>
        ) : (
          <form onSubmit={add} className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-56">
              <label htmlFor={nameId} className="block text-[13px] text-[#a8b6c8]">{t('pk.nameOptional')}</label>
              <input id={nameId} className={inputCls} maxLength={80} placeholder={t('pk.namePlaceholder')} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Button type="submit" disabled={busy === 'add' || supported === null}>{busy === 'add' ? t('pk.waiting') : t('pk.add')}</Button>
          </form>
        )}
        {panel}
        <div aria-live="polite">
          {error ? <p role="alert" className="mt-3 rounded-lg bg-[#3a1512] px-3 py-2 text-[13px] text-[#ff9b86]">{error}</p> : null}
          {notice ? <p role="status" className="mt-3 rounded-lg bg-[#10261c] px-3 py-2 text-[13px] text-[#8fe3b4]">{notice}</p> : null}
        </div>
      </div>
    </Card>
  );
}
