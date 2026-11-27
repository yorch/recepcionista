import { ok } from '@/lib/http';
import { guardAdminRoute, adminFail, int } from '@/lib/admin/guard';
import { smsDeliveryOverview } from '@/lib/admin/deliveries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * SMS delivery failures: the carrier-side failures Twilio reports through the status callback (audit `sms.delivery_failed`: error code, status, kind; never the text), the
 * send-time failures and policy blocks of `sms_log`, per error code (with its failure class and retry guidance), per tenant and per day.
 * GET ?days=1..90 (default 7)&business_id=&code=<error code | none>&before=<cursor>&limit=1..100. Permission: audit.read. Read only.
 */
export async function GET(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'audit.read', rate: { name: 'deliveries-sms', max: 60 } });
  if (!g.ok) return g.response;
  try {
    const q = new URL(req.url).searchParams;
    return ok(await smsDeliveryOverview({ days: int(q.get('days'), 7, 1, 90), business_id: q.get('business_id') || undefined, code: q.get('code') || undefined, before: q.get('before') || undefined, limit: int(q.get('limit'), 25, 1, 100) }));
  } catch (err) { return adminFail(err); }
}
