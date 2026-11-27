'use client';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { TextAreaField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { displayValue } from '@/lib/admin-ui/model';
import type { ApplyResult, ImportPlan } from '@/lib/admin/settings-store';
import { useLabelOf } from './change-review';
import { phraseFromError } from './errors';
import { useAdmin } from './provider';
import { confirmReady, ConfirmFields, Problems } from './ui';

interface ImportResponse { plan: ImportPlan; result: ApplyResult | null }

const SKIP_REASON: Record<string, MessageKey> = {
  locked_by_env: 'ac.import.skip.locked_by_env', secret_not_importable: 'ac.import.skip.secret_not_importable', unknown_key: 'ac.import.skip.unknown_key', invalid_value: 'ac.import.skip.invalid_value',
};

/** Export (console-held non-secret settings, plans, secret fingerprints) and import with a dry-run diff first, then ONE change set. Secrets never travel. */
export function ExportImport() {
  const t = useT();
  const { can, guard } = useAdmin();
  const labelOf = useLabelOf();
  const [text, setText] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [phrase, setPhrase] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const mayImport = can('settings.import');

  async function download() {
    setBusy(true);
    try {
      const doc = await apiRequest<unknown>('/api/admin/settings/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `recepcionista-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  function parse(): unknown | undefined {
    try { return JSON.parse(text); } catch { setError(new Error('invalid JSON')); return undefined; }
  }

  async function dryRun() {
    const document = parse();
    if (document === undefined) return;
    setBusy(true); setError(null); setPlan(null);
    try {
      const res = await apiRequest<ImportResponse>('/api/admin/settings/import', { body: { document } });
      setPlan(res.plan); setPhrase(null); setTyped('');
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  async function applyImport() {
    const document = parse();
    if (document === undefined) return;
    setBusy(true); setError(null);
    try {
      let res: ImportResponse | null = null;
      await guard(async () => { res = await apiRequest<ImportResponse>('/api/admin/settings/import', { body: { document, apply: true, reason: reason.trim() || undefined, confirm: typed.trim() || undefined } }); });
      if (res) { toast.success(t('ac.import.applied')); setPlan(null); setText(''); setReason(''); setTyped(''); }
    } catch (e) {
      const p = phraseFromError(e);
      if (p) { setPhrase(p); setTyped(''); }
      setError(e);
    } finally { setBusy(false); }
  }

  const sets = plan?.diff.filter((d) => d.op === 'set' || d.op === 'remove') ?? [];

  return (
    <Card>
      <CardHead title={t('ac.import.title')} subtitle={t('ac.import.sub')} />
      <div className="flex flex-col gap-4 p-5">
        <div><Button variant="outline" onClick={() => void download()} disabled={busy}>{t('ac.import.download')}</Button></div>
        <div className="flex flex-col gap-2">
          <input
            ref={file} type="file" accept="application/json,.json" aria-label={t('ac.import.file')} className="text-[13px] text-mute"
            onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setText(await f.text()); setPlan(null); setError(null); } }}
          />
          <TextAreaField label={t('ac.import.paste')} rows={5} value={text} onChange={(e) => { setText(e.target.value); setPlan(null); }} spellCheck={false} inputClassName="font-mono text-[12px]" />
          <div><Button onClick={() => void dryRun()} disabled={busy || !text.trim()}>{t('ac.import.dryRun')}</Button></div>
        </div>
        {error ? <Problems error={error} labelOf={labelOf} /> : null}
        {plan ? (
          <div className="flex flex-col gap-3" role="region" aria-label={t('ac.import.diff')}>
            <h3 className="text-sm font-semibold text-white">{t('ac.import.diff')}</h3>
            <ul className="flex flex-col gap-2">
              {plan.diff.filter((d) => d.op !== 'noop').map((d) => (
                <li key={d.key} className="rounded-xl border border-line bg-sunken p-3 text-[13px]">
                  <span className="font-medium text-white">{labelOf(d.key)}</span> <code className="font-mono text-[11px] text-dim">{d.key}</code>
                  {d.op === 'skip' ? <p className="mt-1 text-warn">{t('ac.import.skipped')}: {SKIP_REASON[d.reason ?? ''] ? t(SKIP_REASON[d.reason ?? '']) : d.reason}</p> : (
                    <p className="mt-1 font-mono text-[12px]"><span className="text-danger">− {displayValue(d.old, t('ac.diff.unset'))}</span> <span className="text-mint-text">+ {d.op === 'remove' ? t('ac.diff.backToDefault') : displayValue(d.new, t('ac.diff.unset'))}</span></p>
                  )}
                </li>
              ))}
            </ul>
            {plan.diff.every((d) => d.op === 'noop') ? <p className="text-[13px] text-mute">{t('ac.import.nothing')}</p> : null}
            {plan.plans.create.length + plan.plans.update.length > 0 ? <p className="text-[13px] text-soft">{t('ac.import.plans', { create: plan.plans.create.length, update: plan.plans.update.length })}</p> : null}
            {plan.warnings.length ? <ul className="list-disc pl-5 text-[13px] text-warn">{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
            {sets.length > 0 || plan.plans.create.length + plan.plans.update.length > 0 ? (
              mayImport ? (
                <>
                  <ConfirmFields reasonRequired phrase={phrase} reason={reason} onReason={setReason} typed={typed} onTyped={setTyped} />
                  <div><Button disabled={busy || !confirmReady({ reasonRequired: true, reason, phrase, typed })} onClick={() => void applyImport()}>{busy ? t('ac.review.applying') : t('ac.import.apply')}</Button></div>
                </>
              ) : <p className="text-[13px] text-mute">{t('ac.import.noPermission')}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
