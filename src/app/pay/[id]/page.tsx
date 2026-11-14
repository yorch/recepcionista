import type { Metadata } from 'next';
import { Checkout } from './checkout';

/**
 * The page a customer lands on in mock mode. Reached from the payment-link SMS
 * as `/pay/<link id>?amount=<cents>&for=<description>` and opened on a phone,
 * so the amount and the description are rendered on the server while the card
 * form itself is a client island.
 */
export const metadata: Metadata = {
  title: 'Secure payment — Recepcionista',
  robots: { index: false, follow: false },
};

const DEFAULT_AMOUNT_CENTS = 18_900; // $189 — the emergency call-out deposit
const DEFAULT_LABEL = 'Emergency service deposit';
const DEFAULT_BUSINESS = 'Miami Cool Air Conditioning';

type Params = Promise<{ id: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  // Rendered in full rather than streamed behind a skeleton: this is the page a
  // customer opens from a text message, and a flash of grey boxes on a phone
  // reads as broken.
  const { id } = await params;
  const query = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const raw = Number(first(query.amount));
  const amountCents = Number.isFinite(raw) && raw > 0
    ? (Number.isInteger(raw) && raw >= 100 ? raw : Math.round(raw * 100))
    : DEFAULT_AMOUNT_CENTS;

  return (
    <div className="min-h-dvh">
      <Checkout
        reference={id}
        amountCents={amountCents}
        label={first(query.for)?.trim() || DEFAULT_LABEL}
        businessName={first(query.business)?.trim() || DEFAULT_BUSINESS}
      />
    </div>
  );
}
