'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { money } from '@/lib/format';
import { centsToDollars, dollarsToCents } from '@/lib/money';
import type { DepositPolicy } from '@/lib/business-config';
import type { DepositPolicyResult } from '@/app/api/businesses/[id]/deposit-policy/route';

const asDollars = (cents: number | null): string => (cents == null ? '' : String(centsToDollars(cents)));

/**
 * Settings: the deposit policy. Off = the AI never asks for a deposit. On = every deposit (the voice agent's and the dashboard's) is a fixed amount or a
 * percentage of the job's price estimate, clamped to the min / max, computed on the server. The AI cannot choose another amount.
 */
export function DepositPolicySettings({ businessId, initial, limits, canEdit }: {
  businessId: string; initial: DepositPolicy; limits: DepositPolicyResult['limits']; canEdit: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [mode, setMode] = useState<'fixed' | 'percent'>(initial.mode);
  const [fixed, setFixed] = useState(asDollars(initial.fixed_cents));
  const [percent, setPercent] = useState(initial.percent == null ? '' : String(initial.percent));
  const [min, setMin] = useState(asDollars(initial.min_cents));
  const [max, setMax] = useState(asDollars(initial.max_cents));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const cents = (raw: string, label: string): number | null | 'bad' => {
      if (raw.trim() === '') return null;
      const c = dollarsToCents(raw);
      if (c === null || c < limits.min_cents || c > limits.max_cents) { setError(t('dp.err.range', { label, min: money(limits.min_cents, locale), max: money(limits.max_cents, locale) })); return 'bad'; }
      return c;
    };
    const f = cents(fixed, t('dp.fixed')); if (f === 'bad') return;
    const lo = cents(min, t('dp.min')); if (lo === 'bad') return;
    const hi = cents(max, t('dp.max')); if (hi === 'bad') return;
    let pct: number | null = null;
    if (percent.trim() !== '') {
      pct = Number(percent);
      if (!Number.isInteger(pct) || pct < 1 || pct > 100) { setError(t('dp.err.percent')); return; }
    }
    if (enabled && mode === 'fixed' && f === null) { setError(t('dp.err.fixedNeeded')); return; }
    if (enabled && mode === 'percent' && pct === null) { setError(t('dp.err.percentNeeded')); return; }
    if (lo !== null && hi !== null && lo > hi) { setError(t('dp.err.minMax')); return; }
    if (f !== null && ((lo !== null && f < lo) || (hi !== null && f > hi))) { setError(t('dp.err.fixedInside')); return; }
    setBusy(true);
    try {
      await apiRequest<DepositPolicyResult>(`/api/businesses/${businessId}/deposit-policy`, {
        method: 'PUT', body: { enabled, mode, fixed_cents: mode === 'fixed' ? f : null, percent: mode === 'percent' ? pct : null, min_cents: lo, max_cents: hi },
      });
      toast.success(t('dp.saved'));
    } catch (e) {
      setError(errorText(t, e, 'set.type.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="flex min-h-11 items-start gap-2.5 text-[13px] text-soft">
        <input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} className="mt-0.5 h-5 w-5 accent-[#ff6b35]" />
        <span>{t('dp.enabled')}<span className="mt-0.5 block text-xs text-dim">{enabled ? t('dp.on') : t('dp.off')}</span></span>
      </label>
      {enabled ? (
        <>
          <fieldset disabled={!canEdit} className="min-w-0">
            <legend className="text-xs font-medium uppercase tracking-wider text-dim">{t('dp.mode')}</legend>
            <div role="radiogroup" className="mt-1.5 grid gap-2 sm:grid-cols-2">
              {(['fixed', 'percent'] as const).map((m) => (
                <label key={m} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line-3 px-3 py-2 has-[:checked]:border-brand has-[:checked]:bg-raised">
                  <input type="radio" name="deposit-mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="h-4 w-4 accent-[#ff6b35]" />
                  <span className="text-[13px] text-soft">{t(m === 'fixed' ? 'dp.mode.fixed' : 'dp.mode.percent')}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-3">
            {mode === 'fixed'
              ? <TextField label={t('dp.fixed')} inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} disabled={!canEdit} placeholder="50" />
              : <TextField label={t('dp.percent')} inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value)} disabled={!canEdit} placeholder="25" hint={t('dp.percentHint')} />}
            <TextField label={t('dp.min')} optional inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} disabled={!canEdit} />
            <TextField label={t('dp.max')} optional inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} disabled={!canEdit} />
          </div>
        </>
      ) : null}
      <p className="text-xs leading-relaxed text-dim">{t('dp.note', { min: money(limits.min_cents, locale), max: money(limits.max_cents, locale), ai: money(limits.ai_cap_cents, locale) })}</p>
      {error ? <p role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-3 py-2 text-[13px] text-danger">{error}</p> : null}
      {canEdit ? <div className="flex"><Button type="submit" disabled={busy}>{busy ? t('common.saving') : t('dp.save')}</Button></div> : <p className="text-xs text-dim">{t('dp.ownerOnly')}</p>}
    </form>
  );
}
