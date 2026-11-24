'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';
import type { ApiResult } from '@/lib/types';

/** Starts Checkout / opens the Customer Portal and navigates the browser to the URL Stripe returned. */
export function BillingActions({
  businessId, mode, annualAvailable = false, monthlyLabel, annualLabel,
}: {
  businessId: string;
  /** Offer the monthly/annual choice at checkout (only when STRIPE_PRICE_ID_ANNUAL is configured). */
  annualAvailable?: boolean;
  monthlyLabel?: string | null;
  annualLabel?: string | null;
  /** 'start' = no plan yet (or canceled): Checkout. 'manage' = has a Stripe customer: Portal. */
  mode: 'start' | 'manage';
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const label = mode === 'start' ? t('bill.act.start') : t('bill.act.manage');

  async function go() {
    setBusy(true);
    try {
      const res = await fetch(mode === 'start' ? '/api/billing/checkout' : '/api/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, ...(mode === 'start' && annualAvailable ? { interval } : {}) }),
      });
      const json = (await res.json()) as ApiResult<{ url: string }>;
      if (!json.ok) throw new Error(json.error === 'email_not_verified' ? t('bill.act.confirmEmail') : json.error);
      window.location.assign(json.data.url);
    } catch (err) {
      toast.error(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {mode === 'start' && annualAvailable ? (
        <fieldset>
          <legend className="text-xs font-medium uppercase tracking-wider text-[#8b98ab]">{t('bill.act.billing')}</legend>
          <div role="radiogroup" className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {([['month', t('bill.act.monthly'), monthlyLabel], ['year', t('bill.act.annual'), annualLabel]] as const).map(([v, label, price]) => (
              <label key={v} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-[#2a3546] px-3 py-2 has-[:checked]:border-[#ff6b35] has-[:checked]:bg-[#241810]">
                <input type="radio" name="interval" value={v} checked={interval === v} onChange={() => setInterval(v)} className="h-4 w-4 accent-[#ff6b35]" />
                <span className="text-[13px] text-[#cbd7e6]">{label}{price ? <span className="block text-xs text-[#8b98ab]">{price}</span> : null}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
    <Button onClick={go} disabled={busy} aria-busy={busy} className="min-h-11 w-full sm:w-auto">
      {busy ? t('bill.act.redirecting') : label}
    </Button>
    </div>
  );
}
