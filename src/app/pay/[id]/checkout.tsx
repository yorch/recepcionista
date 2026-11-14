'use client';

import { useState } from 'react';
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
}

export function Checkout({ reference, amountCents, label, businessName }: CheckoutProps) {
  const [card, setCard] = useState('4242 4242 4242 4242');
  const [exp, setExp] = useState('12 / 29');
  const [cvc, setCvc] = useState('123');
  const [zip, setZip] = useState('33131');
  const [state, setState] = useState<'idle' | 'paying' | 'paid'>('idle');

  const amount = formatMoney(amountCents);

  function pay(e: React.FormEvent) {
    e.preventDefault();
    setState('paying');
    // Short beat so the button press reads as a real network call.
    setTimeout(() => setState('paid'), 900);
  }

  if (state === 'paid') {
    return (
      <PaymentReceived
        reference={reference}
        amountCents={amountCents}
        label={label}
        businessName={businessName}
        last4={card.replace(/\s/g, '').slice(-4)}
      />
    );
  }

  return (
    <main className="mx-auto w-full max-w-md px-5 pb-12 pt-8">
      <header className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#ff6b35] text-sm font-bold text-[#150800]">
            {businessName.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold leading-tight text-white">{businessName}</p>
            <p className="text-[10.5px] leading-tight text-[#6b7b91]">Secure payment</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-[#2a3546] px-2 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-[#7b8b9f]">
          Test mode
        </span>
      </header>

      <section className="mt-7 rounded-2xl border border-[#1f2937] bg-[#0d1117] p-5">
        <p className="text-[10.5px] uppercase tracking-[0.12em] text-[#6b7b91]">{label}</p>
        <p className="mt-1.5 font-mono text-[34px] leading-none tracking-tight text-white">{amount}</p>
        <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-[#7b8b9f]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#3ddc97]" />
          Payable today to confirm your appointment
        </p>
      </section>

      <form onSubmit={pay} className="mt-5 space-y-3">
        <Field
          label="Card number"
          value={card}
          onChange={setCard}
          mono
          inputMode="numeric"
          autoComplete="cc-number"
          placeholder="4242 4242 4242 4242"
        />
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Expiry"
            value={exp}
            onChange={setExp}
            mono
            inputMode="numeric"
            autoComplete="cc-exp"
            placeholder="MM / YY"
          />
          <Field
            label="CVC"
            value={cvc}
            onChange={setCvc}
            mono
            inputMode="numeric"
            autoComplete="cc-csc"
            placeholder="123"
          />
        </div>
        <Field
          label="ZIP code"
          value={zip}
          onChange={setZip}
          mono
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="33131"
        />

        <button
          type="submit"
          disabled={state === 'paying'}
          className="mt-2 w-full rounded-xl bg-[#ff6b35] py-3.5 text-[15px] font-semibold text-[#150800] shadow-[0_10px_30px_-12px_rgba(255,107,53,.9)] transition-colors hover:bg-[#ff8558] disabled:opacity-60"
        >
          {state === 'paying' ? 'Processing…' : `Pay ${amount}`}
        </button>
      </form>

      <div className="mt-5 flex items-center justify-center gap-1.5 text-[10.5px] text-[#5a6b80]">
        <span>🔒</span>
        <span>Encrypted · This is a demonstration checkout, no card is charged</span>
      </div>

      <p className="mt-3 text-center font-mono text-[10px] text-[#3f4c5e]">Ref {reference}</p>
    </main>
  );
}

function Field({
  label, value, onChange, mono, ...rest
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[0.12em] text-[#6b7b91]">{label}</span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 w-full rounded-xl border border-[#26313f] bg-[#080b10] px-3.5 py-3 text-[15px] text-white outline-none transition-colors focus:border-[#ff6b35]/70 ${mono ? 'font-mono tracking-wide' : ''}`}
      />
    </label>
  );
}
