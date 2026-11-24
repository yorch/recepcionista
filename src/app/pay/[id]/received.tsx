import { formatMoney } from './money';

/**
 * The post-payment state. No 'use client': it is pure markup, which lets the
 * self-test render it to a string and assert the copy the customer will read.
 */
export interface PaymentReceivedProps {
  reference: string;
  amountCents: number;
  label: string;
  businessName: string;
  /** Last 4 digits of the card; "----" (or empty) when unknown, e.g. the link was already paid. */
  last4: string;
  /** Display string for when it was paid (formatted by the caller, in the customer's zone). */
  paidAt?: string;
}

export function PaymentReceived({
  reference, amountCents, label, businessName, last4, paidAt,
}: PaymentReceivedProps) {
  const knownCard = /^\d{4}$/.test(last4);
  return (
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center px-5 py-10 text-center">
      <div aria-hidden="true" className="live-dot grid h-16 w-16 place-items-center rounded-full bg-mint/15 text-3xl text-mint">
        ✓
      </div>
      <h1 className="mt-6 text-[26px] font-semibold tracking-[-0.02em] text-white">Payment received</h1>
      <p role="status" className="mt-2 text-[15px] leading-relaxed text-body">
        Your tech is confirmed. We texted you the details.
      </p>

      <dl className="mt-7 w-full rounded-2xl border border-line bg-panel p-5 text-left">
        <Row label="Paid to" value={businessName} />
        <Row label="Amount" value={formatMoney(amountCents)} strong />
        <Row label="For" value={label} />
        {knownCard ? <Row label="Card" value={`•••• ${last4}`} /> : null}
        {paidAt ? <Row label="Date" value={paidAt} /> : null}
        <Row label="Reference" value={reference} mono />
      </dl>

      <p className="mt-5 text-xs leading-relaxed text-dim">
        A receipt is on its way by text from {businessName}. Keep the reference above if you need to contact them about this payment.
      </p>
    </main>
  );
}

function Row({
  label, value, mono, strong,
}: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[#161d27] py-2 last:border-0">
      <dt className="text-xs uppercase tracking-wider text-dim">{label}</dt>
      <dd className={`min-w-0 break-words text-right text-[13px] ${mono ? 'font-mono text-xs' : ''} ${strong ? 'text-[15px] font-semibold text-mint' : 'text-soft'}`}>
        {value}
      </dd>
    </div>
  );
}
