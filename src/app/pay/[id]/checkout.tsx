'use client';

import { useState } from 'react';
import { LogoMark } from '@/components/ui/logo';
import { TextField } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { formatMoney } from './money';
import { PaymentReceived } from './received';

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

function validate(card: string, exp: string, cvc: string, zip: string): Errors {
  const e: Errors = {};
  if (card.replace(/\D/g, '').length < 13) e.card = 'Enter the full card number.';
  const m = /^(\d{2})\s*\/?\s*(\d{2})$/.exec(exp.trim());
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) e.exp = 'Use MM / YY.';
  if (!/^\d{3,4}$/.test(cvc.trim())) e.cvc = '3 or 4 digits.';
  if (zip.trim().length < 3) e.zip = 'Enter your ZIP code.';
  return e;
}

export function Checkout({ reference, amountCents, label, businessName, bookingId }: CheckoutProps) {
  const [card, setCard] = useState('');
  const [exp, setExp] = useState('');
  const [cvc, setCvc] = useState('');
  const [zip, setZip] = useState('');
  const [state, setState] = useState<'idle' | 'paying' | 'paid'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [paidAt, setPaidAt] = useState<string | undefined>();

  const amount = formatMoney(amountCents);

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    const found = validate(card, exp, cvc, zip);
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
          setError(res.status === 404 ? 'Demo payments are not enabled on this server.' : 'Payment could not be recorded. Please try again.');
          setState('idle');
          return;
        }
      } catch {
        setError('Network error. Please check your connection and try again.');
        setState('idle');
        return;
      }
    }
    await beat;
    setPaidAt(new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()));
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
            <p className="text-xs leading-tight text-dim">Secure payment</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-line-3 px-2.5 py-1 text-xs font-medium uppercase tracking-wider text-mute">
          Demo checkout
        </span>
      </header>

      <section aria-labelledby="amount-label" className="mt-7 rounded-2xl border border-line bg-panel p-5">
        <h1 id="amount-label" className="text-xs uppercase tracking-[0.12em] text-dim">{label}</h1>
        <p className="mt-1.5 font-mono text-[34px] leading-none tracking-tight text-white" aria-label={`Amount due ${amount}`}>{amount}</p>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-mute">
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-mint" />
          Payable today to confirm your appointment with {businessName}
        </p>
      </section>

      <form onSubmit={pay} className="mt-5 space-y-3.5" noValidate aria-describedby="demo-note">
        <TextField label="Card number" value={card} onChange={(e) => setCard(e.target.value)} mono inputMode="numeric"
          autoComplete="cc-number" placeholder="1234 1234 1234 1234" error={errors.card} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Expiry" value={exp} onChange={(e) => setExp(e.target.value)} mono inputMode="numeric"
            autoComplete="cc-exp" placeholder="MM / YY" error={errors.exp} />
          <TextField label="CVC" value={cvc} onChange={(e) => setCvc(e.target.value)} mono inputMode="numeric"
            autoComplete="cc-csc" placeholder="123" error={errors.cvc} />
        </div>
        <TextField label="ZIP code" value={zip} onChange={(e) => setZip(e.target.value)} mono inputMode="numeric"
          autoComplete="postal-code" placeholder="33131" error={errors.zip} />

        <Button type="submit" disabled={state === 'paying'} className="mt-2 w-full py-3.5 text-[15px] font-semibold">
          {state === 'paying' ? 'Processing…' : `Pay ${amount}`}
        </Button>
        <div aria-live="polite">
          {error ? <p role="alert" className="rounded-xl border border-warn-line bg-warn-bg px-3.5 py-2.5 text-center text-[13px] text-warn">{error}</p> : null}
        </div>
      </form>

      <p id="demo-note" className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-dim">
        <span aria-hidden="true">🔒</span>
        <span>This is a demonstration checkout. No card is charged.</span>
      </p>

      <p className="mt-3 text-center font-mono text-xs text-dim">Ref {reference}</p>
    </main>
  );
}
