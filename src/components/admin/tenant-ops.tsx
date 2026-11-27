'use client';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import { useAdmin } from './provider';
import { tenantPhrase, type TenantDetail } from './tenant-api';
import { ReasonAction } from './tenant-action';
import { formatWhen } from './ui';
import { Problems } from './tenant-errors';

interface PreviewItem { business_id?: string; outcome?: string; detail?: unknown; action?: string; reason?: string }

/** A dry-run preview, then the real run (with its own reason / phrase). `call(dry)` performs the request; the preview is shown as a short list. */
function ProviderAction({ title, hint, permission, previewLabel, runLabel, phrase, call, onDone }: {
  title: string; hint: string; permission: 'providers.repair' | 'providers.resync' | 'tenants.release'; previewLabel: string; runLabel: string; phrase: string | null;
  call: (dry: boolean, reason: string) => Promise<unknown>; onDone: () => void;
}) {
  const t = useT();
  const { can, guard } = useAdmin();
  const [preview, setPreview] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!can(permission)) return null;
  async function runPreview() {
    setBusy(true); setError(null);
    try { await guard(async () => { setPreview(await call(true, '')); }); } catch (err) { setError(err); setPreview(null); } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4 first:border-0 first:pt-0">
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        <p className="text-[13px] text-mute">{hint}</p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <Button variant="outline" onClick={() => void runPreview()} disabled={busy}>{busy ? t('common.loading') : previewLabel}</Button>
        {preview ? (
          <ReasonAction label={runLabel} variant="danger" phrase={phrase} run={(reason) => call(false, reason)} onDone={() => { setPreview(null); onDone(); }} description={t('at.ops.realRunHint')} />
        ) : null}
      </div>
      {error ? <Problems error={error} /> : null}
      {preview ? <PreviewBox value={preview} /> : null}
    </div>
  );
}

function PreviewBox({ value }: { value: unknown }) {
  const t = useT();
  const v = value as { items?: PreviewItem[]; decision?: PreviewItem; action?: string; reason?: string; tools?: string[] };
  const rows: PreviewItem[] = v.items ?? (v.decision ? [v.decision] : v.action ? [{ action: v.action, reason: v.reason }] : []);
  return (
    <div role="status" className="rounded-xl border border-sky-line bg-sky-bg/30 p-3 text-[13px]">
      <p className="font-medium text-sky-text">{t('at.ops.previewTitle')}</p>
      {rows.length === 0 ? <p className="mt-1 text-mute">{t('at.ops.previewEmpty')}</p> : (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-soft">
          {rows.map((r, i) => <li key={i} className="break-words font-mono text-xs">{[r.outcome ?? r.action, r.reason, typeof r.detail === 'string' ? r.detail : null].filter(Boolean).join(': ')}</li>)}
        </ul>
      )}
    </div>
  );
}

export function TenantOps({ d, reload }: { d: TenantDetail; reload: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { can } = useAdmin();
  const s = d.suspension;
  const post = (path: string, body: Record<string, unknown>) => apiRequest(`/api/admin/tenants/${d.id}/${path}`, { method: 'POST', body });
  const releasable = d.billing.status === 'canceled' || d.billing.status === 'unpaid';
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHead title={t('at.status.title')} subtitle={t('at.status.sub')} right={<Badge tone={s.suspended ? 'emergency' : 'routine'}>{s.suspended ? t('at.flag.suspended') : t('at.status.active')}</Badge>} />
        <div className="flex flex-col gap-4 p-5">
          {s.suspended ? (
            <p className="text-[13px] text-soft">{t('at.status.suspendedInfo', { when: formatWhen(s.suspended_at, locale), reason: s.reason ?? '' })}</p>
          ) : <p className="text-[13px] text-mute">{t('at.status.suspendHelp')}</p>}
          {can('tenants.suspend') ? (
            s.suspended
              ? <ReasonAction label={t('at.status.reactivate')} run={(reason) => post('reactivate', { reason })} onDone={reload} variant="primary" />
              : <ReasonAction label={t('at.status.suspend')} variant="danger" phrase={tenantPhrase(t('at.verb.suspend'), d.name)} description={t('at.status.suspendConfirm')} run={(reason) => post('suspend', { reason })} onDone={reload} />
          ) : <p className="text-[13px] text-mute">{t('at.noPermission')}</p>}
        </div>
      </Card>

      {can('tenants.billing') ? (
        <Card>
          <CardHead title={t('at.clean.title')} subtitle={t('at.clean.sub')} />
          <div className="flex flex-col gap-4 p-5">
            <div className="flex flex-col gap-2">
              <p className="text-[13px] text-soft">{d.contact.owner_phone_verified ? t('at.clean.phoneVerified') : t('at.clean.phoneNotVerified')}</p>
              <div><ReasonAction label={t('at.clean.clearPhone')} description={t('at.clean.clearPhoneHint')} disabled={!d.contact.owner_phone_verified} run={(reason) => post('actions', { action: 'clear_owner_phone_verification', reason })} onDone={reload} /></div>
            </div>
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <p className="text-[13px] text-soft">{t('at.clean.trialHint')}</p>
              <div><ReasonAction label={t('at.clean.clearTrial')} run={(reason) => post('actions', { action: 'clear_trial_fingerprint', reason })} onDone={reload} /></div>
            </div>
          </div>
        </Card>
      ) : null}

      {can('providers.repair') || can('providers.resync') || can('tenants.release') ? (
        <Card>
          <CardHead title={t('at.ops.title')} subtitle={t('at.ops.sub')} />
          <div className="flex flex-col gap-5 p-5">
            <ProviderAction
              title={t('at.ops.release')} hint={releasable ? t('at.ops.releaseHint') : t('at.ops.releaseNotApplicable')} permission="tenants.release" previewLabel={t('at.ops.preview')} runLabel={t('at.ops.releaseRun')}
              phrase={tenantPhrase(t('at.verb.release'), d.name)} onDone={reload}
              call={(dry, reason) => apiRequest('/api/admin/release-tenant', { method: 'POST', body: { business_id: d.id, dry_run: dry, ...(dry ? {} : { reason }) }, timeoutMs: 60_000 })}
            />
            <ProviderAction
              title={t('at.ops.repair')} hint={t('at.ops.repairHint')} permission="providers.repair" previewLabel={t('at.ops.preview')} runLabel={t('at.ops.repairRun')} phrase={null} onDone={reload}
              call={(dry) => apiRequest('/api/admin/repair-numbers', { method: 'POST', body: { business_ids: [d.id], dry_run: dry }, timeoutMs: 120_000 })}
            />
            <ProviderAction
              title={t('at.ops.resync')} hint={t('at.ops.resyncHint')} permission="providers.resync" previewLabel={t('at.ops.preview')} runLabel={t('at.ops.resyncRun')} phrase={null} onDone={reload}
              call={(dry) => apiRequest('/api/admin/resync-agents', { method: 'POST', body: { business_ids: [d.id], dry_run: dry }, timeoutMs: 120_000 })}
            />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
