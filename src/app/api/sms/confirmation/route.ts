import { fail, ok, readJson } from '@/lib/http';
import { getBooking, getBusiness, listSms } from '@/lib/db';
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

    const booking = getBooking(booking_id);
    if (!booking) return fail('booking not found', 404);
    const business = getBusiness(booking.business_id);
    if (!business) return fail('business not found', 404);

    // SmsLog has no booking_id, so the phone number is the only join key we have:
    // same customer + same kind inside the window ⇒ already texted.
    const last10 = booking.customer_phone.replace(/\D/g, '').slice(-10);
    const recent = listSms(business.id).find(
      (s) =>
        s.kind === 'confirmation' &&
        s.to_phone.replace(/\D/g, '').slice(-10) === last10 &&
        Date.now() - new Date(s.created_at).getTime() < DEDUPE_WINDOW_MS,
    );
    if (recent) {
      return ok<ConfirmationResult>({ sms: recent, body: recent.body, deduped: true });
    }

    const body = confirmationSms({ business, booking, language: language ?? 'en' });
    const { sms } = await sendAndLog({
      business_id: business.id,
      to: booking.customer_phone,
      body,
      kind: 'confirmation',
    });

    return ok<ConfirmationResult>({ sms, body, deduped: false });
  } catch (err) {
    return fail(err, 500);
  }
}
