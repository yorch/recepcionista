'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { apiRequest } from '@/hooks/use-api';
import { useLocale, useT } from '@/lib/i18n/client';
import { displayValue } from '@/lib/admin-ui/model';
import type { ApplyResult, ChangePreview, Preview, SettingChange } from '@/lib/admin/settings-store';
import type { ImpactView } from '@/lib/admin/ops-model';
import { ImpactPanel } from './ops-impact';
import { apiCode, phraseFromError } from './errors';
import { useAdmin } from './provider';
import { confirmReady, ConfirmFields, LoadingBlock, Problems, TierBadge } from './ui';
import { settingText } from '@/lib/admin-ui/setting-text';
import { settingDef } from '@/lib/config/registry';
import type { MessageKey } from '@/lib/i18n/core';

/** Localized label of a registry key (falls back to the key itself for an unknown one). */
export function useLabelOf(): (key: string) => string {
  const locale = useLocale();
  return useCallback((key: string) => {
    const def = settingDef(key);
    return def ? settingText(def, locale).label : key;
  }, [locale]);
}

export interface ChangeReviewProps {
  changes: SettingChange[];
  /** "Move to console": copy an environment-pinned value into the console (dormant until the variable is deleted). */
  adopt?: boolean;
  title?: string;
  subtitle?: string;
  submitLabel?: string;
  /** The effective value of a key today (the preview itself only knows the console value). */
  effectiveOf?: (key: string) => unknown;
  onApplied: (result: ApplyResult) => void;
  onCancel: () => void;
}

/**
 * The review step of every console write: preview (what changes, the tier, what each change needs afterwards), then reason and typed confirmation as the
 * tier demands, then Apply. The preview is made by the server (POST /settings/preview) so the tier, the exact confirmation phrase and the version come
 * from one place; the apply carries `expected_version` so a change made by someone else in between is refused (`stale_preview`) and re-reviewed.
 */
export function ChangeReview({ changes, adopt, title, subtitle, submitLabel, effectiveOf, onApplied, onCancel }: ChangeReviewProps) {
  const t = useT();
  const locale = useLocale();
  const { guard } = useAdmin();
  const labelOf = useLabelOf();
  const [settled, setSettled] = useState<{ token: string; preview: Preview | null; error: unknown } | null>(null);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const headingId = useId();
  const root = useRef<HTMLDivElement>(null);
  const changesKey = JSON.stringify(changes);
  const token = `${round}#${adopt ? 1 : 0}#${changesKey}`;
  // the preview of THIS change list: derived, so a changed list shows the loading state at once instead of the old preview
  const current = settled && settled.token === token ? settled : null;
  const preview = current?.preview ?? null;
  const loadError = current?.error ?? null;

  useEffect(() => {
    let live = true;
    apiRequest<Preview & { impacts?: ImpactView[] }>('/api/admin/settings/preview', { body: { changes: JSON.parse(changesKey), ...(adopt ? { adopt: true } : {}) } })
      .then((p) => { if (live) setSettled({ token, preview: p, error: null }); })
      .catch((e) => { if (live) setSettled({ token, preview: null, error: e }); });
    return () => { live = false; };
  }, [changesKey, adopt, token]);

  useEffect(() => { root.current?.focus(); }, []);

  const phrase = preview?.requires.confirm ?? null;
  const ready = preview !== null && !busy && confirmReady({ reasonRequired: preview.requires.reason, reason, phrase, typed });
  const live = preview?.changes.filter((c) => c.op !== 'noop') ?? [];

  async function apply() {
    if (!preview || !ready) return;
    setBusy(true);
    setApplyError(null);
    try {
      let result: ApplyResult | null = null;
      await guard(async () => {
        result = await apiRequest<ApplyResult>('/api/admin/settings/apply', {
          body: { changes, reason: reason.trim() || undefined, confirm: typed.trim() || undefined, expected_version: preview.version, ...(adopt ? { adopt: true } : {}) },
        });
      });
      if (result) {
        const r = result as ApplyResult;
        toast.success(r.noop ? t('ac.review.noop') : t('ac.review.applied', { version: r.version }));
        onApplied(r);
      }
    } catch (err) {
      if (apiCode(err) === 'stale_preview') { setRound((n) => n + 1); toast.error(t('ac.err.stale_preview')); }
      else {
        const p = phraseFromError(err);
        if (p) setTyped('');
        setApplyError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={root} tabIndex={-1} role="region" aria-labelledby={headingId} className="outline-none" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel(); } }}>
    <Card className="border-brand-line bg-panel">
      <CardHead title={title ?? t('ac.review.title')} subtitle={subtitle ?? t('ac.review.subtitle', { n: changes.length })} />
      <span id={headingId} className="sr-only">{title ?? t('ac.review.title')}</span>
      <div className="flex flex-col gap-4 p-5">
        {loadError ? (
          <div className="flex flex-col gap-3"><Problems error={loadError} labelOf={labelOf} /><div><Button variant="outline" onClick={onCancel}>{t('ac.review.back')}</Button></div></div>
        ) : !preview ? (
          <LoadingBlock rows={2} />
        ) : (
          <>
            <ul className="flex flex-col gap-3" aria-label={t('ac.review.changesList')}>
              {preview.changes.map((c) => <ChangeRow key={c.key} c={c} label={labelOf(c.key)} before={effectiveOf ? effectiveOf(c.key) : c.old} locale={locale} />)}
            </ul>
            {preview.warnings.length ? <ul className="list-disc pl-5 text-[13px] text-warn">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
            <ImpactPanel impacts={(preview as { impacts?: ImpactView[] }).impacts} />
            {live.length === 0 ? <p role="status" className="text-[13px] text-mute">{t('ac.review.nothing')}</p> : null}
            {preview.requires.notify_admins && live.length ? <p className="text-[13px] text-warn">{t('ac.review.notify')}</p> : null}
            {live.length ? (
              <ConfirmFields reasonRequired={preview.requires.reason} phrase={phrase} reason={reason} onReason={setReason} typed={typed} onTyped={setTyped} />
            ) : null}
            {applyError ? <Problems error={applyError} labelOf={labelOf} /> : null}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void apply()} disabled={!ready || live.length === 0}>{busy ? t('ac.review.applying') : (submitLabel ?? t('ac.review.apply'))}</Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
        </div>
      </div>
    </Card>
    </div>
  );
}

const APPLIES_KEY: Record<string, MessageKey> = {
  live: 'ac.applies.live', new_records_only: 'ac.applies.new_records_only', restart_required: 'ac.applies.restart_required', needs_resync: 'ac.applies.needs_resync',
};
const FOLLOW_KEY: Record<string, MessageKey> = {
  resync_agents: 'ac.follow.resync_agents', repair_numbers: 'ac.follow.repair_numbers', reregister_webhooks: 'ac.follow.reregister_webhooks', restart: 'ac.follow.restart',
};

function ChangeRow({ c, label, before, locale }: { c: ChangePreview; label: string; before: unknown; locale: string }) {
  const t = useT();
  void locale;
  const empty = t('ac.diff.unset');
  const was = displayValue(before, empty);
  const now = c.op === 'remove' ? t('ac.diff.backToDefault') : displayValue(c.new, empty);
  return (
    <li className="rounded-xl border border-line bg-sunken p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-medium text-white">{label}</span>
        <code className="font-mono text-[11px] text-dim">{c.key}</code>
        <TierBadge tier={c.tier} />
        {c.op === 'noop' ? <span className="text-xs text-dim">{t('ac.diff.noop')}</span> : null}
      </div>
      <dl className="mt-2 grid gap-1 text-[13px] sm:grid-cols-[auto_1fr] sm:gap-x-3">
        <dt className="text-dim">{t('ac.diff.before')}</dt>
        <dd className="break-words font-mono text-[12px] text-danger"><span aria-hidden="true">− </span>{was}</dd>
        <dt className="text-dim">{t('ac.diff.after')}</dt>
        <dd className="break-words font-mono text-[12px] text-mint-text"><span aria-hidden="true">+ </span>{now}</dd>
      </dl>
      {c.op !== 'noop' && (c.applies !== 'live' || c.follow_up) ? (
        <p className="mt-2 text-xs text-warn">
          {c.applies !== 'live' ? t(APPLIES_KEY[c.applies]) : null}{c.applies !== 'live' && c.follow_up ? ' ' : null}{c.follow_up ? t(FOLLOW_KEY[c.follow_up]) : null}
        </p>
      ) : null}
    </li>
  );
}

