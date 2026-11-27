'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { inputClass } from '@/components/ui/field';
import { cn } from '@/components/ui/cn';
import { PageHeader } from '@/components/ui/page-header';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import type { SettingView, FreezeState } from '@/lib/admin/settings-store';
import type { SettingDef } from '@/lib/config/registry';
import {
  editChangesSomething, editFromText, fieldBlock, isSettingsPageId, ratchetError, sectionsOf, settingsOfPage, stagedToChanges, valueToText, widgetFor,
  type FieldBlock, type SettingsPageId, type StagedEdit,
} from '@/lib/admin-ui/model';
import { settingText } from '@/lib/admin-ui/setting-text';
import { ChangeReview } from './change-review';
import { useAdmin } from './provider';
import { useJson } from './use-json';
import { ErrorPanel, LoadingBlock, SourceBadge, TierBadge } from './ui';

export interface Listing { version: number; frozen: FreezeState; settings: SettingView[] }
interface Draft { text: string; edit: StagedEdit | null; error: string | null }

const APPLIES_NOTE: Record<string, MessageKey> = {
  new_records_only: 'ac.applies.new_records_only', restart_required: 'ac.applies.restart_required', needs_resync: 'ac.applies.needs_resync',
};
const BLOCK_NOTE: Record<Exclude<FieldBlock, null>, MessageKey> = {
  locked_env: 'ac.block.lockedEnv', locked_env_only: 'ac.block.lockedEnvOnly', no_permission: 'ac.block.noPermission', frozen: 'ac.block.frozen',
};

/**
 * A settings page GENERATED FROM THE REGISTRY: every field is derived from the entry's kind and schema (widget, bounds, options), validated with the same schema
 * the server applies, and shows its source (default / console / locked by environment), its tier, what applying it needs ("applies") and a reset to the
 * default. Edits accumulate in a draft change set; "Review changes" previews it on the server and applies it as ONE atomic change set.
 */
export function SettingsPage({ page }: { page: string }) {
  const t = useT();
  const id: SettingsPageId | null = isSettingsPageId(page) ? page : null;
  const { data, error, loading, reload } = useJson<Listing>('/api/admin/settings');
  const { can } = useAdmin();
  if (!id) return null;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t(`ac.page.${id}.title` as MessageKey)} subtitle={t(`ac.page.${id}.sub` as MessageKey)} />
      {id === 'content' && can('legal.read') ? (
        <p className="text-[13px] text-mute">
          {t('ac.content.legalLead')}{' '}
          <Link href="/admin/legal" className="inline-flex min-h-11 items-center text-brand-soft underline underline-offset-2 hover:text-brand-hover">{t('ac.content.legalLink')}</Link>
        </p>
      ) : null}
      {loading && !data ? <LoadingBlock rows={5} /> : error && !data ? <ErrorPanel error={error} onRetry={reload} /> : data ? <SettingsEditor page={id} listing={data} reload={reload} /> : null}
    </div>
  );
}

export function SettingsEditor({ page, listing, reload }: { page: SettingsPageId; listing: Listing; reload: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { me, can } = useAdmin();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [reviewing, setReviewing] = useState(false);
  const views = useMemo(() => new Map(listing.settings.map((s) => [s.key, s])), [listing.settings]);
  const defs = useMemo(() => settingsOfPage(page), [page]);
  const sections = useMemo(() => sectionsOf(defs), [defs]);
  const frozen = listing.frozen.frozen || me.frozen;

  const staged = useMemo(() => Object.fromEntries(Object.entries(drafts).filter(([, d]) => d.edit).map(([k, d]) => [k, d.edit as StagedEdit])), [drafts]);
  const stagedCount = Object.keys(staged).length;
  const errorCount = Object.values(drafts).filter((d) => d.error).length;
  const dirty = Object.keys(drafts).length > 0;

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const setDraft = useCallback((key: string, d: Draft | null) => setDrafts((cur) => {
    const next = { ...cur };
    if (d) next[key] = d; else delete next[key];
    return next;
  }), []);

  const edit = useCallback((def: SettingDef, view: SettingView, text: string, built: ReturnType<typeof editFromText> | { ok: true; edit: StagedEdit }) => {
    if (!built.ok) { setDraft(def.key, { text, edit: null, error: built.error }); return; }
    if (ratchetError(def, view, built.edit)) { setDraft(def.key, { text, edit: null, error: t('ac.field.ratchetViolation') }); return; }
    if (!editChangesSomething(view, built.edit)) { setDraft(def.key, null); return; }
    setDraft(def.key, { text, edit: built.edit, error: null });
  }, [setDraft, t]);

  const changes = useMemo(() => stagedToChanges(staged), [staged]);

  return (
    <>
      {frozen ? <p role="status" className="rounded-xl border border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn">{t('ac.block.frozenBanner')}</p> : null}
      {sections.filter((sec) => sec.defs.some((d) => views.has(d.key))).map((sec) => (
        <Card key={sec.group} role="group" aria-labelledby={`sec-${sec.group}`}>
          <div className="border-b border-line px-5 py-3.5"><h2 id={`sec-${sec.group}`} className="text-sm font-semibold text-white">{t(`ac.group.${sec.group}` as MessageKey)}</h2></div>
          <div className="divide-y divide-line px-5">
            {sec.defs.map((def) => {
              const view = views.get(def.key);
              if (!view) return null;
              const block = fieldBlock(view, def, me.permissions, frozen);
              return (
                <Field
                  key={def.key} def={def} view={view} draft={drafts[def.key]} block={block} locale={locale}
                  onText={(text) => edit(def, view, text, editFromText(def, text, view.default === null))}
                  onValue={(value) => edit(def, view, valueToText(def, value), { ok: true, edit: { op: 'set', value, text: valueToText(def, value) } })}
                  onReset={() => edit(def, view, valueToText(def, view.default), { ok: true, edit: { op: 'remove' } })}
                  onClear={() => setDraft(def.key, null)}
                />
              );
            })}
          </div>
        </Card>
      ))}
      {defs.length === 0 ? <p className="text-[13px] text-mute">{t('ac.page.empty')}</p> : null}

      {dirty && !reviewing ? (
        <div role="region" aria-label={t('ac.draft.bar')} className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-line bg-panel-2 px-4 py-3 shadow-lg">
          <p role="status" className="text-[13px] text-soft">
            {t('ac.draft.count', { n: stagedCount })}{errorCount ? <span className="ml-2 text-danger">{t('ac.draft.errors', { n: errorCount })}</span> : null}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setDrafts({})}>{t('ac.draft.discard')}</Button>
            <Button onClick={() => setReviewing(true)} disabled={errorCount > 0 || stagedCount === 0 || !can('settings.read')}>{t('ac.draft.review')}</Button>
          </div>
        </div>
      ) : null}
      {reviewing ? (
        <ChangeReview
          changes={changes}
          effectiveOf={(k) => views.get(k)?.value}
          onCancel={() => setReviewing(false)}
          onApplied={() => { setReviewing(false); setDrafts({}); reload(); }}
        />
      ) : null}
    </>
  );
}

function Field({
  def, view, draft, block, locale, onText, onValue, onReset, onClear,
}: {
  def: SettingDef; view: SettingView; draft: Draft | undefined; block: FieldBlock; locale: 'en' | 'es';
  onText: (text: string) => void; onValue: (value: unknown) => void; onReset: () => void; onClear: () => void;
}) {
  const t = useT();
  const text = settingText(def, locale);
  const widget = widgetFor(def);
  const disabled = block !== null;
  const fid = `f-${def.key.replace(/\./g, '-')}`;
  const effectiveText = valueToText(def, draft?.edit?.op === 'remove' ? view.default : view.value);
  const shown = draft ? draft.text : effectiveText;
  const removed = draft?.edit?.op === 'remove';
  const staged = Boolean(draft?.edit);
  const current: unknown = draft?.edit ? (draft.edit.op === 'remove' ? view.default : draft.edit.value) : view.value;
  const info = def.schema.info as { min?: number; max?: number; values?: readonly string[]; itemInfo?: { values?: readonly string[] } };
  const rangeNote = widget === 'int'
    ? (info.min !== undefined && info.max !== undefined ? t('ac.field.range', { min: info.min, max: info.max }) : info.min !== undefined ? t('ac.field.min', { min: info.min }) : info.max !== undefined ? t('ac.field.max', { max: info.max }) : null)
    : widget === 'list' && info.max !== undefined ? t('ac.field.maxEntries', { max: info.max })
      : (widget === 'text' || widget === 'url' || widget === 'textarea') && info.max !== undefined ? t('ac.field.maxChars', { max: info.max }) : null;
  const describedBy = [`${fid}-help`, draft?.error ? `${fid}-err` : null].filter(Boolean).join(' ');
  const common = { id: fid, disabled, 'aria-describedby': describedBy, 'aria-invalid': draft?.error ? true : undefined };

  return (
    <div className={cn('py-4', staged && 'border-l-2 border-brand pl-3 -ml-3.5')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor={widget === 'checkboxes' ? undefined : fid} id={`${fid}-label`} className="text-[14px] font-medium text-white">{text.label}</label>
        <SourceBadge source={view.source} locked={view.locked} envName={view.env} />
        <TierBadge tier={def.tier} />
        {staged ? <span className="text-xs font-medium text-brand-soft">{removed ? t('ac.field.willReset') : t('ac.field.changed')}</span> : null}
        <code className="ml-auto hidden font-mono text-[11px] text-dim sm:inline">{def.key}</code>
      </div>
      <p id={`${fid}-help`} className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-mute">{text.help}</p>

      <div className="mt-2.5 max-w-xl">
        {widget === 'switch' ? (
          <label className="inline-flex min-h-11 items-center gap-3 text-[14px] text-soft">
            <input type="checkbox" role="switch" {...common} checked={current === true} onChange={(e) => onValue(e.target.checked)} className="h-5 w-5 accent-[var(--color-brand)]" />
            {current === true ? t('ac.field.on') : t('ac.field.off')}
          </label>
        ) : widget === 'select' ? (
          <select {...common} value={String(current ?? '')} onChange={(e) => onValue(e.target.value)} className={cn(inputClass, 'border-line-2')}>
            {(info.values ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        ) : widget === 'checkboxes' ? (
          <fieldset disabled={disabled} aria-labelledby={`${fid}-label`} aria-describedby={describedBy} className="flex flex-wrap gap-4">
            {(info.itemInfo?.values ?? []).map((v) => {
              const list = Array.isArray(current) ? (current as string[]) : [];
              return (
                <label key={v} className="inline-flex min-h-11 items-center gap-2 text-[14px] text-soft">
                  <input
                    type="checkbox" checked={list.includes(v)} className="h-5 w-5 accent-[var(--color-brand)]"
                    onChange={(e) => onValue((info.itemInfo?.values ?? []).filter((x) => (x === v ? e.target.checked : list.includes(x))))}
                  />
                  {v.toUpperCase()}
                </label>
              );
            })}
          </fieldset>
        ) : widget === 'textarea' || widget === 'json' ? (
          <textarea {...common} rows={widget === 'json' ? 6 : 3} value={shown} onChange={(e) => onText(e.target.value)} maxLength={info.max ?? undefined} className={cn(inputClass, 'resize-y leading-relaxed', widget === 'json' && 'font-mono text-[13px]', draft?.error ? 'border-danger/70' : 'border-line-2')} />
        ) : (
          <div className="flex items-center gap-2">
            <input
              {...common}
              type={widget === 'int' ? 'number' : widget === 'url' ? 'url' : 'text'}
              inputMode={widget === 'int' ? 'numeric' : undefined}
              min={widget === 'int' ? info.min : undefined} max={widget === 'int' ? info.max : undefined}
              step={widget === 'int' ? 1 : undefined}
              value={shown} onChange={(e) => onText(e.target.value)} maxLength={widget === 'int' ? undefined : info.max ?? undefined}
              spellCheck={false} autoComplete="off"
              className={cn(inputClass, widget === 'list' || widget === 'url' ? 'font-mono' : '', draft?.error ? 'border-danger/70' : 'border-line-2')}
            />
            {def.unit ? <span className="shrink-0 text-xs text-dim">{t(`ac.unit.${def.unit}` as MessageKey)}</span> : null}
          </div>
        )}
        {widget === 'list' ? <p className="mt-1 text-xs text-dim">{t('ac.field.listHint')}</p> : null}
        {draft?.error ? <p id={`${fid}-err`} role="alert" className="mt-1.5 text-xs text-danger">{draft.error}</p> : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim">
        {rangeNote ? <span>{rangeNote}</span> : null}
        {view.default !== null && view.default !== undefined ? <span>{t('ac.field.defaultIs', { value: valueToText(def, view.default) || t('ac.diff.unset') })}</span> : null}
        {APPLIES_NOTE[def.applies] ? <span className="text-warn">{t(APPLIES_NOTE[def.applies])}</span> : null}
        {def.ratchet ? <span>{t('ac.field.ratchet', { dir: t(`ac.ratchet.${def.tightenIs ?? 'lower'}` as MessageKey) })}</span> : null}
        {block ? <span className="text-warn">{t(BLOCK_NOTE[block], { env: def.env ?? '' })}</span> : null}
        {view.locked && view.env_invalid ? <span className="text-danger">{t('ac.block.envInvalid', { env: def.env ?? '' })}</span> : null}
        {view.locked && view.console_value !== null && view.console_value !== undefined ? <span>{t('ac.block.dormant')}</span> : null}
        {!disabled && view.source === 'console' && !removed ? (
          <button type="button" onClick={onReset} className="inline-flex min-h-11 items-center rounded-lg px-2 text-brand-soft hover:underline sm:min-h-8">{t('ac.field.reset')}</button>
        ) : null}
        {staged ? <button type="button" onClick={onClear} className="inline-flex min-h-11 items-center rounded-lg px-2 text-mute hover:underline sm:min-h-8">{t('ac.field.undo')}</button> : null}
      </div>
    </div>
  );
}
