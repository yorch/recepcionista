'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError, apiRequest, useApi } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useLocale, useT } from '@/lib/i18n/client';
import { intlTag } from '@/lib/i18n/core';
import type { StepProps } from './flow';

const INCLUDED = ['plan.inc.0', 'plan.inc.1', 'plan.inc.2', 'plan.inc.3'] as const;

const POLL_MS = 2500;
const POLL_MAX_MS = 90_000;

export function PlanStep({
  businessId, status, isAdmin, go, refresh, priceDisplay, annualAvailable = false, annualDisplay = null, capLines = [], checkout, clearCheckout,
}: StepProps & { priceDisplay: string; annualAvailable?: boolean; annualDisplay?: string | null; capLines?: string[]; checkout: 'success' | 'cancel' | null; clearCheckout: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const { busy, request } = useApi();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(checkout === 'success' && !status.provisioning_allowed);
  const [gaveUp, setGaveUp] = useState(false);

  // After Stripe returns, wait for the webhook to mark the subscription (usually a second or two).
  useEffect(() => {
    if (!confirming) return;
    let alive = true;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!alive) return;
      try {
        const s = await apiRequest<{ provisioning_allowed?: boolean }>(`/api/billing/status?business_id=${encodeURIComponent(businessId)}`);
        if (s.provisioning_allowed) {
          const fresh = await refresh();
          if (alive && fresh?.provisioning_allowed) {
            setConfirming(false);
            clearCheckout();
            go('provision');
            return;
          }
        }
      } catch { /* keep polling */ }
      if (Date.now() - started > POLL_MAX_MS) { if (alive) { setConfirming(false); setGaveUp(true); } return; }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, 600);
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming, businessId]);

  async function startTrial() {
    setError(null);
    try {
      const res = await request<{ url?: string }>('/api/billing/checkout', { method: 'POST', body: { business_id: businessId, return_path: '/onboarding', ...(annualAvailable ? { interval } : {}) } });
      if (!res.url) throw new Error(t('plan.noLink'));
      window.location.assign(res.url);
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 409) { await refresh(); setError(t('plan.alreadyHave')); }
      else if (e.status === 403 && /email/i.test(e.message)) setError(t('plan.verifyEmail'));
      else if (e.status === 503) setError(t('plan.billingOff'));
      else setError(errorText(t, e));
    }
  }

  const ok = status.provisioning_allowed;

  return (
    <section aria-labelledby="plan-title">
      <h2 id="plan-title" className="text-[28px] font-semibold tracking-[-0.02em] text-white">{t('plan.title')}</h2>
      <p className="mt-2 text-sm text-mute">{t('plan.lead')}</p>

      <Card className="mt-6 p-5">
        <p className="text-xs font-medium uppercase tracking-wider text-dim">Recepcionista</p>
        {annualAvailable && !ok ? (
          <fieldset className="mt-2">
            <legend className="sr-only">{t('plan.billingPeriod')}</legend>
            <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
              {([['month', t('plan.monthly'), priceDisplay], ['year', t('plan.annual'), annualDisplay]] as const).map(([v, label, price]) => (
                <label key={v} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line-3 px-3 py-2 has-[:checked]:border-brand has-[:checked]:bg-raised">
                  <input type="radio" name="interval" value={v} checked={interval === v} onChange={() => setInterval(v)} className="h-4 w-4 accent-[#ff6b35]" />
                  <span className="text-[13px] text-soft">{label}{price ? <span className="block text-xs text-dim">{price}</span> : null}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="mt-1.5 text-[22px] font-semibold text-white">{priceDisplay}</p>
        )}
        <ul className="mt-4 space-y-2.5">
          {INCLUDED.map((x) => (
            <li key={x} className="flex gap-2.5 text-[13px] leading-relaxed text-soft">
              <span aria-hidden="true" className="mt-0.5 text-mint">✓</span>{t(x)}
            </li>
          ))}
          {capLines.map((line) => (
            <li key={line} className="flex gap-2.5 text-[13px] leading-relaxed text-soft">
              <span aria-hidden="true" className="mt-0.5 text-mint">✓</span>{line}
            </li>
          ))}
        </ul>
      </Card>

      <div aria-live="polite" className="mt-4">
        {checkout === 'cancel' && !ok ? <p className="rounded-xl border border-line-3 bg-panel px-4 py-3 text-[13px] text-body">{t('plan.checkoutCanceled')}</p> : null}
        {confirming ? <p role="status" className="rounded-xl border border-line-3 bg-panel px-4 py-3 text-[13px] text-body">{t('plan.confirming')}</p> : null}
        {gaveUp && !ok ? (
          <p role="alert" className="rounded-xl border border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn">
            {t('plan.gaveUp')}
          </p>
        ) : null}
        {ok && !confirming ? (
          <p role="status" className="rounded-xl border border-mint-line bg-mint-bg px-4 py-3 text-[13px] text-mint-text">
            {isAdmin && status.billing_status === 'none'
              ? t('plan.adminSkip')
              : !status.billing_enforced && status.billing_status === 'none'
                ? t('plan.noPayment')
                : status.billing_status === 'trialing' && status.trial_ends_at
                  ? t('plan.trialUntil', { date: new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium' }).format(new Date(status.trial_ends_at)) })
                  : t('plan.active')}
          </p>
        ) : null}
        {error ? <p role="alert" className="mt-2 rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13px] text-danger">{error}</p> : null}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {ok ? (
          <Button onClick={() => go('provision')} className="flex-1 sm:flex-none sm:px-8">{t('plan.continue')}</Button>
        ) : (
          <Button onClick={startTrial} disabled={busy || confirming} className="flex-1 sm:flex-none sm:px-8">
            {busy ? t('plan.opening') : t('plan.start')}
          </Button>
        )}
        <Button variant="ghost" onClick={() => go('verify')}>{t('common.back')}</Button>
      </div>
      {!ok ? <p className="mt-3 text-xs text-dim">{t('plan.cardNow')}</p> : null}
    </section>
  );
}
