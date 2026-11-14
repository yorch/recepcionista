import { fail, ok, readJson } from '@/lib/http';
import { getBooking, getBusiness } from '@/lib/db';
import { gratitudeSms, type Lang } from '@/lib/messaging/templates';
import { sendAndLog } from '@/lib/messaging';
import type { SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface GratitudeResult {
  sms: SmsLog;
  body: string;
}

export async function POST(req: Request) {
  try {
    const { booking_id, language } = await readJson<{
      booking_id?: string;
      language?: Lang;
    }>(req);
    if (!booking_id) return fail('booking_id is required', 422);

    const booking = await getBooking(booking_id);
    if (!booking) return fail('booking not found', 404);
    const business = await getBusiness(booking.business_id);
    if (!business) return fail('business not found', 404);

    const body = gratitudeSms({ business, booking, language: language ?? 'en' });
    const { sms } = await sendAndLog({
      business_id: business.id,
      to: booking.customer_phone,
      body,
      kind: 'gratitude',
      booking_id: booking?.id ?? null,
    });

    return ok<GratitudeResult>({ sms, body });
  } catch (err) {
    return fail(err, 500);
  }
}
