/**
 * Tenant directory, detail and suspension for the console. Node runtime only.
 *
 * Suspension rule: a suspended business (businesses.suspended_at) ANSWERS "out of service" (the existing out-of-service line: the caller leaves a message, the owner
 * is told) and CANNOT SEND texts, whatever its billing state, even when billing is not enforced (src/lib/db/usage.ts: checkCallAllowed / reserveSms report it as
 * `no_plan`, and isProvisioningAllowed is false). Its owners can still sign in and read their data. Reactivation clears the three columns.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { auditRowData } from '@/lib/db/audit';
import { setting } from '@/lib/config';
import { closedDatesOf } from '@/lib/closures';
import { listTenantKnobs } from './tenant-overrides';
import { MAX_REASON, MIN_REASON, SettingsError, type StoreActor } from './settings-store';

export const TENANT_PAGE_MAX = 100;

export interface TenantRow {
  id: string; name: string; status: string; billing_status: string; plan: string | null; phone: string | null; owner_email: string | null; created_at: string;
  trial_ends_at: string | null; current_period_end: string | null; past_due_since: string | null; suspended_at: string | null; comped: boolean;
  usage: { period_start: string | null; sms_count: number; call_seconds: number; forward_seconds: number; voicemail_seconds: number };
}

export interface TenantQuery {
  q?: string; status?: string; billing_status?: string; plan?: string; suspended?: boolean; comped?: boolean; past_due?: boolean;
  /** Trials ending within this many days (and not yet ended). */
  trial_ending_days?: number; limit?: number; cursor?: string; now?: Date;
}

const BILLING = ['none', 'trialing', 'active', 'past_due', 'canceled', 'unpaid'];
const STATUS = ['onboarding', 'live', 'paused'];
const cursorOf = (at: Date, id: string) => `${at.toISOString()}~${id}`;

/** Server-side search + filters + keyset pagination (newest first). `q` matches name, id prefix, phone digits, agent id, Stripe customer id and owner e-mail. */
export async function listTenants(query: TenantQuery = {}): Promise<{ items: TenantRow[]; next_cursor: string | null; total_hint: number | null }> {
  const take = Math.min(Math.max(query.limit ?? 25, 1), TENANT_PAGE_MAX);
  const now = query.now ?? new Date();
  const and: Prisma.BusinessWhereInput[] = [];
  const q = (query.q ?? '').trim().slice(0, 100);
  if (q) {
    const digits = q.replace(/\D/g, '');
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } }, { id: { startsWith: q } }, { agentId: q }, { stripeCustomerId: q },
        ...(digits.length >= 4 ? [{ phoneE164: { contains: digits } }, { ownerPhoneE164: { contains: digits } }, { phoneKey: { contains: digits } }] : []),
        { users: { some: { email: { contains: q.toLowerCase() } } } },
      ],
    });
  }
  if (query.status) { if (!STATUS.includes(query.status)) throw new SettingsError(422, 'invalid_filter', `status must be one of ${STATUS.join(', ')}`); and.push({ status: query.status }); }
  if (query.billing_status) { if (!BILLING.includes(query.billing_status)) throw new SettingsError(422, 'invalid_filter', `billing_status must be one of ${BILLING.join(', ')}`); and.push({ billingStatus: query.billing_status }); }
  if (query.plan) and.push({ plan: query.plan });
  if (query.suspended !== undefined) and.push(query.suspended ? { suspendedAt: { not: null } } : { suspendedAt: null });
  if (query.comped !== undefined) {
    const comped = (await prisma.plan.findMany({ where: { isComped: true }, select: { key: true } })).map((p) => p.key);
    and.push(query.comped ? { plan: { in: comped } } : { OR: [{ plan: null }, { plan: { notIn: comped } }] });
  }
  if (query.past_due) and.push({ billingStatus: 'past_due' });
  if (query.trial_ending_days !== undefined) and.push({ billingStatus: 'trialing', trialEndsAt: { gte: now, lte: new Date(now.getTime() + Math.max(0, query.trial_ending_days) * 86_400_000) } });
  if (query.cursor) {
    const i = query.cursor.indexOf('~');
    const at = new Date(i === -1 ? query.cursor : query.cursor.slice(0, i));
    const id = i === -1 ? null : query.cursor.slice(i + 1);
    if (Number.isNaN(at.getTime())) throw new SettingsError(422, 'invalid_cursor', 'invalid cursor');
    and.push(id ? { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] } : { createdAt: { lt: at } });
  }
  const where: Prisma.BusinessWhereInput = and.length ? { AND: and } : {};
  const rows = await prisma.business.findMany({
    where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1,
    select: {
      id: true, name: true, status: true, billingStatus: true, plan: true, phone: true, createdAt: true, trialEndsAt: true, currentPeriodEnd: true, pastDueSince: true, suspendedAt: true,
      planRef: { select: { isComped: true } }, users: { where: { role: 'owner' }, orderBy: { createdAt: 'asc' }, take: 1, select: { email: true } },
    },
  });
  const page = rows.slice(0, take);
  // the newest usage row of each business (one query for the whole page)
  const usage = page.length
    ? await prisma.$queryRaw<{ business_id: string; period_start: Date; sms_count: number; call_seconds: number; forward_seconds: number; voicemail_seconds: number }[]>`
        SELECT DISTINCT ON (business_id) business_id, period_start, sms_count, call_seconds, forward_seconds, voicemail_seconds
          FROM usage_counters WHERE business_id IN (${Prisma.join(page.map((b) => b.id))}) ORDER BY business_id, period_start DESC`
    : [];
  const u = new Map(usage.map((r) => [r.business_id, r]));
  return {
    items: page.map((b) => {
      const x = u.get(b.id);
      return {
        id: b.id, name: b.name, status: b.status, billing_status: b.billingStatus, plan: b.plan, phone: b.phone, owner_email: b.users[0]?.email ?? null, created_at: b.createdAt.toISOString(),
        trial_ends_at: b.trialEndsAt?.toISOString() ?? null, current_period_end: b.currentPeriodEnd?.toISOString() ?? null, past_due_since: b.pastDueSince?.toISOString() ?? null,
        suspended_at: b.suspendedAt?.toISOString() ?? null, comped: b.planRef?.isComped ?? false,
        usage: { period_start: x ? x.period_start.toISOString().slice(0, 10) : null, sms_count: x?.sms_count ?? 0, call_seconds: x?.call_seconds ?? 0, forward_seconds: x?.forward_seconds ?? 0, voicemail_seconds: x?.voicemail_seconds ?? 0 },
      };
    }),
    next_cursor: rows.length > take ? cursorOf(page[page.length - 1].createdAt, page[page.length - 1].id) : null,
    total_hint: null,
  };
}

/** Everything the tenant page shows. Provider ids are read-only; no secrets exist on a tenant. */
export async function getTenantDetail(id: string): Promise<Record<string, unknown> | null> {
  const b = await prisma.business.findUnique({ where: { id }, include: { planRef: true } });
  if (!b) return null;
  const [owners, audit, grants, usage, knobs] = await Promise.all([
    prisma.user.findMany({ where: { OR: [{ businessId: id }, { memberships: { some: { businessId: id } } }] }, select: { id: true, email: true, role: true, disabledAt: true, totpEnabledAt: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 50 }),
    prisma.auditEvent.findMany({ where: { businessId: id }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 25 }),
    prisma.supportGrant.findMany({ where: { businessId: id }, orderBy: { startedAt: 'desc' }, take: 10 }),
    prisma.usageCounter.findFirst({ where: { businessId: id }, orderBy: { periodStart: 'desc' } }),
    listTenantKnobs(id, 'platform'),
  ]);
  return {
    id: b.id, name: b.name, status: b.status, timezone: b.timezone, vertical: b.vertical, locale_default: b.localeDefault, created_at: b.createdAt.toISOString(), closed_dates: closedDatesOf(b.closedDates),
    contact: { phone: b.phone, owner_phone: b.ownerPhone, owner_name: b.ownerName, owner_phone_verified: b.ownerPhoneVerifiedAt !== null },
    provider_ids: { agent_id: b.agentId, elevenlabs_phone_number_id: b.elevenlabsPhoneNumberId, twilio_phone_sid: b.twilioPhoneSid, stripe_customer_id: b.stripeCustomerId, stripe_subscription_id: b.stripeSubscriptionId },
    billing: {
      status: b.billingStatus, plan: b.plan, plan_comped: b.planRef?.isComped ?? false, interval: b.billingInterval, trial_ends_at: b.trialEndsAt?.toISOString() ?? null, current_period_end: b.currentPeriodEnd?.toISOString() ?? null,
      past_due_since: b.pastDueSince?.toISOString() ?? null, sms_cap_override: b.smsCapOverride, call_minutes_cap_override: b.callMinutesCapOverride,
    },
    call_mode: b.callMode,
    suspension: { suspended: b.suspendedAt !== null, suspended_at: b.suspendedAt?.toISOString() ?? null, reason: b.suspendedReason, by: b.suspendedBy },
    users: owners.map((u) => ({ id: u.id, email: u.email, role: u.role, disabled: u.disabledAt !== null, two_factor: u.totpEnabledAt !== null, created_at: u.createdAt.toISOString() })),
    usage: usage ? { period_start: usage.periodStart.toISOString().slice(0, 10), sms_count: usage.smsCount, call_seconds: usage.callSeconds, forward_seconds: usage.forwardSeconds, voicemail_seconds: usage.voicemailSeconds } : null,
    overrides: knobs,
    support_grants: grants.map((g) => ({ id: g.id, user_id: g.userId, reason: g.reason, started_at: g.startedAt.toISOString(), expires_at: g.expiresAt.toISOString(), ended_at: g.endedAt?.toISOString() ?? null })),
    audit: audit.map((a) => ({ id: a.id, at: a.at.toISOString(), action: a.action, actor_kind: a.actorKind, actor_user_id: a.actorUserId, target: a.target, meta: a.meta })),
    platform: { default_vertical: setting('defaults.vertical') },
  };
}

const reasonOf = (r: unknown): string => {
  const t = typeof r === 'string' ? r.trim() : '';
  if (t.length < MIN_REASON || t.length > MAX_REASON) throw new SettingsError(422, 'reason_required', `a reason of ${MIN_REASON} to ${MAX_REASON} characters is required`);
  return t;
};

export async function suspendBusiness(opts: { business_id: string; reason: unknown; actor: StoreActor; support_grant_id?: string | null }): Promise<{ suspended_at: string }> {
  const reason = reasonOf(opts.reason);
  const now = new Date();
  const by = opts.actor.user_id ?? opts.actor.kind;
  const res = await prisma.business.updateMany({ where: { id: opts.business_id, suspendedAt: null }, data: { suspendedAt: now, suspendedReason: reason, suspendedBy: by } });
  if (res.count === 0) {
    const b = await prisma.business.findUnique({ where: { id: opts.business_id }, select: { suspendedAt: true } });
    if (!b) throw new SettingsError(404, 'not_found', 'business not found');
    throw new SettingsError(409, 'already_suspended', 'the business is already suspended');
  }
  await prisma.auditEvent.create({ data: auditRowData({ actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, business_id: opts.business_id, action: 'tenant.suspended', target: `business:${opts.business_id}`, ip: opts.actor.ip, at: now, meta: { reason, role: opts.actor.role, via: opts.actor.via }, meta_trusted: true }) });
  return { suspended_at: now.toISOString() };
}

export async function reactivateBusiness(opts: { business_id: string; reason: unknown; actor: StoreActor }): Promise<void> {
  const reason = reasonOf(opts.reason);
  const res = await prisma.business.updateMany({ where: { id: opts.business_id, suspendedAt: { not: null } }, data: { suspendedAt: null, suspendedReason: null, suspendedBy: null } });
  if (res.count === 0) {
    if (!(await prisma.business.findUnique({ where: { id: opts.business_id }, select: { id: true } }))) throw new SettingsError(404, 'not_found', 'business not found');
    throw new SettingsError(409, 'not_suspended', 'the business is not suspended');
  }
  await prisma.auditEvent.create({ data: auditRowData({ actor_kind: opts.actor.kind, actor_user_id: opts.actor.user_id, business_id: opts.business_id, action: 'tenant.reactivated', target: `business:${opts.business_id}`, ip: opts.actor.ip, meta: { reason, role: opts.actor.role, via: opts.actor.via }, meta_trusted: true }) });
}
