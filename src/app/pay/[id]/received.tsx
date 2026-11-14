import { formatMoney } from './money';

/**
 * The post-payment state. No 'use client' — it is pure markup, which lets the
 * self-test render it to a string and assert the copy the customer will read.
 */
export interface PaymentReceivedProps {
  reference: string;
  amountCents: number;
  label: string;
  businessName: string;
  last4: string;
}

export function PaymentReceived({
  reference, amountCents, label, businessName, last4,
}: PaymentReceivedProps) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-6 py-10 text-center">
      <div className="live-dot grid h-16 w-16 place-items-center rounded-full bg-[#3ddc97]/15 text-3xl text-[#3ddc97]">
        ✓
      </div>
      <h1 className="mt-6 text-[26px] font-semibold tracking-[-0.02em] text-white">
        Payment received
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-[#a8b6c8]">
        Your tech is confirmed. We texted you the details.
      </p>

      <div className="mt-7 w-full rounded-2xl border border-[#1f2937] bg-[#0d1117] p-5 text-left">
        <Row label="Paid" value={formatMoney(amountCents)} strong />
        <Row label="For" value={label} />
        <Row label="Card" value={`•••• ${last4}`} />
        <Row label="Reference" value={reference} mono />
      </div>

      <p className="mt-5 text-[11px] leading-relaxed text-[#5a6b80]">
        A receipt is on its way by text from {businessName}.
      </p>
    </main>
  );
}

function Row({
  label, value, mono, strong,
}: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[#161d27] py-2 last:border-0">
      <span className="text-[11px] uppercase tracking-wider text-[#6b7b91]">{label}</span>
      <span
        className={`text-right text-[13px] ${mono ? 'font-mono text-[11.5px]' : ''} ${strong ? 'text-[15px] font-semibold text-[#3ddc97]' : 'text-[#cbd7e6]'}`}
      >
        {value}
      </span>
    </div>
  );
}
