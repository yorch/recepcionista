import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { getBooking } from '@/lib/db';
import { sendConfirmation, ActionError } from '@/lib/messaging/actions';
import type { Lang } from '@/lib/messaging/templates';
import type { SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

export interface ConfirmationResult {
  sms: SmsLog;
  body: string;
  deduped: boolean;
}

export async function POST(req: Request) {
  const auth = await authenticate(req); // templated message about an existing booking: staff+
  if (!auth.ok) return auth.response;
  try {
    const { booking_id, language } = await readJson<{ booking_id?: string; language?: Lang }>(req);
    if (!booking_id) return fail('booking_id is required', 422);
    const booking = await getBooking(booking_id);
    if (!booking) return fail('booking not found', 404);
    requireBusinessAccess(auth.principal, booking.business_id);
    return ok<ConfirmationResult>(await sendConfirmation(booking_id, language ?? 'en'));
  } catch (err) {
    if (err instanceof ActionError) return fail(err.message, err.status);
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
