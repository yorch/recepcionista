import { fail, ok, readJson } from '@/lib/http';
import { sendAndLog } from '@/lib/messaging';
import type { SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

const KINDS: SmsLog['kind'][] = [
  'confirmation', 'payment_link', 'gratitude', 'review_request', 'owner_alert', 'other',
];

/** Escape hatch for the voice agent's send_sms tool: raw text, still logged. */
export async function POST(req: Request) {
  try {
    const body = await readJson<{
      business_id: string; to: string; body: string; kind?: SmsLog['kind'];
    }>(req);
    if (!body.business_id || !body.to || !body.body) {
      return fail('business_id, to and body are required', 422);
    }
    const kind = body.kind && KINDS.includes(body.kind) ? body.kind : 'other';
    const { sms } = await sendAndLog({
      business_id: body.business_id,
      to: body.to,
      body: body.body,
      kind,
    });
    return ok(sms);
  } catch (err) {
    return fail(err, 500);
  }
}
