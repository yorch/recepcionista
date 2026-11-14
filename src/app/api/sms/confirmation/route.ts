import { fail, ok, readJson } from '@/lib/http';
import { getBooking, getBusiness, listSms } from '@/lib/db';
import { confirmationSms, type Lang } from '@/lib/messaging/templates';
import { sendAndLog } from '@/lib/messaging';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { booking_id, language } = await readJson<{ booking_id: string; language?: Lang }>(req);
    if (!booking_id) return fail('booking_id is required', 422);

    const booking = getBooking(booking_id);
    if (!booking) return fail('booking not found', 404);
    const business = getBusiness(booking.business_id);
    if (!business) return fail('business not found', 404);

    // Idempotent: a retried voice tool must not text the customer twice.
    const duplicate = listSms(business.id).find(
      (s) =>
        s.kind === 'confirmation' &&
        s.to_phone.endsWith(booking.customer_phone.replace(/\D/g, '').slice(-10)) &&
        Date.now() - new Date(s.created_at).getTime() < 120_000,
    );
    if (duplicate) return ok({ sms: duplicate, body: duplicate.body, deduped: true });

    const body = confirmationSms({ business, booking, language: language ?? 'en' });
    const result = await sendAndLog({
      business_id: business.id,
      to: booking.customer_phone,
      body,
      kind: 'confirmation',
    });

    return ok({ sms: result.sms, body, deduped: false });
  } catch (err) {
    return fail(err, 500);
  }
}
