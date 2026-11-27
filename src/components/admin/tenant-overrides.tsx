'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { useT } from '@/lib/i18n/client';
import { settingText } from '@/lib/admin-ui/setting-text';
import { useAdmin } from './provider';
import type { TenantKnob } from './tenant-api';
import { Problems } from './tenant-errors';

const show = (v: unknown, t: (k: 'at.on' | 'at.off' | 'at.none') => string): string => (v === null || v === undefined ? t('at.none') : typeof v === 'boolean' ? t(v ? 'at.on' : 'at.off') : String(v));

/** The boundaries the server enforces for a numeric knob, as a short phrase. */
export function boundsText(k: Pick<TenantKnob, 'bounds' | 'rule'>, t: ReturnType<typeof useT>): string {
  const b = k.bounds;
  const range = b && (b.min !== null || b.max !== null) ? t('at.ovr.bounds', { min: b.min ?? '-', max: b.max ?? '-' }) : '';
  return [range, k.rule === 'stricter_than_platform' ? t('at.ovr.stricter') : ''].filter(Boolean).join(' ');
}

function Knob({ k, businessId, locale, writable, onChanged }: { k: TenantKnob; businessId: string; locale: string; writable: boolean; onChanged: () => void }) {
  const t = useT();
  const { guard } = useAdmin();
  const txt = settingText({ key: k.key as never, label: k.label, help: k.help }, locale === 'es' ? 'es' : 'en');
  const [draft, setDraft] = useState<string>(k.override === null || k.override === undefined ? '' : String(k.override));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const isBool = k.kind === 'bool';
  const parsed: unknown = isBool ? (draft === '' ? undefined : draft === 'true') : draft.trim() === '' ? undefined : Number(draft);
  const invalid = !isBool && parsed !== undefined && !Number.isFinite(parsed as number);

  async function call(method: 'PUT' | 'DELETE') {
    setBusy(true); setError(null);
    try {
      await guard(async () => {
        await apiRequest('/api/admin/tenant-overrides', { method, body: { business_id: businessId, key: k.key, ...(method === 'PUT' ? { value: parsed } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) } });
      });
      toast.success(t('at.action.done'));
      onChanged();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  const inputId = `ovr-${k.key}`;
  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-white">{txt.label}</p>
          <p className="text-xs text-mute">{txt.help}</p>
        </div>
        <span className="flex flex-wrap gap-1">
          <Badge tone={k.source === 'tenant' ? 'sky' : 'neutral'}>{t(k.source === 'tenant' ? 'at.ovr.tenant' : 'at.ovr.platform')}</Badge>
          {k.editable_by === 'owner' ? <Badge tone="routine">{t('at.ovr.ownerEditable')}</Badge> : null}
          {k.locked_by_env ? <Badge tone="unsure">{t('ac.src.lockedEnv')}</Badge> : null}
          {k.ignored_override ? <Badge tone="emergency">{t('at.ovr.ignored')}</Badge> : null}
        </span>
      </div>
      <p className="mt-2 text-[13px] text-soft">{t('at.ovr.values', { platform: show(k.platform_value, t), effective: show(k.effective, t) })} {boundsText(k, t)}</p>
      {writable && !k.locked_by_env ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {isBool ? (
              <div>
                <label htmlFor={inputId} className="block text-xs font-medium uppercase tracking-wider text-dim">{t('at.ovr.override')}</label>
                <select id={inputId} value={draft} onChange={(e) => setDraft(e.target.value)} className="mt-1.5 min-h-11 w-full rounded-xl border border-line-2 bg-sunken px-3 py-2 text-[15px] text-white sm:text-sm">
                  <option value="">{t('at.ovr.usePlatform')}</option>
                  <option value="true">{t('at.on')}</option>
                  <option value="false">{t('at.off')}</option>
                </select>
              </div>
            ) : (
              <TextField id={inputId} label={t('at.ovr.override')} inputMode="numeric" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('at.ovr.usePlatform')} error={invalid ? t('at.billing.capInvalid') : null} />
            )}
            <TextField label={t('at.ovr.reason')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} optional />
          </div>
          {error ? <Problems error={error} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void call('PUT')} disabled={busy || parsed === undefined || invalid}>{t('at.ovr.save')}</Button>
            {k.override !== null && k.override !== undefined ? <Button variant="outline" onClick={() => void call('DELETE')} disabled={busy}>{t('at.ovr.reset')}</Button> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** The platform-side editor of a tenant's per-business settings (caps, budgets, comfort knobs) with the platform bounds next to each. */
export function TenantOverrides({ knobs, businessId, locale, reload, grantOpen }: { knobs: TenantKnob[]; businessId: string; locale: string; reload: () => void; grantOpen: boolean }) {
  const t = useT();
  const { can, me } = useAdmin();
  const writable = can('tenants.overrides.write') || (me.role === 'support' && grantOpen);
  return (
    <Card>
      <CardHead title={t('at.ovr.title')} subtitle={t('at.ovr.sub')} />
      <div className="flex flex-col gap-4 p-5">
        {!writable ? <p role="note" className="text-[13px] text-mute">{me.role === 'support' ? t('at.ovr.needsWrite') : t('at.noPermission')}</p> : null}
        {knobs.length === 0 ? <p className="text-[13px] text-mute">{t('at.ovr.none')}</p> : <ul className="flex flex-col gap-3">{knobs.map((k) => <Knob key={k.key} k={k} businessId={businessId} locale={locale} writable={writable} onChanged={reload} />)}</ul>}
      </div>
    </Card>
  );
}
