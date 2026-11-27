'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Stat } from '@/components/ui/stat';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { ENV_ONLY } from '@/lib/config/registry';
import type { FreezeState, SettingView } from '@/lib/admin/settings-store';
import { useLabelOf } from './change-review';
import { useAdmin } from './provider';
import { useJson } from './use-json';
import { confirmReady, ConfirmFields, ErrorPanel, formatWhen, LoadingBlock, Problems } from './ui';

export interface SystemInfo {
  version: number;
  frozen: FreezeState;
  loader: { ok: boolean; loaded: boolean; version: number; canary: string; ignored_rows: number; needs_reencrypt: boolean; last_error: string | null; instance_id: string; loaded_at: string | null; error?: string; problems: { key: string; code: string; detail?: string }[] };
  keys: { current_kid: string; previous_kid: string | null } | null;
  reencrypt: { done: boolean } | null;
  instances: { instance_id: string; settings_version: number; build_sha: string | null; canary: string | null; ignored_rows: number; started_at: string; seen_at: string; current: boolean; alive: boolean }[];
  applied: { instances_alive: number; instances_current: number };
  env_locked_keys: number;
}

/** What the platform is running on: settings version applied per instance, key ids, canary, the keys the environment locks, and the incident freeze. */
export function SystemPage() {
  const t = useT();
  const locale = useLocale();
  const sys = useJson<SystemInfo>('/api/admin/system');
  const listing = useJson<{ settings: SettingView[] }>('/api/admin/settings');
  const labelOf = useLabelOf();
  const d = sys.data;
  const locked = (listing.data?.settings ?? []).filter((s) => s.locked);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('ac.page.system.title')} subtitle={t('ac.page.system.sub')} />
      {sys.loading && !d ? <LoadingBlock rows={3} /> : sys.error && !d ? <ErrorPanel error={sys.error} onRetry={sys.reload} /> : d ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t('ac.system.version')} value={String(d.version)} sub={t('ac.system.versionSub')} />
            <Stat label={t('ac.system.applied')} value={`${d.applied.instances_current}/${d.applied.instances_alive}`} sub={t('ac.system.appliedSub')} />
            <Stat label={t('ac.system.canary')} value={t(`ac.system.canary.${d.loader.canary}` as MessageKey)} sub={t('ac.system.canarySub')} tone={d.loader.canary === 'failed' ? 'warn' : undefined} />
            <Stat label={t('ac.system.envLocked')} value={String(d.env_locked_keys)} sub={t('ac.system.envLockedSub')} />
          </div>
          {d.applied.instances_current < d.applied.instances_alive ? <p role="status" className="rounded-xl border border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn">{t('ac.system.drift')}</p> : null}
          {!d.loader.ok ? <p role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13px] text-danger">{t('ac.system.unhealthy', { error: d.loader.error ?? '' })}</p> : null}

          <Card>
            <CardHead title={t('ac.system.keys')} subtitle={t('ac.system.keysSub')} />
            <dl className="grid gap-3 p-5 text-[13px] sm:grid-cols-2">
              <div><dt className="text-dim">{t('ac.system.kid')}</dt><dd className="mt-0.5 font-mono text-soft">{d.keys?.current_kid ?? t('ac.system.noKey')}</dd></div>
              <div><dt className="text-dim">{t('ac.system.kidPrev')}</dt><dd className="mt-0.5 font-mono text-soft">{d.keys?.previous_kid ?? t('ac.diff.unset')}</dd></div>
              <div><dt className="text-dim">{t('ac.system.reencrypt')}</dt><dd className="mt-0.5 text-soft">{d.reencrypt ? (d.reencrypt.done ? t('ac.system.reencryptDone') : t('ac.system.reencryptPending')) : t('ac.diff.unset')}</dd></div>
              <div><dt className="text-dim">{t('ac.system.ignored')}</dt><dd className="mt-0.5 text-soft">{d.loader.ignored_rows}</dd></div>
            </dl>
            {d.loader.problems.length ? (
              <ul className="border-t border-line px-5 py-3 text-[12px] text-warn">{d.loader.problems.map((p, i) => <li key={`${p.key}-${i}`}><code className="font-mono">{p.key}</code>: {p.code}</li>)}</ul>
            ) : null}
          </Card>

          <FreezeCard freeze={d.frozen} onChanged={sys.reload} />

          <Card>
            <CardHead title={t('ac.system.instances')} subtitle={t('ac.system.instancesSub')} />
            {d.instances.length === 0 ? <p className="p-5 text-[13px] text-mute">{t('ac.system.noInstances')}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-left text-[12.5px]">
                  <caption className="sr-only">{t('ac.system.instances')}</caption>
                  <thead className="text-dim"><tr>
                    <th scope="col" className="px-5 py-2 font-medium">{t('ac.system.colInstance')}</th><th scope="col" className="px-3 py-2 font-medium">{t('ac.system.colBuild')}</th>
                    <th scope="col" className="px-3 py-2 font-medium">{t('ac.system.colVersion')}</th><th scope="col" className="px-3 py-2 font-medium">{t('ac.system.colSeen')}</th><th scope="col" className="px-3 py-2 font-medium">{t('ac.system.colState')}</th>
                  </tr></thead>
                  <tbody className="divide-y divide-line">
                    {d.instances.map((i) => (
                      <tr key={i.instance_id} className={i.instance_id === d.loader.instance_id ? 'bg-raised/40' : undefined}>
                        <td className="px-5 py-2 font-mono text-soft">{i.instance_id.slice(0, 8)}{i.instance_id === d.loader.instance_id ? ` (${t('ac.system.thisOne')})` : ''}</td>
                        <td className="px-3 py-2 font-mono text-mute">{i.build_sha ? i.build_sha.slice(0, 10) : t('ac.diff.unset')}</td>
                        <td className="px-3 py-2 text-soft">{i.settings_version}</td>
                        <td className="px-3 py-2 text-mute">{formatWhen(i.seen_at, locale)}</td>
                        <td className="px-3 py-2">{!i.alive ? <Badge>{t('ac.system.stopped')}</Badge> : i.current ? <Badge tone="routine">{t('ac.system.current')}</Badge> : <Badge tone="unsure">{t('ac.system.behind')}</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}

      <Card>
        <CardHead title={t('ac.system.lockedKeys')} subtitle={t('ac.system.lockedKeysSub')} />
        {listing.loading && !listing.data ? <div className="p-5"><LoadingBlock rows={2} /></div> : listing.error && !listing.data ? <div className="p-5"><ErrorPanel error={listing.error} onRetry={listing.reload} /></div> : locked.length === 0 ? (
          <p className="p-5 text-[13px] text-mute">{t('ac.system.lockedNone')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-[12.5px]">
              <caption className="sr-only">{t('ac.system.lockedKeys')}</caption>
              <thead className="text-dim"><tr><th scope="col" className="px-5 py-2 font-medium">{t('ac.system.colSetting')}</th><th scope="col" className="px-3 py-2 font-medium">{t('ac.system.colVariable')}</th><th scope="col" className="px-3 py-2 font-medium">{t('ac.system.colWhy')}</th></tr></thead>
              <tbody className="divide-y divide-line">
                {locked.map((s) => (
                  <tr key={s.key}>
                    <td className="px-5 py-2"><span className="text-soft">{labelOf(s.key)}</span> <code className="font-mono text-[11px] text-dim">{s.key}</code></td>
                    <td className="px-3 py-2 font-mono text-mute">{s.env ?? t('ac.diff.unset')}</td>
                    <td className="px-3 py-2 text-mute">{s.locked_reason === 'env_only' ? t('ac.system.whyEnvOnly') : t('ac.system.whyPinned')}{s.env_invalid ? ` ${t('ac.system.whyInvalid')}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <details className="border-t border-line px-5 py-3">
          <summary className="min-h-11 cursor-pointer py-2 text-[13px] text-soft">{t('ac.system.envOnly', { n: ENV_ONLY.length })}</summary>
          <p className="mb-2 text-xs text-dim">{t('ac.system.envOnlySub')}</p>
          <ul className="grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
            {ENV_ONLY.map((e) => <li key={e.name} className="flex flex-wrap items-baseline gap-2"><code className="font-mono text-soft">{e.name}</code><span className="text-dim">{t(`ac.envOnly.${e.reason}` as MessageKey)}</span></li>)}
          </ul>
        </details>
      </Card>
    </div>
  );
}

/** The incident switch: while frozen every console write is refused. Freezing is cheap (any settings writer); unfreezing is the owner's. */
function FreezeCard({ freeze, onChanged }: { freeze: FreezeState; onChanged: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { can, guard, setFrozen } = useAdmin();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const target = !freeze.frozen;
  const allowed = target ? can('settings.freeze') : can('settings.unfreeze') && !freeze.by_env;

  async function run() {
    setBusy(true); setError(null);
    try {
      let done = false;
      await guard(async () => { await apiRequest('/api/admin/settings/freeze', { body: { frozen: target, reason: reason.trim() } }); done = true; });
      if (done) { toast.success(t(target ? 'ac.freeze.frozenDone' : 'ac.freeze.unfrozenDone')); setFrozen(target); setOpen(false); setReason(''); onChanged(); }
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHead title={t('ac.freeze.title')} subtitle={t('ac.freeze.sub')} right={<Badge tone={freeze.frozen ? 'emergency' : 'routine'}>{freeze.frozen ? t('ac.freeze.on') : t('ac.freeze.off')}</Badge>} />
      <div className="flex flex-col gap-3 p-5 text-[13px] text-soft">
        {freeze.frozen ? <p>{freeze.by_env ? t('ac.freeze.byEnv') : t('ac.freeze.since', { when: formatWhen(freeze.frozen_at, locale), reason: freeze.reason ?? '' })}</p> : <p className="text-mute">{t('ac.freeze.hint')}</p>}
        {!allowed ? <p className="text-xs text-dim">{freeze.by_env ? t('ac.freeze.cannotEnv') : t('ac.block.noPermission')}</p> : open ? (
          <div className="flex flex-col gap-3">
            <ConfirmFields reasonRequired phrase={null} reason={reason} onReason={setReason} typed="" onTyped={() => undefined} />
            {error ? <Problems error={error} /> : null}
            <div className="flex gap-2">
              <Button variant={target ? 'danger' : 'primary'} disabled={busy || !confirmReady({ reasonRequired: true, reason, phrase: null, typed: '' })} onClick={() => void run()}>{target ? t('ac.freeze.doFreeze') : t('ac.freeze.doUnfreeze')}</Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            </div>
          </div>
        ) : <div><Button variant={target ? 'danger' : 'outline'} onClick={() => setOpen(true)}>{target ? t('ac.freeze.doFreeze') : t('ac.freeze.doUnfreeze')}</Button></div>}
      </div>
    </Card>
  );
}
