'use client';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import type { FollowUpAction, FollowUpState } from '@/lib/admin/provider-meta';
import { estimatePercent, labelKeyOf, runBatches, type BatchOutcome, type BatchProgress } from '@/lib/admin/provider-ui';
import { adminErrorText } from './errors';
import { useAdmin } from './provider';
import { batchCall } from './provider-api';

const PERMISSION = { resync_agents: 'providers.resync', repair_numbers: 'providers.repair' } as const;
const BATCH = 25;

/** The banner of a follow-up that is still pending (a key that needs it changed after the last complete run). */
export function FollowUpBanner({ state, total, onFinished }: { state: FollowUpState; total: number | null; onFinished: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Card data-followup={state.action} role="region" aria-label={t(`ap.fu.banner.${state.action}` as MessageKey)} className="border-warn-line bg-warn-bg/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-warn">{t(`ap.fu.banner.${state.action}` as MessageKey)}</p>
          <p className="mt-0.5 text-[13px] text-soft">{t(`ap.fu.body.${state.action}` as MessageKey, { keys: state.keys.map((k) => t(labelKeyOf(k) as MessageKey)).join(', ') })}</p>
        </div>
        {!open ? <Button variant="outline" onClick={() => setOpen(true)}>{t('ap.fu.open')}</Button> : null}
      </div>
      {open ? <FollowUpRunner action={state.action} total={total} onClose={() => { setOpen(false); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-followup="${state.action}"] button`)?.focus()); }} onFinished={onFinished} /> : null}
    </Card>
  );
}

type Phase = 'idle' | 'dry' | 'dry_done' | 'apply' | 'done';

/**
 * Walks the batches of the server route (`next_cursor`) with progress. A dry run always comes first (it reads and writes nothing at the provider); "Apply to all" is only
 * offered after it. The real run is a state-changing request: a step-up (reauth panel) is asked on the first batch and the loop continues after the proof.
 */
export function FollowUpRunner({ action, total, onClose, onFinished }: { action: FollowUpAction; total: number | null; onClose: () => void; onFinished: () => void }) {
  const t = useT();
  const { can, guard, me } = useAdmin();
  const allowed = can(PERMISSION[action]) && !me.frozen;
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [outcome, setOutcome] = useState<BatchOutcome | null>(null);
  const [refresh, setRefresh] = useState(false);
  const stop = useRef(false);
  const [tools, setTools] = useState<number | null>(null);

  async function run(dry: boolean) {
    const call = async (cursor: string | null) => {
      const r = await batchCall(action, { dry_run: dry, limit: BATCH, ...(cursor ? { cursor } : {}), ...(action === 'repair_numbers' && refresh && !dry ? { refresh_credentials: true } : {}) });
      if (r.tools) setTools(r.tools.length);
      return r;
    };
    // The whole walk is one action: a real run asks for the step-up on its first batch (`guard` opens the reauth panel and runs the SAME action once more after the proof).
    const exec = async () => {
      stop.current = false; setProgress(null); setOutcome(null);
      setPhase(dry ? 'dry' : 'apply');
      const res = await runBatches(call, { shouldStop: () => stop.current, onProgress: setProgress });
      if (res.error && isReauth(res.error)) { setPhase('idle'); throw res.error; }
      setOutcome(res); setProgress(res);
      setPhase(res.error ? 'idle' : dry ? 'dry_done' : 'done');
      if (!dry && !res.error) onFinished();
    };
    if (dry) await exec(); else await guard(exec);
  }

  const pct = progress ? estimatePercent(progress.processed, total, outcome?.completed ?? false) : null;
  const busy = phase === 'dry' || phase === 'apply';
  const counts = progress ? Object.entries(progress.counts) : [];
  const doneDry = phase === 'dry_done' && outcome?.completed;

  return (
    <div className="mt-4 rounded-xl border border-line-3 bg-sunken p-4" role="group" aria-label={t(`ap.fu.title.${action}` as MessageKey)}>
      <h4 className="text-sm font-semibold text-white">{t(`ap.fu.title.${action}` as MessageKey)}</h4>
      <p className="mt-1 text-[13px] text-soft">{t('ap.fu.intro')}</p>
      {!allowed ? <p className="mt-2 text-xs text-dim">{t('ap.fu.noRole')}</p> : null}
      {action === 'repair_numbers' ? (
        <label className="mt-3 flex items-start gap-2 text-[13px] text-soft">
          <input type="checkbox" className="mt-1 size-4" checked={refresh} disabled={busy} onChange={(e) => setRefresh(e.target.checked)} />
          <span>{t('ap.fu.refreshCredentials')}</span>
        </label>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={!allowed || busy} onClick={() => void run(true)}>{t('ap.fu.dryRun')}</Button>
        <Button disabled={!allowed || busy || !doneDry || (progress?.processed ?? 0) === 0} onClick={() => void run(false)}>{t('ap.fu.apply')}</Button>
        {busy ? <Button variant="ghost" onClick={() => { stop.current = true; }}>{t('ap.fu.stop')}</Button> : null}
        <Button variant="ghost" onClick={onClose}>{t('ap.fu.close')}</Button>
      </div>

      {busy || progress ? (
        <div className="mt-4" aria-live="polite">
          <p className="text-xs text-dim">{busy ? t(phase === 'dry' ? 'ap.fu.running.dry' : 'ap.fu.running.apply') : null}</p>
          <div
            role="progressbar" aria-label={t('ap.fu.progressLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}
            aria-valuetext={progress ? (total ? t('ap.fu.progressOf', { n: progress.processed, total }) : t('ap.fu.progress', { n: progress.processed })) : undefined}
            className="mt-1 h-2 w-full overflow-hidden rounded-full bg-raised"
          >
            <div className={`h-full bg-brand transition-all ${pct === null && busy ? 'w-1/3 animate-pulse' : ''}`} style={pct !== null ? { width: `${pct}%` } : undefined} />
          </div>
          {progress ? <p className="mt-1 text-xs text-soft">{total ? t('ap.fu.progressOf', { n: progress.processed, total }) : t('ap.fu.progress', { n: progress.processed })}</p> : null}
          {tools !== null && action === 'resync_agents' ? <p className="text-xs text-dim">{t('ap.fu.tools', { n: tools })}</p> : null}
          {counts.length ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {counts.map(([k, n]) => <li key={k}><Badge tone={k === 'failed' ? 'emergency' : 'neutral'}>{`${t(`ap.fu.outcome.${known(k) ? k : 'other'}` as MessageKey)}: ${n}`}</Badge></li>)}
            </ul>
          ) : null}
        </div>
      ) : null}

      {outcome ? (
        <div className="mt-3 text-[13px]" role="status">
          {outcome.error ? <p role="alert" className="text-danger">{t('ap.fu.error', { message: adminErrorText(t, outcome.error) })}</p> : null}
          {!outcome.error && outcome.processed === 0 ? <p className="text-soft">{t('ap.fu.nothing')}</p> : null}
          {!outcome.error && outcome.processed > 0 && phase === 'dry_done' ? <p className="text-soft">{outcome.stopped ? t('ap.fu.stopped', { n: outcome.processed }) : t('ap.fu.doneDry', { n: outcome.processed })}</p> : null}
          {!outcome.error && phase === 'done' ? <p className="text-soft">{outcome.stopped ? t('ap.fu.stopped', { n: outcome.processed }) : t('ap.fu.doneApply', { n: outcome.processed, failed: outcome.failed.length })}</p> : null}
          {outcome.failed.length ? (
            <div className="mt-2">
              <p className="font-medium text-danger">{t('ap.fu.failedItems')}</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-soft">
                {outcome.failed.slice(0, 10).map((f) => <li key={f.business_id}><span className="font-mono">{t('ap.fu.item', { id: f.business_id, outcome: t('ap.fu.outcome.failed') })}</span></li>)}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const KNOWN = new Set(['would_sync', 'synced', 'created', 'mock', 'failed', 'skipped', 'ok', 'would_update', 'updated', 'not_found']);
const known = (k: string): boolean => KNOWN.has(k);
const isReauth = (e: unknown): boolean => (e as { status?: number; payload?: { code?: string } })?.status === 403 && (e as { payload?: { code?: string } }).payload?.code === 'reauth_required';
