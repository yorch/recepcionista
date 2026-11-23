import { fail, ok, readJson } from '@/lib/http';
import { guardAdmin } from '@/lib/admin-guard';
import { sendAndLog } from '@/lib/messaging';
import { getBusiness, listBookings, listCalls } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import { normalizePhone } from '@/lib/providers/twilio';
import { validateRecipient } from '@/lib/messaging/recipient';
import type { SmsLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

const KINDS: SmsLog['kind'][] = [
  'confirmation', 'payment_link', 'gratitude', 'review_request', 'owner_alert', 'other',
];

const MAX_BODY_CHARS = 480;

const digits = (p?: string | null) => (p ?? '').replace(/\D/g, '');

/** Admin-only escape hatch: raw text to a known contact of the business, still logged. */
export async function POST(req: Request) {
  const denied = await guardAdmin();
  if (denied) return denied;
  const limited = limitRequest(req, 'sms/send', 10);
  if (limited) return limited;
  try {
    const body = await readJson<{
      business_id: string; to: string; body: string; kind?: SmsLog['kind'];
    }>(req);
    if (typeof body.business_id !== 'string' || typeof body.to !== 'string' || typeof body.body !== 'string'
      || !body.business_id || !body.to || !body.body.trim()) {
      return fail('business_id, to and body are required', 422);
    }
    if (body.body.length > MAX_BODY_CHARS) return fail(`body must be at most ${MAX_BODY_CHARS} characters`, 422);

    const check = validateRecipient(body.to);
    if (!check.ok) return fail(check.error, 422);
    const to = check.to;
    const d = digits(to);

    const business = await getBusiness(body.business_id);
    if (!business) return fail('business not found', 404);

    // Only known contacts: the owner, a booking customer, or a past caller.
    const known = new Set<string>();
    if (business.owner_phone) known.add(digits(normalizePhone(business.owner_phone)));
    for (const b of await listBookings(business.id)) if (b.customer_phone) known.add(digits(normalizePhone(b.customer_phone)));
    for (const c of await listCalls(business.id)) if (c.caller_phone) known.add(digits(normalizePhone(c.caller_phone)));
    if (!known.has(d)) return fail('recipient is not a known contact of this business', 403);

    const kind = body.kind && KINDS.includes(body.kind) ? body.kind : 'other';
    const { sms } = await sendAndLog({ business_id: business.id, to, body: body.body, kind });
    return ok(sms);
  } catch (err) {
    return fail(err, 500);
  }
}
