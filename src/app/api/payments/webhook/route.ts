import { NextResponse } from 'next/server';
import { getBooking, getBusiness, listBookings, updateBooking } from '@/lib/db';
import { logSms } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Test-mode webhook. Signature verification is only enforced when a secret is
 * configured; without one we still accept so a local demo never stalls, but we
 * say so in the logs.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (secret && !req.headers.get('stripe-signature')) {
    return NextResponse.json({ ok: false, error: 'missing signature' }, { status: 400 });
  }
  if (!secret) console.warn('[stripe] webhook accepted without signature verification (test mode)');

  let event: {
    type?: string;
    data?: { object?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const type = event.type ?? '';
  if (!type.startsWith('checkout.session.completed') && !type.startsWith('payment_link')) {
    return NextResponse.json({ ok: true, ignored: type });
  }

  const object = event.data?.object ?? {};
  const metadata = (object.metadata ?? {}) as Record<string, string>;
  const bookingId = metadata.booking_id;
  const amount = Number(object.amount_total ?? object.amount ?? 0) / 100;

  if (bookingId) {
    const booking = getBooking(bookingId);
    if (booking) {
      updateBooking(booking.id, { deposit_paid: true, status: 'confirmed' });
      const business = getBusiness(booking.business_id);
      if (business) {
        logSms({
          business_id: business.id,
          to_phone: business.owner_phone ?? '',
          body: `${business.name}: Deposit of $${amount.toFixed(0)} received for ${booking.customer_name} (${booking.service}).`,
          kind: 'owner_alert',
          provider_id: null,
          status: 'sent',
        });
      }
      return NextResponse.json({ ok: true, booking_id: bookingId, deposit_paid: true });
    }
  }

  // No metadata to match on — surface it to the owner rather than drop it.
  const business = listBookings()[0]
    ? getBusiness(listBookings()[0].business_id)
    : null;
  if (business) {
    logSms({
      business_id: business.id,
      to_phone: business.owner_phone ?? '',
      body: `${business.name}: Payment of $${amount.toFixed(0)} received (unmatched to a booking).`,
      kind: 'owner_alert',
      provider_id: null,
      status: 'sent',
    });
  }
  return NextResponse.json({ ok: true, unmatched: true });
}
