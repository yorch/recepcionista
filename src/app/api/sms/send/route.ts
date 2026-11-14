import { fail, ok, readJson } from '@/lib/http';
import { sendAndLog } from '@/lib/messaging';
import type { SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await readJson<{
      business_id: string; to: string; body: string; kind?: SmsLog['kind'];
    }>(req);
    if (!body.business_id || !body.to || !body.body) {
      return fail('business_id, to and body are required', 422);
    }
    const result = await sendAndLog({
      business_id: body.business_id,
      to: body.to,
      body: body.body,
      kind: body.kind ?? 'other',
    });
    return ok(result.sms);
  } catch (err) {
    return fail(err, 500);
  }
}
