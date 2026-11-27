'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { windowOpenUntil, type TestId } from '@/lib/admin/provider-meta';
import { canSaveSecret, hintKeyOf, labelKeyOf, orphanRisk } from '@/lib/admin/provider-ui';
import { secretFormatOk } from '@/lib/admin/provider-meta';
import { apiCode } from './errors';
import { ConfirmFields, Problems, SourceBadge, confirmReady, formatWhen } from './ui';
import { useAdmin } from './provider';
import { deleteSecret, previewChanges, putSecret, testCandidate, type Preview, type ProviderTestResult, type SettingView } from './provider-api';
import { TestResultView } from './provider-test-result';

type Mode = 'idle' | 'replace' | 'remove';

interface Props {
  view: SettingView;
  /** Plain partners saved in the same change set (e.g. the Twilio account SID next to the auth token). */
  partners: SettingView[];
  /** The provider that tests a candidate of this secret (absent: a format check only). */
  test?: TestId;
  onChanged: () => void;
}

/**
 * One write-only secret: Set / Not set / Locked by environment, fingerprint, last 4, who rotated it and when, the dual-secret window, and Replace (test before save),
 * Test and Remove (critical tier: preview, reason and typed confirmation, step-up through the console's reauth panel). The typed value lives only in this component's
 * state, is never rendered back and is dropped as soon as the dialog closes.
 */
export function SecretField({ view, partners, test, onChanged }: Props) {
  const t = useT();
  const locale = useLocale();
  const { can, guard, me } = useAdmin();
  const label = t(labelKeyOf(view.key) as MessageKey);
  const hint = t(hintKeyOf(view.key) as MessageKey);
  const hasHint = hint !== hintKeyOf(view.key);
  const info = view.secret;
  const locked = info?.source === 'env';
  const mayWrite = can('settings.secrets.write');
  const frozen = me.frozen;
  const [mode, setMode] = useState<Mode>('idle');
  const headingId = useId();

  const close = useCallback(() => {
    setMode('idle');
    // the control that opened the dialog was unmounted while it was open: put focus on the first control of this secret again
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-secret="${view.key}"] button:not([disabled])`)?.focus());
  }, [view.key]);

  const until = windowOpenUntil(info?.previous_accepted_until);
  const blockedText = locked ? null : !mayWrite ? t('ap.sec.noPermission') : frozen ? t('ap.sec.frozen') : null;

  return (
    <div className="rounded-xl border border-line bg-sunken/40 p-4" data-secret={view.key}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id={headingId} className="text-sm font-medium text-white">{label}</h4>
          {hasHint ? <p className="mt-0.5 text-xs text-dim">{hint}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={info?.set ? 'routine' : 'neutral'}>{locked ? t('ap.sec.lockedEnv') : info?.set ? t('ap.sec.set') : t('ap.sec.notSet')}</Badge>
          <SourceBadge source={locked ? 'env' : info?.set ? 'console' : 'default'} locked={locked} envName={view.env} />
        </div>
      </div>

      {locked ? <p className="mt-2 text-xs text-soft">{t('ap.sec.lockedEnvHelp', { env: view.env ?? '' })}</p> : null}
      {!locked && info?.set ? (
        <ul className="mt-2 flex flex-col gap-1 text-xs text-soft">
          {info.fingerprint ? <li><span className="font-mono">{t('ap.sec.fingerprint', { fp: info.fingerprint })}</span>{info.last4 ? <span className="ml-2 font-mono">{t('ap.sec.last4', { last4: info.last4 })}</span> : null}</li> : <li className="text-dim">{t('ap.sec.hiddenMeta')}</li>}
          {info.updated_at ? <li>{info.updated_by ? t('ap.sec.rotated', { when: formatWhen(info.updated_at, locale), who: info.updated_by }) : t('ap.sec.rotatedNoWho', { when: formatWhen(info.updated_at, locale) })}</li> : null}
          {until ? (
            <li className="text-warn" role="status">
              {t('ap.sec.previousUntil', { time: new Intl.DateTimeFormat(locale === 'es' ? 'es-US' : 'en-US', { hour: '2-digit', minute: '2-digit' }).format(until) })}
              <span className="block text-dim">{t('ap.sec.previousUntilHelp')}</span>
            </li>
          ) : null}
        </ul>
      ) : null}

      {partners.length ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {partners.map((p) => (
            <div key={p.key} className="contents">
              <dt className="text-dim">{t(labelKeyOf(p.key) as MessageKey)}</dt>
              <dd className="font-mono text-soft break-all">{p.value === null || p.value === undefined || p.value === '' ? t('ap.fld.notSet') : String(p.value)}{p.locked ? <span className="ml-2"><SourceBadge source="env" locked envName={p.env} /></span> : null}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {!locked ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {mode === 'idle' ? (
            <>
              <Button variant="outline" disabled={Boolean(blockedText)} onClick={() => setMode('replace')} aria-describedby={blockedText ? `${headingId}-why` : undefined}>
                {info?.set ? t('ap.sec.replace') : t('ap.sec.setNew')}
              </Button>
              {info?.set ? <Button variant="danger" disabled={Boolean(blockedText)} onClick={() => setMode('remove')}>{t('ap.sec.remove')}</Button> : null}
              {blockedText ? <span id={`${headingId}-why`} className="text-xs text-dim">{blockedText}</span> : null}
            </>
          ) : null}
        </div>
      ) : null}

      {mode === 'replace' ? <ReplaceForm view={view} partners={partners} label={label} test={test} guard={guard} onCancel={close} onDone={() => { close(); onChanged(); }} /> : null}
      {mode === 'remove' ? <RemoveForm view={view} label={label} guard={guard} onCancel={close} onDone={() => { close(); onChanged(); }} /> : null}
    </div>
  );
}

type Guard = (action: () => Promise<void>) => Promise<void>;

function ReplaceForm({ view, partners, label, test, guard, onCancel, onDone }: { view: SettingView; partners: SettingView[]; label: string; test?: TestId; guard: Guard; onCancel: () => void; onDone: () => void }) {
  const t = useT();
  const formId = useId();
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [pair, setPair] = useState<Record<string, string>>(() => Object.fromEntries(partners.map((p) => [p.key, p.value === null || p.value === undefined ? '' : String(p.value)])));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [acceptUnreachable, setAcceptUnreachable] = useState(false);
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const first = useRef<HTMLDivElement>(null);

  useEffect(() => { first.current?.querySelector('input')?.focus(); }, []);
  useEffect(() => () => { setValue(''); }, []); // the candidate never outlives the dialog

  const sig = JSON.stringify([value, pair]);
  const formatBad = value !== '' && !secretFormatOk(value, view.key);
  const partnerEditable = partners.filter((p) => !p.locked);
  const orphans = orphanRisk(result);
  const changes = useCallback(() => [{ key: view.key, secret: value }, ...partners.map((p) => (pair[p.key] !== undefined && pair[p.key] !== '' ? { key: p.key, value: pair[p.key] } : null)).filter((x): x is { key: string; value: string } => x !== null)], [view.key, value, partners, pair]);

  async function run() {
    if (busy || !value || formatBad) return;
    setBusy(true); setError(null); setPreview(null); setResult(null); setAck(false); setAcceptUnreachable(false);
    try {
      let r: ProviderTestResult | null = null;
      if (test) {
        const candidate: Record<string, string> = { [view.key]: value };
        for (const p of partners) if (pair[p.key]) candidate[p.key] = pair[p.key];
        r = await testCandidate(test, candidate);
        setResult(r);
      }
      setTested(sig);
      setPreview(await previewChanges(changes()));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy || !preview) return;
    setBusy(true); setError(null);
    const body = {
      value, paired: partners.length ? Object.fromEntries(partners.filter((p) => pair[p.key]).map((p) => [p.key, pair[p.key]])) : undefined,
      reason: reason.trim() || undefined, confirm: typed.trim() || undefined, acknowledge_orphans: ack || undefined, accept_unreachable: acceptUnreachable || undefined,
    };
    try {
      await guard(async () => { await putSecret(view.key, body); });
      setBusy(false);
      toast.success(t('ap.sec.saved', { label }));
      onDone();
    } catch (err) {
      setBusy(false);
      setError(err);
    }
  }

  const reasonRequired = preview?.requires.reason ?? false;
  const phrase = preview?.requires.confirm ?? null;
  const confirmOk = confirmReady({ reasonRequired, reason, phrase, typed });
  const canSave = canSaveSecret({
    testRequired: Boolean(test), result, sameAsTested: tested === sig, acceptUnreachable, orphans, acknowledged: ack, confirmOk, previewReady: preview !== null,
  });
  const stale = tested !== null && tested !== sig;
  const code = apiCode(error);

  return (
    <form
      id={formId} role="group" aria-label={label} className="mt-3 flex flex-col gap-3 rounded-xl border border-line-3 bg-sunken p-4"
      onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); else void run(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
    >
      <div ref={first} className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <TextField
            className="flex-1" label={t('ap.sec.newValue')} hint={t('ap.sec.newValueHint')} type={reveal ? 'text' : 'password'} value={value} mono
            onChange={(e) => setValue(e.target.value)} autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} name={`secret-${view.key}`}
            error={formatBad ? t('ap.sec.formatInvalid') : null} required aria-required="true"
          />
          <Button variant="ghost" aria-pressed={reveal} onClick={() => setReveal((r) => !r)} className="mb-0.5">{reveal ? t('ap.sec.hide') : t('ap.sec.show')}</Button>
        </div>
        {partners.map((p) => (
          <TextField
            key={p.key} label={t(labelKeyOf(p.key) as MessageKey)} mono value={pair[p.key] ?? ''} disabled={p.locked || !partnerEditable.includes(p)}
            onChange={(e) => setPair((cur) => ({ ...cur, [p.key]: e.target.value }))} autoComplete="off" spellCheck={false} hint={t('ap.sec.pairNote', { label })}
          />
        ))}
      </div>

      {result ? <TestResultView result={result} /> : test ? <p className="text-xs text-dim">{t('ap.sec.testNeeded')}</p> : <p className="text-xs text-dim">{t('ap.test.local')}</p>}
      {stale ? <p role="status" className="text-xs text-warn">{t('ap.sec.testStale')}</p> : null}
      {result && result.outcome === 'ok' && tested === sig && !stale ? <p role="status" className="text-xs text-mint-text">{t('ap.sec.testPassed')}</p> : null}

      {result?.outcome === 'unreachable' ? (
        <label className="flex items-start gap-2 text-[13px] text-soft">
          <input type="checkbox" className="mt-1 size-4" checked={acceptUnreachable} onChange={(e) => setAcceptUnreachable(e.target.checked)} />
          <span>{t('ap.sec.acceptUnreachable')}</span>
        </label>
      ) : null}

      {orphans > 0 ? (
        <div role="alert" className="rounded-xl border border-warn-line bg-warn-bg/40 p-3 text-[13px]">
          <p className="font-medium text-warn">{t('ap.sec.orphanTitle')}</p>
          <ul className="mt-1 list-disc pl-5 text-soft">
            {result?.mode_changed ? <li>{t('ap.sec.modeChanged')}</li> : null}
            {result?.account_changed === true ? <li>{t('ap.sec.accountChanged')}</li> : null}
            {result?.account_changed === null ? <li>{t('ap.sec.accountUnknown')}</li> : null}
          </ul>
          <p className="mt-1 text-soft">{t('ap.sec.orphanBody', { n: orphans })}</p>
          <label className="mt-2 flex items-start gap-2 text-soft">
            <input type="checkbox" className="mt-1 size-4" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>{t('ap.sec.orphanAck', { n: orphans })}</span>
          </label>
        </div>
      ) : null}

      {preview ? <ConfirmFields reasonRequired={reasonRequired} phrase={phrase} reason={reason} onReason={setReason} typed={typed} onTyped={setTyped} /> : null}

      {error ? (code === 'orphan_ack_required' ? <p role="alert" className="text-[13px] text-danger">{t('ap.sec.orphanTitle')}</p> : <Problems error={error} labelOf={(k) => t(labelKeyOf(k) as MessageKey)} />) : null}

      <div className="flex flex-wrap items-center gap-2">
        {canSave
          ? <Button type="submit" disabled={busy}>{busy ? t('ap.sec.saving') : t('ap.sec.save')}</Button>
          : <Button type="submit" disabled={busy || !value || formatBad}>{busy ? t('ap.test.running') : test ? t('ap.sec.testCandidate') : t('ap.fld.review')}</Button>}
        {canSave && test ? <Button variant="outline" disabled={busy} onClick={() => void run()}>{t('ap.sec.testCandidate')}</Button> : null}
        <Button variant="ghost" onClick={onCancel}>{t('ap.sec.cancel')}</Button>
      </div>
    </form>
  );
}

function RemoveForm({ view, label, guard, onCancel, onDone }: { view: SettingView; label: string; guard: Guard; onCancel: () => void; onDone: () => void }) {
  const t = useT();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    previewChanges([{ key: view.key, remove: true }]).then((p) => { if (live) setPreview(p); }).catch((e) => { if (live) setError(e); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [view.key]);

  const ready = preview !== null && confirmReady({ reasonRequired: preview.requires.reason, reason, phrase: preview.requires.confirm, typed });
  async function remove() {
    if (busy || !preview) return;
    setBusy(true); setError(null);
    try {
      await guard(async () => { await deleteSecret(view.key, { reason: reason.trim(), confirm: typed.trim() || undefined }); });
      setBusy(false);
      toast.success(t('ap.sec.removed', { label }));
      onDone();
    } catch (err) { setBusy(false); setError(err); }
  }
  return (
    <form role="group" aria-label={t('ap.sec.removeTitle', { label })} className="mt-3 flex flex-col gap-3 rounded-xl border border-danger-line bg-danger-bg/20 p-4"
      onSubmit={(e) => { e.preventDefault(); if (ready) void remove(); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <p className="text-sm font-semibold text-white">{t('ap.sec.removeTitle', { label })}</p>
      <p className="text-[13px] text-soft">{t('ap.sec.removeBody')}</p>
      {preview ? <ConfirmFields reasonRequired={preview.requires.reason} phrase={preview.requires.confirm} reason={reason} onReason={setReason} typed={typed} onTyped={setTyped} /> : loading ? <p className="text-xs text-dim" role="status">{t('common.loading')}</p> : null}
      {error ? <Problems error={error} labelOf={(k) => t(labelKeyOf(k) as MessageKey)} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="danger" disabled={!ready || busy}>{t('ap.sec.removeConfirm')}</Button>
        <Button variant="ghost" onClick={onCancel}>{t('ap.sec.cancel')}</Button>
      </div>
    </form>
  );
}

