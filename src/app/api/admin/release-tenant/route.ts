import { ok, fail, readJson } from '@/lib/http';
import { authenticate } from '@/lib/session';
import { limitRequest } from '@/lib/ratelimit';
import { DEFAULT_GRACE_DAYS, DEFAULT_NOTIFY_DAYS, processBusiness } from '@/lib/billing/release';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const int = (v: unknown, dflt: number): number | null => (v === undefined ? dflt : typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3650 ? v : null);

/**
 * Admin-only: release ONE canceled/unpaid business's provider resources (Twilio number, ElevenLabs agent and tools).
 * `{ business_id, dry_run?: true, grace_days?: 30, notify_days?: 7, include_recent?: false, skip_notice?: false }`.
 * `dry_run` defaults to TRUE: the response says what WOULD happen (skip with the reason, wait, send the heads-up, release)
 * and nothing is sent, deleted or written; only `"dry_run": false` acts. It applies the same safety rules as
 * scripts/release-canceled-tenants.ts (only canceled/unpaid, not comped, no recent calls, never a shared number or agent);
 * with `dry_run:false` one call performs ONE step (send the heads-up, or release when due). `skip_notice: true` is the explicit admin
 * override of the heads-up wait (audited). Audited as billing.release_notice / billing.tenant_released.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'admin/release-tenant', 20);
  if (limited) return limited;
  try {
    const body = await readJson<Record<string, unknown>>(req).catch(() => null);
    if (!body || typeof body !== 'object') return fail('invalid body', 422);
    if (typeof body.business_id !== 'string' || !body.business_id) return fail('business_id is required', 422);
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return fail('dry_run must be true or false', 422);
    for (const k of ['include_recent', 'skip_notice'] as const) if (body[k] !== undefined && typeof body[k] !== 'boolean') return fail(`${k} must be true or false`, 422);
    const graceDays = int(body.grace_days, DEFAULT_GRACE_DAYS);
    const notifyDays = int(body.notify_days, DEFAULT_NOTIFY_DAYS);
    if (graceDays === null || notifyDays === null) return fail('grace_days and notify_days must be integers between 0 and 3650', 422);
    const dryRun = body.dry_run !== false;
    const user = auth.principal.kind === 'admin' ? auth.principal.user : null;
    const report = await processBusiness(body.business_id, {
      apply: !dryRun, graceDays, notifyDays, includeRecent: body.include_recent === true, skipNotice: body.skip_notice === true,
      actor: user ? { kind: 'user', user_id: user.id } : { kind: 'admin_token' },
    });
    if (!report) return fail('business not found', 404);
    return ok({ dry_run: dryRun, ...report });
  } catch (err) {
    return fail(err, 500);
  }
}
