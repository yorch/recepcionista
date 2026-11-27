import { ok, fail, readJson } from '@/lib/http';
import { requireRecentAuth } from '@/lib/session';
import { adminFail, guardAdminRoute } from '@/lib/admin/guard';
import { getBusiness, recordAudit } from '@/lib/db';
import { isBreakGlass } from '@/lib/admin/permissions';
import { requireConfirmPhrase, requireReason, tenantPhraseOf, TENANT_VERBS } from '@/lib/admin/confirm';
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
 * override of the heads-up wait (audited). A real release from a console session needs `reason` and `confirm` (the phrase `release <business name>`); the Bearer token does not. Audited as billing.release_notice / billing.tenant_released.
 */
export async function POST(req: Request) {
  const g = await guardAdminRoute(req, { permission: 'tenants.release', rate: { name: 'release-tenant', max: 20 } }); // permission tenants.release
  if (!g.ok) return g.response;
  const auth = g.ctx.auth;
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
    if (!dryRun) { // a real release (irreversible) needs a recent proof of identity from a cookie session; a dry run is read-only
      const stale = requireRecentAuth(auth);
      if (stale) return stale;
    }
    if (!dryRun && !isBreakGlass(g.ctx.principal)) { // a console session: a written reason and the typed phrase `release <business name>`, enforced here (the Bearer script is audited and mailed per use)
      requireReason(body.reason);
      const biz = await getBusiness(body.business_id);
      if (!biz) return fail('business not found', 404);
      requireConfirmPhrase(body.confirm, TENANT_VERBS.release.map((v) => tenantPhraseOf(v, biz.name)));
    }
    const user = auth.principal.kind === 'admin' ? auth.principal.user : null;
    const report = await processBusiness(body.business_id, {
      apply: !dryRun, graceDays, notifyDays, includeRecent: body.include_recent === true, skipNotice: body.skip_notice === true,
      actor: user ? { kind: 'user', user_id: user.id } : { kind: 'admin_token' },
    });
    if (!report) return fail('business not found', 404);
    // The console asks for a written reason before a real release (critical tier): it is recorded next to the release rows.
    if (!dryRun && typeof body.reason === 'string' && body.reason.trim()) {
      await recordAudit({ actor_kind: user ? 'user' : 'admin_token', actor_user_id: user?.id ?? null, business_id: body.business_id, action: 'billing.release_reason', target: `business:${body.business_id}`, meta: { reason: body.reason.trim().slice(0, 500), role: g.ctx.role } });
    }
    return ok({ dry_run: dryRun, ...report });
  } catch (err) {
    return adminFail(err);
  }
}
