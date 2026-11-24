'use client';

import { useState } from 'react';
import { LogoMark } from '@/components/ui/logo';
import { TextField } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { formatMoney } from './money';
import { PaymentReceived } from './received';
import { useLocale, useT } from '@/lib/i18n/client';
import { intlTag, type TFunction } from '@/lib/i18n/core';

/**
 * The mock checkout form. Everything here is theatre: no card data leaves the
 * browser, nothing is charged, and the success state just confirms the demo
 * story. Kept separate from the page so the amount can be server-rendered.
 */
export interface CheckoutProps {
  reference: string;
  amountCents: number;
  label: string;
  businessName: string;
  /** When set, Pay records the deposit via POST /api/pay/mock-complete (demo mode only). */
  bookingId?: string;
}

type Errors = Partial<Record<'card' | 'exp' | 'cvc' | 'zip', string>>;

function validate(t: TFunction, card: string, exp: string, cvc: string, zip: string): Errors {
  const e: Errors = {};
  if (card.replace(/\D/g, '').length < 13) e.card = t('pay.err.card');
  const m = /^(\d{2})\s*\/?\s*(\d{2})$/.exec(exp.trim());
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) e.exp = t('pay.err.exp');
  if (!/^\d{3,4}$/.test(cvc.trim())) e.cvc = t('pay.err.cvc');
  if (zip.trim().length < 3) e.zip = t('pay.err.zip');
  return e;
}

export function Checkout({ reference, amountCents, label, businessName, bookingId }: CheckoutProps) {
  const t = useT();
  const locale = useLocale();
  const [card, setCard] = useState('');
  const [exp, setExp] = useState('');
  const [cvc, setCvc] = useState('');
  const [zip, setZip] = useState('');
  const [state, setState] = useState<'idle' | 'paying' | 'paid'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [paidAt, setPaidAt] = useState<string | undefined>();

  const amount = formatMoney(amountCents, locale);

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    const found = validate(t, card, exp, cvc, zip);
    setErrors(found);
    if (Object.keys(found).length) return;
    setState('paying');
    setError(null);
    // Short beat so the button press reads as a real network call.
    const beat = new Promise((r) => setTimeout(r, 900));
    if (bookingId) {
      try {
        const res = await fetch('/api/pay/mock-complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ booking_id: bookingId }),
        });
        if (!res.ok) {
          setError(res.status === 404 ? t('pay.err.demoOff') : t('pay.err.notRecorded'));
          setState('idle');
          return;
        }
      } catch {
        setError(t('pay.err.network'));
        setState('idle');
        return;
      }
    }
    await beat;
    setPaidAt(new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()));
    setState('paid');
  }

  if (state === 'paid') {
    return (
      <PaymentReceived
        reference={reference}
        amountCents={amountCents}
        label={label}
        businessName={businessName}
        last4={card.replace(/\D/g, '').slice(-4)}
        paidAt={paidAt}
        t={t}
        locale={locale}
      />
    );
  }

  return (
    <main id="main-content" className="mx-auto w-full max-w-md px-4 pb-12 pt-6 sm:px-5 sm:pt-8">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <LogoMark letter={businessName.slice(0, 1).toUpperCase()} />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold leading-tight text-white">{businessName}</p>
            <p className="text-xs leading-tight text-dim">{t('pay.secure')}</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-line-3 px-2.5 py-1 text-xs font-medium uppercase tracking-wider text-mute">
          {t('pay.demoBadge')}
        </span>
      </header>

      <section aria-labelledby="amount-label" className="mt-7 rounded-2xl border border-line bg-panel p-5">
        <h1 id="amount-label" className="text-xs uppercase tracking-[0.12em] text-dim">{label}</h1>
        <p className="mt-1.5 font-mono text-[34px] leading-none tracking-tight text-white" aria-label={t('pay.amountDue', { amount })}>{amount}</p>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-mute">
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-mint" />
          {t('pay.payableToday', { business: businessName })}
        </p>
      </section>

      <form onSubmit={pay} className="mt-5 space-y-3.5" noValidate aria-describedby="demo-note">
        <TextField label={t('pay.card')} value={card} onChange={(e) => setCard(e.target.value)} mono inputMode="numeric"
          autoComplete="cc-number" placeholder="1234 1234 1234 1234" error={errors.card} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label={t('pay.expiry')} value={exp} onChange={(e) => setExp(e.target.value)} mono inputMode="numeric"
            autoComplete="cc-exp" placeholder={t('pay.expiryPlaceholder')} error={errors.exp} />
          <TextField label={t('pay.cvc')} value={cvc} onChange={(e) => setCvc(e.target.value)} mono inputMode="numeric"
            autoComplete="cc-csc" placeholder="123" error={errors.cvc} />
        </div>
        <TextField label={t('pay.zip')} value={zip} onChange={(e) => setZip(e.target.value)} mono inputMode="numeric"
          autoComplete="postal-code" placeholder="33131" error={errors.zip} />

        <Button type="submit" disabled={state === 'paying'} className="mt-2 w-full py-3.5 text-[15px] font-semibold">
          {state === 'paying' ? t('pay.processing') : t('pay.pay', { amount })}
        </Button>
        <div aria-live="polite">
          {error ? <p role="alert" className="rounded-xl border border-warn-line bg-warn-bg px-3.5 py-2.5 text-center text-[13px] text-warn">{error}</p> : null}
        </div>
      </form>

      <p id="demo-note" className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-dim">
        <span aria-hidden="true">🔒</span>
        <span>{t('pay.demoNote')}</span>
      </p>

      <p className="mt-3 text-center font-mono text-xs text-dim">{t('pay.ref', { reference })}</p>
    </main>
  );
}
