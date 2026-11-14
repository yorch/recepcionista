'use client';
import { useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';

/**
 * Mock checkout. This is the page a customer lands on in demo mode (no Stripe
 * key) and it is styled as what they would actually see on their phone.
 */
export default function MockCheckout() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const [paid, setPaid] = useState(false);
  const [card, setCard] = useState('4242 4242 4242 4242');
  const [exp, setExp] = useState('12 / 29');
  const [cvc, setCvc] = useState('123');
  const [zip, setZip] = useState('33131');
  const [busy, setBusy] = useState(false);

  const amountRaw = Number(search.get('amount') ?? 0);
  const amount = amountRaw > 0 ? amountRaw / 100 : 189;
  const amountText = `$${amount.toFixed(2)}`;
  const label = search.get('for') ?? 'Emergency service deposit';

  function pay() {
    setBusy(true);
    setTimeout(() => {
      setBusy(false);
      setPaid(true);
    }, 900);
  }

  if (paid) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-6">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-[#3ddc97]/15 text-2xl text-[#3ddc97]">✓</div>
        <h1 className="mt-5 text-center text-[24px] font-semibold tracking-[-0.02em]">
          Payment received
        </h1>
        <p className="mt-2 text-center text-sm text-[#8b98ab]">
          Your tech is confirmed. We texted you the details.
        </p>
        <p className="mt-6 font-mono text-3xl text-white">{amountText}</p>
        <p className="mt-1 text-[11px] text-[#5a6b80]">Ref {params.id}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 py-10">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold text-white">Secure payment</p>
        <span className="rounded-full border border-[#2a3546] px-2 py-0.5 text-[10px] text-[#7b8b9f]">
          TEST MODE
        </span>
      </div>

      <div className="mt-6 rounded-2xl border border-[#1f2937] bg-[#0d1117] p-5">
        <p className="text-[11px] uppercase tracking-wider text-[#6b7b91]">{label}</p>
        <p className="mt-1 text-[30px] font-semibold tracking-tight text-white">{amountText}</p>
      </div>

      <div className="mt-4 space-y-3">
        <Field label="Card number" value={card} onChange={setCard} mono />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Expiry" value={exp} onChange={setExp} mono />
          <Field label="CVC" value={cvc} onChange={setCvc} mono />
        </div>
        <Field label="ZIP" value={zip} onChange={setZip} mono />
      </div>

      <button
        onClick={pay}
        disabled={busy}
        className="mt-6 w-full rounded-xl bg-[#ff6b35] py-3 text-sm font-semibold text-[#150800] transition hover:bg-[#ff8558] disabled:opacity-60"
      >
        {busy ? 'Processing…' : `Pay ${amountText}`}
      </button>

      <p className="mt-4 text-center text-[10.5px] leading-relaxed text-[#5a6b80]">
        This is a demonstration checkout. No card is charged, no card data leaves your browser.
      </p>
    </main>
  );
}

function Field({
  label, value, onChange, mono,
}: { label: string; value: string; onChange: (v: string) => void; mono?: boolean }) {
  return (
    <label className="block">
      <span className="text-[10.5px] uppercase tracking-wider text-[#6b7b91]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 w-full rounded-xl border border-[#26313f] bg-[#080b10] px-3.5 py-2.5 text-sm text-white outline-none focus:border-[#ff6b35]/60 ${mono ? 'font-mono' : ''}`}
      />
    </label>
  );
}
