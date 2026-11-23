import { fail, ok, readJson } from '@/lib/http';
import { guardAdmin } from '@/lib/admin-guard';
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
  const denied = await guardAdmin();
  if (denied) return denied;
  try {
    const { booking_id, language } = await readJson<{ booking_id?: string; language?: Lang }>(req);
    if (!booking_id) return fail('booking_id is required', 422);
    return ok<ConfirmationResult>(await sendConfirmation(booking_id, language ?? 'en'));
  } catch (err) {
    if (err instanceof ActionError) return fail(err.message, err.status);
    return fail(err, 500);
  }
}
