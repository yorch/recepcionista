import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBooking, getBusiness } from '@/lib/db';
import { Checkout } from './checkout';
import { PaymentReceived } from './received';

/**
 * The page a customer lands on in mock mode. The amount, description and business name
 * come from the DATABASE, looked up by booking id — never from query params, which a
 * customer (or anyone with the link) could edit. The old `mock_<random>` ids with
 * query-param amounts remain for the local demo only (NODE_ENV !== 'production').
 *
 * Booking resolution: `/pay/<bookingId>` or `/pay/mock_x?booking=<bookingId>`.
 */
export const metadata: Metadata = {
  title: 'Secure payment',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const DEFAULT_AMOUNT_CENTS = 18_900; // $189 — demo-only fallback
const MIN_DEMO_CENTS = 100;
const MAX_DEMO_CENTS = 50_000; // the $500 deposit cap
const DEFAULT_LABEL = 'Emergency service deposit';
const DEFAULT_BUSINESS = 'Miami Cool Air Conditioning';

type Params = Promise<{ id: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Demo-only: a bounded amount from the query string. Cents, or dollars if a decimal / < 100. */
function demoAmount(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AMOUNT_CENTS;
  const cents = Number.isInteger(n) && n >= 100 ? n : Math.round(n * 100);
  return Math.min(MAX_DEMO_CENTS, Math.max(MIN_DEMO_CENTS, cents));
}

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { id } = await params;
  const query = await searchParams;
  const isProd = process.env.NODE_ENV === 'production';
  const isMockId = id.startsWith('mock_');

  const bookingId = first(query.booking)?.trim() || (isMockId ? '' : id);
  const booking = bookingId ? await getBooking(bookingId).catch(() => null) : null;

  let amountCents: number;
  let label: string;
  let businessName: string;

  if (booking) {
    const business = await getBusiness(booking.business_id);
    businessName = business?.name ?? 'Your service provider';
    label = `${booking.service} deposit`;
    if (booking.deposit_amount && booking.deposit_amount > 0) {
      amountCents = booking.deposit_amount;
    } else if (!isProd && isMockId) {
      amountCents = demoAmount(first(query.amount));
    } else {
      notFound();
    }
    if (booking.deposit_paid) {
      return (
        <div className="min-h-dvh">
          <PaymentReceived
            reference={id}
            amountCents={amountCents}
            label={label}
            businessName={businessName}
            last4="----"
          />
        </div>
      );
    }
  } else if (isMockId && !isProd) {
    // Local demo only: a bare mock link with no booking. Values are clamped and cosmetic.
    amountCents = demoAmount(first(query.amount));
    label = (first(query.for)?.trim() || DEFAULT_LABEL).slice(0, 80);
    businessName = (first(query.business)?.trim() || DEFAULT_BUSINESS).slice(0, 60);
  } else {
    notFound();
  }

  return (
    <div className="min-h-dvh">
      <Checkout
        reference={id}
        amountCents={amountCents}
        label={label}
        businessName={businessName}
        bookingId={booking?.id}
      />
    </div>
  );
}
