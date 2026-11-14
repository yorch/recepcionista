import { fail, ok, readJson } from '@/lib/http';
import { findRecentSms, getBooking, getBusiness } from '@/lib/db';
import { confirmationSms, type Lang } from '@/lib/messaging/templates';
import { sendAndLog } from '@/lib/messaging';
import type { SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** A voice tool can fire twice in one turn; the customer should only get one text. */
const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

export interface ConfirmationResult {
  sms: SmsLog;
  body: string;
  deduped: boolean;
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

    // Keyed on the booking, so two jobs for the same customer in the same
    // window still each get their own confirmation.
    const recent = await findRecentSms(business.id, {
      kind: 'confirmation',
      bookingId: booking.id,
      withinMs: DEDUPE_WINDOW_MS,
    });
    if (recent) {
      return ok<ConfirmationResult>({ sms: recent, body: recent.body, deduped: true });
    }

    const body = confirmationSms({ business, booking, language: language ?? 'en' });
    const { sms } = await sendAndLog({
      business_id: business.id,
      to: booking.customer_phone,
      body,
      kind: 'confirmation',
      booking_id: booking.id,
    });

    return ok<ConfirmationResult>({ sms, body, deduped: false });
  } catch (err) {
    return fail(err, 500);
  }
}
