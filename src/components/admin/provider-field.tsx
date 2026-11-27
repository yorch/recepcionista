'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SelectField, TextField } from '@/components/ui/field';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { defOf, displayValue, editChangesSomething, editFromText, fieldBlock, ratchetError, valueToText, widgetFor, type StagedEdit } from '@/lib/admin-ui/model';
import { hintKeyOf, labelKeyOf } from '@/lib/admin/provider-ui';
import { ConfirmFields, Problems, SourceBadge, TierBadge, confirmReady } from './ui';
import { useAdmin } from './provider';
import { applyChanges, previewChanges, type Preview, type SettingView } from './provider-api';

/**
 * A plain (non-secret) provider field: its effective value, where it comes from (default / console / locked by environment), the "applies" note, and an inline edit
 * that goes through the same preview -> reason / typed confirmation -> apply path as every console write (one step-up through the reauth panel). Reset to default removes
 * the console value. Validation is the registry schema, the same object the server applies.
 */
export function PlainField({ view, onChanged }: { view: SettingView; onChanged: () => void }) {
  const t = useT();
  const { me, guard } = useAdmin();
  const def = defOf(view.key);
  const label = t(labelKeyOf(view.key) as MessageKey);
  const hint = t(hintKeyOf(view.key) as MessageKey);
  const hasHint = hint !== hintKeyOf(view.key);
  const block = def ? fieldBlock(view, def, me.permissions, me.frozen) : 'no_permission';
  const [editing, setEditing] = useState(false);
  const refocus = () => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-field="${view.key}"] button:not([disabled])`)?.focus());
  const idBase = useId();
  const shown = view.value === null || view.value === undefined || view.value === '' ? t('ap.fld.notSet') : def?.kind === 'bool' ? t(view.value ? 'ap.fld.on' : 'ap.fld.off') : displayValue(view.value, t('ap.fld.notSet'));
  const defaultShown = view.default === null || view.default === undefined || view.default === '' ? null : def?.kind === 'bool' ? t(view.default ? 'ap.fld.on' : 'ap.fld.off') : displayValue(view.default, '');
  const canReset = block === null && view.console_value !== null && view.console_value !== undefined;
  const [resetting, setResetting] = useState(false);

  return (
    <div className="rounded-xl border border-line bg-sunken/40 p-4" data-field={view.key}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-white">{label}</h4>
          {hasHint ? <p className="mt-0.5 text-xs text-dim">{hint}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TierBadge tier={view.tier} />
          <SourceBadge source={view.source} locked={view.locked} envName={view.env} />
        </div>
      </div>
      <p className="mt-2 break-all font-mono text-[13px] text-soft" id={`${idBase}-v`}>{shown}</p>
      {view.source !== 'default' && defaultShown ? <p className="mt-0.5 text-xs text-dim">{t('ap.fld.default', { value: defaultShown })}</p> : null}
      {view.applies !== 'live' ? <p className="mt-1 text-xs text-dim">{t(`ap.fld.applies.${view.applies}` as MessageKey)}</p> : null}
      {block === 'locked_env_only' ? <p className="mt-1 text-xs text-dim">{t('ap.fld.lockedEnvOnly')}</p> : null}
      {block === 'no_permission' ? <p className="mt-1 text-xs text-dim">{t('ap.fld.noPermission')}</p> : null}
      {block === 'frozen' ? <Badge tone="unsure" className="mt-1">{t('ap.sec.frozen')}</Badge> : null}

      {block === null && !editing ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" aria-describedby={`${idBase}-v`} onClick={() => setEditing(true)}>{t('ap.fld.edit')}</Button>
          {canReset ? <Button variant="ghost" onClick={() => setResetting(true)}>{t('ap.fld.reset')}</Button> : null}
        </div>
      ) : null}
      {editing && def ? (
        <EditForm view={view} label={label} guard={guard} onCancel={() => { setEditing(false); refocus(); }} onDone={() => { setEditing(false); onChanged(); }} />
      ) : null}
      {resetting ? (
        <ReviewForm
          view={view} label={label} guard={guard} edit={{ op: 'remove' }}
          onCancel={() => { setResetting(false); refocus(); }} onDone={() => { setResetting(false); onChanged(); }}
        />
      ) : null}
    </div>
  );
}

type Guard = (action: () => Promise<void>) => Promise<void>;

function EditForm({ view, label, guard, onCancel, onDone }: { view: SettingView; label: string; guard: Guard; onCancel: () => void; onDone: () => void }) {
  const t = useT();
  const def = defOf(view.key)!;
  const widget = widgetFor(def);
  const [text, setText] = useState(() => valueToText(def, view.value));
  const [edit, setEdit] = useState<StagedEdit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('input,select,textarea')?.focus(); }, []);
  const values = ((view.schema as { values?: readonly string[] }).values ?? []) as readonly string[];

  function stage(e: React.FormEvent) {
    e.preventDefault();
    const parsed = editFromText(def, text, view.default === null || view.default === undefined);
    if (!parsed.ok) { setError(parsed.error); return; }
    if (!editChangesSomething(view, parsed.edit)) { setError(t('ap.fld.noChange')); return; }
    if (ratchetError(def, view, parsed.edit)) { setError(t('ap.fld.lockedEnvOnly')); return; }
    setError(null);
    setEdit(parsed.edit);
  }

  if (edit) return <ReviewForm view={view} label={label} guard={guard} edit={edit} onCancel={onCancel} onDone={onDone} />;
  return (
    <form onSubmit={stage} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }} className="mt-3 flex flex-col gap-3 rounded-xl border border-line-3 bg-sunken p-4" aria-label={label}>
      <div ref={ref}>
        {widget === 'switch' ? (
          <SelectField label={label} value={text} onChange={(e) => setText(e.target.value)} error={error}>
            <option value="true">{t('ap.fld.on')}</option>
            <option value="false">{t('ap.fld.off')}</option>
          </SelectField>
        ) : widget === 'select' ? (
          <SelectField label={label} value={text} onChange={(e) => setText(e.target.value)} error={error}>
            {values.map((v) => <option key={v} value={v}>{v}</option>)}
          </SelectField>
        ) : (
          <TextField
            label={label} value={text} onChange={(e) => setText(e.target.value)} error={error} mono autoComplete="off" spellCheck={false}
            type={widget === 'int' ? 'text' : widget === 'url' ? 'url' : 'text'} inputMode={widget === 'int' ? 'numeric' : undefined}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">{t('ap.fld.review')}</Button>
        <Button variant="ghost" onClick={onCancel}>{t('ap.sec.cancel')}</Button>
      </div>
    </form>
  );
}

/** Preview -> what changes -> reason / typed phrase when the tier asks -> apply with the version the preview saw. */
function ReviewForm({ view, label, edit, guard, onCancel, onDone }: { view: SettingView; label: string; edit: StagedEdit; guard: Guard; onCancel: () => void; onDone: () => void }) {
  const t = useT();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const change = edit.op === 'remove' ? { key: view.key, remove: true } : { key: view.key, value: edit.value };

  useEffect(() => {
    let live = true;
    previewChanges([change]).then((p) => { if (live) setPreview(p); }).catch((e) => { if (live) setError(e); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.key]);

  const ready = preview !== null && confirmReady({ reasonRequired: preview.requires.reason, reason, phrase: preview.requires.confirm, typed });
  async function apply() {
    if (!preview || busy) return;
    setBusy(true); setError(null);
    try {
      await guard(async () => { await applyChanges({ changes: [change], reason: reason.trim() || undefined, confirm: typed.trim() || undefined, expected_version: preview.version }); });
      setBusy(false);
      toast.success(t('ap.fld.saved'));
      onDone();
    } catch (err) { setBusy(false); setError(err); }
  }
  const before = preview?.changes[0];
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (ready) void apply(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      className="mt-3 flex flex-col gap-3 rounded-xl border border-line-3 bg-sunken p-4" aria-label={label}
    >
      {before ? (
        <p className="text-[13px] text-soft">
          <span className="font-medium text-white">{label}</span>: <span className="font-mono">{displayValue(view.value, t('ap.fld.notSet'))}</span> → <span className="font-mono">{displayValue(before.op === 'remove' ? view.default : before.new, t('ap.fld.notSet'))}</span>
        </p>
      ) : !error ? <p className="text-xs text-dim" role="status">{t('common.loading')}</p> : null}
      {preview ? <ConfirmFields reasonRequired={preview.requires.reason} phrase={preview.requires.confirm} reason={reason} onReason={setReason} typed={typed} onTyped={setTyped} /> : null}
      {error ? <Problems error={error} labelOf={(k) => t(labelKeyOf(k) as MessageKey)} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!ready || busy}>{busy ? t('ap.sec.saving') : t('ap.fld.reasonApply')}</Button>
        <Button variant="ghost" onClick={onCancel}>{t('ap.sec.cancel')}</Button>
      </div>
    </form>
  );
}
