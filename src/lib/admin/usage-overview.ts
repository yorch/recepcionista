/**
 * Usage and revenue overview (server only): tenants by status / billing state / plan, an MRR ESTIMATE from the plans' Stripe prices, this month's usage against the caps
 * the metering enforces (the same `smsCapFor` & co), and the trials about to end. Everything is read from the database; the only outside read is the cached Stripe price
 * (`fetchPlanPrice`, fail soft: no price means no MRR figure, never a made-up one).
 */
import { configEnv } from '@/lib/config';
import { prisma } from '@/lib/db/client';
import { loadTenantOverridesMany } from './tenant-knobs';
import { callMinutesCapFor, forwardMinutesCapFor, smsCapFor, usagePercent, voicemailMinutesCap } from '@/lib/db/usage';
import { fetchPlanPrice, type PlanPriceInfo } from '@/lib/billing/price';
import { annualPriceId } from '@/lib/providers/stripe-billing';
import { isCompedPlan } from './plan-catalog';
import type { CapUsage, UsageOverview } from './ops-model';

const MAX_USAGE_ROWS = 5000;

export interface UsageDeps { fetchPrice?: (id: string | null | undefined) => Promise<PlanPriceInfo | null>; now?: Date; env?: NodeJS.ProcessEnv }

/** Monthly equivalent (minor units) of a recurring price. */
export const monthlyCents = (p: PlanPriceInfo): number => Math.round(p.interval === 'year' ? p.amount_cents / (12 * p.interval_count) : p.amount_cents / p.interval_count);

const cap = (): CapUsage => ({ used: 0, over_80: 0, over_100: 0 });
const bump = (c: CapUsage, used: number, limit: number) => {
  c.used += used;
  const pct = usagePercent(used, limit);
  if (pct >= 80) c.over_80++;
  if (pct >= 100) c.over_100++;
};

export async function usageOverview(deps: UsageDeps = {}): Promise<UsageOverview> {
  const now = deps.now ?? new Date();
  const env = deps.env ?? configEnv();
  const fetchPrice = deps.fetchPrice ?? fetchPlanPrice;

  const [byStatus, byBilling, byPlan, suspended, trialStats, upcoming, payingRows, planTable] = await Promise.all([
    prisma.business.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.business.groupBy({ by: ['billingStatus'], _count: { _all: true } }),
    prisma.business.groupBy({ by: ['plan'], _count: { _all: true } }),
    prisma.business.count({ where: { suspendedAt: { not: null } } }),
    prisma.$queryRaw<{ trialing: number; d7: number; d3: number; expired: number }[]>`
      SELECT count(*) FILTER (WHERE billing_status = 'trialing')::int AS trialing,
             count(*) FILTER (WHERE billing_status = 'trialing' AND trial_ends_at >= ${now} AND trial_ends_at < ${new Date(now.getTime() + 7 * 86_400_000)})::int AS d7,
             count(*) FILTER (WHERE billing_status = 'trialing' AND trial_ends_at >= ${now} AND trial_ends_at < ${new Date(now.getTime() + 3 * 86_400_000)})::int AS d3,
             count(*) FILTER (WHERE billing_status = 'trialing' AND trial_ends_at < ${now})::int AS expired
        FROM businesses`,
    prisma.business.findMany({ where: { billingStatus: 'trialing', trialEndsAt: { gte: now, lt: new Date(now.getTime() + 7 * 86_400_000) } }, orderBy: { trialEndsAt: 'asc' }, take: 15, select: { id: true, name: true, trialEndsAt: true, plan: true } }),
    prisma.business.groupBy({ by: ['plan', 'billingInterval', 'billingStatus'], where: { billingStatus: { in: ['active', 'past_due'] }, suspendedAt: null }, _count: { _all: true } }),
    prisma.plan.findMany({ select: { key: true, isComped: true, stripePriceId: true, stripePriceIdAnnual: true } }), // the table itself: authoritative on every instance (the in-memory catalog is only a cache)
  ]);
  const planByKey = new Map(planTable.map((p) => [p.key, p]));
  const comped = (key: string | null): boolean => (key ? planByKey.get(key)?.isComped ?? isCompedPlan(key) : false);

  // ---- tenants
  const total = byStatus.reduce((n, r) => n + r._count._all, 0);
  const plans = byPlan.map((r) => ({ plan: r.plan ?? 'none', count: r._count._all, comped: comped(r.plan) })).sort((a, b) => b.count - a.count);
  const compedCount = plans.filter((p) => p.comped).reduce((n, p) => n + p.count, 0);

  // ---- revenue: active, non-comped, non-suspended businesses x the monthly equivalent of their plan's price
  const priceCache = new Map<string, PlanPriceInfo | null>();
  const price = async (id: string | null | undefined): Promise<PlanPriceInfo | null> => {
    if (!id) return null;
    if (!priceCache.has(id)) priceCache.set(id, await fetchPrice(id).catch(() => null));
    return priceCache.get(id) ?? null;
  };
  const platformMonthly = env.STRIPE_PRICE_ID?.trim() || null;
  const platformAnnual = annualPriceId(env) ?? null;
  const perPlan = new Map<string, { plan: string; paying: number; cents: number | null; source: 'plan' | 'platform' | 'none'; unknown: boolean; sub: number }>();
  let paying = 0;
  let pastDue = 0;
  let currency: string | null = null;
  for (const r of payingRows) {
    const plan = r.plan ?? 'none';
    if (comped(r.plan)) continue;
    const n = r._count._all;
    if (r.billingStatus === 'past_due') { pastDue += n; continue; }
    paying += n;
    const row = planByKey.get(plan);
    const annual = r.billingInterval === 'year';
    const own = annual ? row?.stripePriceIdAnnual : row?.stripePriceId;
    const fallback = annual ? platformAnnual : platformMonthly;
    const source: 'plan' | 'platform' | 'none' = own ? 'plan' : fallback ? 'platform' : 'none';
    const p = await price(own || fallback);
    const entry = perPlan.get(plan) ?? { plan, paying: 0, cents: null, source, unknown: false, sub: 0 };
    entry.paying += n;
    if (p) { entry.sub += monthlyCents(p) * n; entry.cents = monthlyCents(p); currency ??= p.currency; } else entry.unknown = true;
    if (entry.source === 'none') entry.source = source;
    perPlan.set(plan, entry);
  }
  const mrrBy = [...perPlan.values()].map((e) => ({ plan: e.plan, paying: e.paying, monthly_cents: e.cents, subtotal_cents: e.unknown && e.sub === 0 ? null : e.sub, price_source: e.source })).sort((a, b) => b.paying - a.paying);
  const priced = mrrBy.some((e) => e.subtotal_cents !== null);
  const mrr = priced ? mrrBy.reduce((n, e) => n + (e.subtotal_cents ?? 0), 0) : paying === 0 ? 0 : null;

  // ---- usage this month (the latest counter row of each business, current month in its own time zone)
  const monthFloor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 86_400_000);
  const rows = await prisma.$queryRaw<{ business_id: string; period_start: Date; sms: number; call_s: number; vm_s: number; fwd_s: number; name: string; plan: string | null; billing_status: string; sms_o: number | null; call_o: number | null }[]>`
    SELECT DISTINCT ON (u.business_id) u.business_id, u.period_start, u.sms_count AS sms, u.call_seconds AS call_s, u.voicemail_seconds AS vm_s, u.forward_seconds AS fwd_s,
           b.name, b.plan, b.billing_status, b.sms_cap_override AS sms_o, b.call_minutes_cap_override AS call_o
      FROM usage_counters u JOIN businesses b ON b.id = u.business_id
     WHERE u.period_start >= ${monthFloor}::date
     ORDER BY u.business_id, u.period_start DESC LIMIT ${MAX_USAGE_ROWS}`;
  const sms = cap(); const ai = cap(); const fwd = cap(); const vm = cap();
  const top: UsageOverview['top_usage'] = [];
  let periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const overridesOf = await loadTenantOverridesMany(rows.map((r) => r.business_id));
  for (const r of rows) {
    const subject = { billing_status: r.billing_status, plan: r.plan, tenant_overrides: overridesOf.get(r.business_id) ?? null };
    const smsCap = smsCapFor({ ...subject, sms_cap_override: r.sms_o }, env);
    const aiCap = callMinutesCapFor({ ...subject, call_minutes_cap_override: r.call_o }, env);
    const aiMin = Math.floor(r.call_s / 60);
    bump(sms, r.sms, smsCap);
    bump(ai, aiMin, aiCap);
    bump(fwd, Math.floor(r.fwd_s / 60), forwardMinutesCapFor(subject, env));
    bump(vm, Math.floor(r.vm_s / 60), voicemailMinutesCap(env, r.plan, subject.tenant_overrides));
    top.push({ business_id: r.business_id, name: r.name, sms: r.sms, sms_cap: smsCap, ai_minutes: aiMin, ai_cap: aiCap });
    if (r.period_start.toISOString().slice(0, 10) > periodStart) periodStart = r.period_start.toISOString().slice(0, 10);
  }
  top.sort((a, b) => Math.max(usagePercent(b.sms, b.sms_cap), usagePercent(b.ai_minutes, b.ai_cap)) - Math.max(usagePercent(a.sms, a.sms_cap), usagePercent(a.ai_minutes, a.ai_cap)));

  const t = trialStats[0] ?? { trialing: 0, d7: 0, d3: 0, expired: 0 };
  return {
    generated_at: now.toISOString(),
    tenants: { total, by_status: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])), by_billing: Object.fromEntries(byBilling.map((r) => [r.billingStatus, r._count._all])), by_plan: plans, suspended, comped: compedCount },
    revenue: { paying, past_due: pastDue, currency, mrr_cents: mrr, mrr_by_plan: mrrBy, note: 'estimate_monthly_price' },
    usage: { period_start: periodStart, businesses_with_usage: rows.length, sms, ai_minutes: ai, forward_minutes: fwd, voicemail_minutes: vm },
    trials: { trialing: t.trialing, ending_7d: t.d7, ending_3d: t.d3, expired_unconverted: t.expired, upcoming: upcoming.map((b) => ({ business_id: b.id, name: b.name, trial_ends_at: (b.trialEndsAt as Date).toISOString(), plan: b.plan })) },
    top_usage: top.slice(0, 10),
  };
}
