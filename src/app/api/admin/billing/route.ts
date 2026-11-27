import { ok, fail, readJson } from '@/lib/http';
import { authenticate, requireRecentAuth } from '@/lib/session';
import { adminBillingValues } from '@/lib/billing/admin-audit';
import { getBusiness, recordAudit, setBillingState, type BillingPatch } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import { billingErrorResponse } from '@/lib/billing/http';
import { billingSummary } from '@/lib/billing/summary';
import type { BillingStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUSES: readonly BillingStatus[] = ['none', 'trialing', 'active', 'past_due', 'canceled', 'unpaid'];

/** A date field: ISO string, or null to clear. Returns undefined when invalid. */
function dateField(v: unknown): Date | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function capField(v: unknown): number | null | undefined {
  if (v === null) return null; // back to the plan default
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : undefined;
}

/**
 * Admin-only: comp or adjust an account without Stripe (grandfathering existing tenants, support).
 * Body: `{ business_id, billing_status?, plan?, trial_ends_at?, current_period_end?, sms_cap_override?, call_minutes_cap_override?, note? }`.
 * `null` clears plan / dates / caps. Does not touch Stripe ids; a later Stripe event for a linked customer
 * can overwrite the status again, so comp accounts should have no subscription. Audited (meta.from / meta.to carry the values). Step-up (`requireRecentAuth`) for cookie sessions.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, { role: 'admin' });
  if (!auth.ok) return auth.response;
  const limited = await limitRequest(req, 'admin/billing', 30);
  if (limited) return limited;
  const stale = requireRecentAuth(auth); // step-up (5 min) for the cookie session; the Bearer ADMIN_TOKEN passes
  if (stale) return stale;
  try {
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object') return fail('invalid body', 422);
    if (typeof body.business_id !== 'string' || !body.business_id) return fail('business_id is required', 422);
    const business = await getBusiness(body.business_id);
    if (!business) return fail('business not found', 404);

    const patch: BillingPatch = {};
    if (body.billing_status !== undefined) {
      if (!STATUSES.includes(body.billing_status as BillingStatus)) return fail(`billing_status must be one of ${STATUSES.join(', ')}`, 422);
      patch.billing_status = body.billing_status as BillingStatus;
    }
    if (body.plan !== undefined) {
      if (body.plan !== null && (typeof body.plan !== 'string' || !body.plan.trim() || body.plan.length > 60)) return fail('plan must be a short string or null', 422);
      patch.plan = body.plan === null ? null : (body.plan as string).trim();
    }
    for (const key of ['trial_ends_at', 'current_period_end'] as const) {
      if (body[key] === undefined) continue;
      const d = dateField(body[key]);
      if (d === undefined) return fail(`${key} must be an ISO date string or null`, 422);
      patch[key] = d;
    }
    for (const key of ['sms_cap_override', 'call_minutes_cap_override'] as const) {
      if (body[key] === undefined) continue;
      const n = capField(body[key]);
      if (n === undefined) return fail(`${key} must be a non-negative integer or null`, 422);
      patch[key] = n;
    }
    if (Object.keys(patch).length === 0) return fail('nothing to change', 422);
    const note = typeof body.note === 'string' ? body.note.slice(0, 300) : undefined;

    const updated = await setBillingState(business.id, patch);
    if (!updated) return fail('business not found', 404);
    await recordAudit({
      actor_kind: auth.principal.kind === 'admin' && auth.principal.user ? 'user' : 'admin_token',
      actor_user_id: auth.principal.kind === 'admin' ? auth.principal.user?.id ?? null : null,
      business_id: business.id, action: 'billing.admin_override', target: `business:${business.id}`,
      meta: {
        changed: Object.keys(patch),
        // Every changeable field before and after (status, plan, dates, caps), sanitized: the audit row says WHAT the new caps / dates are.
        from: adminBillingValues(business),
        to: adminBillingValues(updated),
        ...(note ? { note } : {}),
      },
    });
    return ok(await billingSummary(updated));
  } catch (err) {
    return billingErrorResponse(err);
  }
}
