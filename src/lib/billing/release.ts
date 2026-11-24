/**
 * Release provider resources (Twilio number, ElevenLabs agent and tools) of tenants that stopped paying.
 * Shared by scripts/release-canceled-tenants.ts (all businesses) and POST /api/admin/release-tenant (one business).
 * Node runtime only. docs/billing.md ("Releasing canceled tenants") and docs/runbook.md describe the operator side.
 *
 * Timeline for a business with billing_status canceled/unpaid (R = release date):
 *   since  = the later of current_period_end (or trial_ends_at) and the last admin comp/override
 *   R      = since + graceDays
 *   notice = the owners get a heads-up e-mail once now >= R - notifyDays (audit row `billing.release_notice`, which carries
 *            `notified_at` so the mail is never sent twice for the same cancellation)
 *   release only when now >= R AND now >= notified_at + notifyDays; so a script run that is late never mails and releases in
 *   the same breath (unless notifyDays is 0, which turns the notice off).
 * Never touched: admin-comped, trialing/active/past_due/none businesses, ones with REAL calls in the last 7 days (unless
 * includeRecent; out-of-service/blocked calls, hang-ups and calls with no transcript, booking or RECENT_CALL_MIN_SECONDS do not count), a number or agent that another business also uses, and the platform's own TWILIO_PHONE_NUMBER.
 */
import { prisma } from '@/lib/db/client';
import { clearBusinessProviderResources, recordAudit, withLease } from '@/lib/db';
import { notifyOwners } from '@/lib/billing/emails';
import { releaseNumber, type ReleaseNumberResult } from '@/lib/providers/twilio';
import { deleteAgent, deleteAgentTools, type ReleaseAgentResult, type ReleaseToolsResult } from '@/lib/voice/elevenlabs';
import { logger } from '@/lib/log';

const log = logger('billing.release');

export const DEFAULT_GRACE_DAYS = 30;
export const DEFAULT_NOTIFY_DAYS = 7;
export const RECENT_CALL_DAYS = 7;
/** A call only counts as "recent activity" when it was actually answered or forwarded for at least this long (or has a transcript/booking). */
export const RECENT_CALL_MIN_SECONDS = 15;
export const NOTICE_ACTION = 'billing.release_notice';
export const RELEASED_ACTION = 'billing.tenant_released';
/** Plans that mark an admin-comped (free by decision) business. */
export const COMP_PLANS: readonly string[] = ['legacy', 'grandfathered'];
const DAY_MS = 24 * 60 * 60_000;
/** Releases and provisioning of one business exclude each other through this lease (same key as the provision route). */
const RELEASE_LEASE_MS = 90_000;
export const businessLeaseKey = (businessId: string): string => `provision:${businessId}`;

export interface ReleaseOptions {
  now?: Date;
  graceDays?: number;
  notifyDays?: number;
  includeRecent?: boolean;
  /** Admin override: release without waiting for / sending the heads-up (still audited as notice_skipped). */
  skipNotice?: boolean;
}

export interface ReleaseFacts {
  id: string;
  name: string;
  billing_status: string;
  plan: string | null;
  /** current_period_end, else trial_ends_at. */
  period_end: Date | null;
  last_comp_at: Date | null;
  phone: string | null;
  phone_e164: string | null;
  agent_id: string | null;
  recent_calls: number;
  /** When the heads-up for the CURRENT cancellation was sent (null = never). */
  notified_at: Date | null;
  has_owner_email: boolean;
  phone_shared: boolean;
  agent_shared: boolean;
  /** Another business still has an agent (the workspace tools are shared and must stay). */
  other_agents_exist: boolean;
}

export type ReleaseDecision =
  | { action: 'skip'; reason: string }
  | { action: 'wait'; reason: string; until: Date }
  | { action: 'notify'; release_on: Date }
  | { action: 'release'; notice: 'sent' | 'off' | 'skipped' };

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

/** The date the grace period ends (R), or null when it cannot be dated. */
export function releaseDate(f: Pick<ReleaseFacts, 'period_end' | 'last_comp_at'>, graceDays: number): Date | null {
  if (!f.period_end) return null;
  const since = f.last_comp_at && f.last_comp_at > f.period_end ? f.last_comp_at : f.period_end;
  return addDays(since, graceDays);
}

/** Pure decision for one business. See the timeline in the file header. */
export function decideRelease(f: ReleaseFacts, o: ReleaseOptions = {}): ReleaseDecision {
  const now = o.now ?? new Date();
  const graceDays = o.graceDays ?? DEFAULT_GRACE_DAYS;
  const notifyDays = o.notifyDays ?? DEFAULT_NOTIFY_DAYS;
  const skip = (reason: string): ReleaseDecision => ({ action: 'skip', reason });
  if (f.billing_status !== 'canceled' && f.billing_status !== 'unpaid') return skip(`billing status is ${f.billing_status} (only canceled/unpaid are released)`);
  if (f.plan && COMP_PLANS.includes(f.plan)) return skip(`admin-comped plan "${f.plan}"`);
  if (!f.phone && !f.agent_id) return skip('nothing to release (no number or agent)');
  const R = releaseDate(f, graceDays);
  if (!R) return skip('no current_period_end/trial_ends_at recorded: cannot date the cancellation (set it with POST /api/admin/billing first)');
  if (f.recent_calls > 0 && !o.includeRecent) return skip(`${f.recent_calls} call(s) in the last ${RECENT_CALL_DAYS} days (use --include-recent)`);
  const noticeOn = addDays(R, -notifyDays);
  const noticeRequired = notifyDays > 0 && !o.skipNotice;
  if (!noticeRequired) {
    return now < R ? { action: 'wait', reason: `grace period (${graceDays} days) not over`, until: R } : { action: 'release', notice: o.skipNotice ? 'skipped' : 'off' };
  }
  if (!f.notified_at) {
    if (now < noticeOn) return { action: 'wait', reason: `heads-up goes out ${notifyDays} days before release`, until: noticeOn };
    if (!f.has_owner_email) return skip('no active owner with an email address to notify (use the admin API with skip_notice after contacting them)');
    return { action: 'notify', release_on: new Date(Math.max(R.getTime(), addDays(now, notifyDays).getTime())) };
  }
  const earliest = new Date(Math.max(R.getTime(), addDays(f.notified_at, notifyDays).getTime()));
  if (now < earliest) return { action: 'wait', reason: `notified ${f.notified_at.toISOString().slice(0, 10)}; ${notifyDays}-day notice period not over`, until: earliest };
  return { action: 'release', notice: 'sent' };
}

/**
 * Calls since `since` that were really handled: NOT refused at the gate (flagged_reason out_of_service:*, which every robocall to a
 * canceled line produces) and that either lasted RECENT_CALL_MIN_SECONDS, left a transcript or summary, or produced a booking.
 */
export async function countRecentRealCalls(businessId: string, since: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "calls" c
     WHERE c."business_id" = ${businessId} AND c."started_at" >= ${since}
       AND NOT starts_with(COALESCE(c."flagged_reason", ''), 'out_of_service:')
       AND (COALESCE(c."duration_sec", 0) >= ${RECENT_CALL_MIN_SECONDS}
            OR COALESCE(c."transcript", '') <> '' OR COALESCE(c."summary", '') <> ''
            OR EXISTS (SELECT 1 FROM "bookings" bk WHERE bk."call_id" = c."id"))`;
  return rows[0]?.n ?? 0;
}

/** Load everything decideRelease needs for one business (null when it does not exist). */
export async function loadReleaseFacts(businessId: string, now: Date = new Date()): Promise<ReleaseFacts | null> {
  const b = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true, name: true, billingStatus: true, plan: true, currentPeriodEnd: true, trialEndsAt: true, phone: true, phoneE164: true, agentId: true,
      users: { where: { role: 'owner', disabledAt: null }, select: { email: true } },
    },
  });
  if (!b) return null;
  const periodEnd = b.currentPeriodEnd ?? b.trialEndsAt;
  const [recent, comp, notice, phoneShared, agentShared, otherAgents] = await Promise.all([
    countRecentRealCalls(businessId, addDays(now, -RECENT_CALL_DAYS)),
    prisma.auditEvent.findFirst({ where: { businessId, action: { in: ['billing.admin_override', 'billing.grandfathered'] } }, orderBy: { at: 'desc' }, select: { at: true } }),
    prisma.auditEvent.findFirst({ where: { businessId, action: NOTICE_ACTION }, orderBy: { at: 'desc' }, select: { at: true, meta: true } }),
    b.phone || b.phoneE164
      ? prisma.business.count({ where: { id: { not: businessId }, OR: [...(b.phone ? [{ phone: b.phone }] : []), ...(b.phoneE164 ? [{ phoneE164: b.phoneE164 }] : [])] } })
      : Promise.resolve(0),
    b.agentId ? prisma.business.count({ where: { id: { not: businessId }, agentId: b.agentId } }) : Promise.resolve(0),
    prisma.business.count({ where: { id: { not: businessId }, agentId: { not: null } } }),
  ]);
  const lastComp = comp?.at ?? null;
  // A notice only counts for the CURRENT cancellation: one older than the period end / last comp belongs to an earlier cycle.
  const since = lastComp && periodEnd && lastComp > periodEnd ? lastComp : periodEnd;
  const meta = (notice?.meta ?? {}) as { notified_at?: unknown };
  const noticeAt = typeof meta.notified_at === 'string' && !Number.isNaN(Date.parse(meta.notified_at)) ? new Date(meta.notified_at) : notice?.at ?? null;
  return {
    id: b.id, name: b.name, billing_status: b.billingStatus, plan: b.plan, period_end: periodEnd, last_comp_at: lastComp,
    phone: b.phone, phone_e164: b.phoneE164, agent_id: b.agentId, recent_calls: recent,
    notified_at: noticeAt && (!since || noticeAt >= since) ? noticeAt : null,
    has_owner_email: b.users.length > 0,
    phone_shared: phoneShared > 0, agent_shared: agentShared > 0, other_agents_exist: otherAgents > 0,
  };
}

export interface ReleaseOutcome {
  number: { phone_last4: string | null; result: ReleaseNumberResult | { skipped: string } | null };
  agent: { agent_id: string | null; result: ReleaseAgentResult | { skipped: string } | null };
  tools: ReleaseToolsResult | { skipped: string } | null;
  cleared: { phone: boolean; agent: boolean };
  errors: string[];
}

export interface ReleaseDeps {
  releaseNumber?: (e164: string, deps?: { callerBusinessId?: string | null }) => Promise<ReleaseNumberResult>;
  deleteAgent?: typeof deleteAgent;
  deleteAgentTools?: typeof deleteAgentTools;
}

const last4 = (p: string | null) => (p ? p.slice(-4) : null);

/** Perform the release for a business already decided as `release`. Idempotent; partial failures stay retryable. */
export async function executeRelease(
  f: ReleaseFacts, ctx: { notice: 'sent' | 'off' | 'skipped'; actor?: { kind: 'user' | 'admin_token' | 'system'; user_id?: string | null }; script?: string; /** Aborts when the business lease is lost: no further provider call is made. */ signal?: AbortSignal }, deps: ReleaseDeps = {},
): Promise<ReleaseOutcome> {
  const out: ReleaseOutcome = { number: { phone_last4: last4(f.phone_e164 ?? f.phone), result: null }, agent: { agent_id: f.agent_id, result: null }, tools: null, cleared: { phone: false, agent: false }, errors: [] };
  const doNumber = deps.releaseNumber ?? releaseNumber;
  const doAgent = deps.deleteAgent ?? deleteAgent;
  const doTools = deps.deleteAgentTools ?? deleteAgentTools;

  const lostLease = (step: string): boolean => {
    if (!ctx.signal?.aborted) return false;
    out.errors.push(`${step}: lease lost, stopped before the provider call (retry later)`);
    return true;
  };
  // 1) the agent first: it stops answering before the line disappears.
  let agentGone = false;
  if (f.agent_id && !lostLease('agent')) {
    if (f.agent_shared) {
      out.agent.result = { skipped: 'another business uses this agent; kept at the provider' };
      agentGone = true; // only this business's reference is dropped
    } else {
      const r = await doAgent(f.agent_id);
      out.agent.result = r;
      agentGone = r.ok;
      if (!r.ok) out.errors.push(`agent: ${r.error ?? 'failed'}`);
    }
    if (agentGone) out.cleared.agent = Boolean(await clearBusinessProviderResources(f.id, { agent: true }));
  }
  // 2) the number.
  const number = f.phone_e164 ?? f.phone;
  if (number && !lostLease('number')) {
    if (f.phone_shared) {
      out.number.result = { skipped: 'another business uses this number; kept at the provider' };
      out.cleared.phone = Boolean(await clearBusinessProviderResources(f.id, { phone: true }));
    } else {
      const r = await doNumber(number, { callerBusinessId: f.id });
      out.number.result = r;
      if (r.ok) out.cleared.phone = Boolean(await clearBusinessProviderResources(f.id, { phone: true }));
      else out.errors.push(`number: ${r.refused ?? r.error ?? 'failed'}`);
    }
  }
  // 3) the workspace tools are shared by every tenant: only when this was the last business with an agent.
  if (f.agent_id && agentGone && !f.agent_shared && !lostLease('tools')) {
    if (f.other_agents_exist) out.tools = { skipped: 'other businesses still have agents; the shared workspace tools stay' };
    else {
      out.tools = await doTools();
      if (!out.tools.ok) out.errors.push(`tools: ${out.tools.error ?? 'failed'}`);
    }
  }
  await recordAudit({
    actor_kind: ctx.actor?.kind ?? 'system', actor_user_id: ctx.actor?.user_id ?? null, business_id: f.id, action: RELEASED_ACTION, target: `business:${f.id}`,
    meta: {
      ...(ctx.script ? { script: ctx.script } : {}), billing_status: f.billing_status, notice: ctx.notice, phone_last4: out.number.phone_last4,
      number: out.number.result, agent_id: f.agent_id, agent: out.agent.result, tools: out.tools, cleared: out.cleared, errors: out.errors,
    },
  });
  log.info('released', { business: f.id, cleared: out.cleared, errors: out.errors.length });
  return out;
}

export interface BusinessReport {
  id: string;
  name: string;
  decision: ReleaseDecision;
  applied: boolean;
  notified?: number;
  outcome?: ReleaseOutcome;
  error?: string;
}

/**
 * Evaluate one business and, when `apply` is true, carry out the decision (send the heads-up, or release). Without `apply`
 * nothing is written and no provider or mail is touched. `facts` may be preloaded.
 */
export async function processBusiness(
  businessId: string, o: ReleaseOptions & { apply?: boolean; actor?: { kind: 'user' | 'admin_token' | 'system'; user_id?: string | null }; script?: string; facts?: ReleaseFacts | null },
  deps: ReleaseDeps = {},
): Promise<BusinessReport | null> {
  const now = o.now ?? new Date();
  const facts = o.facts ?? (await loadReleaseFacts(businessId, now));
  if (!facts) return null;
  const decision = decideRelease(facts, { ...o, now });
  const report: BusinessReport = { id: facts.id, name: facts.name, decision, applied: false };
  if (!o.apply || (decision.action !== 'notify' && decision.action !== 'release')) return report;
  try {
    // One release (or heads-up mail) per business at a time, and never while that business is being provisioned: the same lease
    // key as POST /businesses/:id/provision. The facts are RE-READ under the lease, so a reactivation (webhook, admin comp) or a
    // concurrent run that landed since the decision was made is honoured before anything is mailed or deleted.
    const run = await withLease(businessLeaseKey(facts.id), RELEASE_LEASE_MS, async (_lease, signal) => {
      const fresh = await loadReleaseFacts(facts.id, now);
      if (!fresh) return { gone: true } as const;
      const again = decideRelease(fresh, { ...o, now });
      report.decision = again;
      if (again.action === 'notify') {
        const sent = await notifyOwners({ id: fresh.id, name: fresh.name }, 'release_notice', { releaseOn: again.release_on });
        report.notified = sent;
        if (sent > 0) {
          await recordAudit({
            actor_kind: o.actor?.kind ?? 'system', actor_user_id: o.actor?.user_id ?? null, business_id: fresh.id, action: NOTICE_ACTION, target: `business:${fresh.id}`,
            meta: { notified_at: now.toISOString(), release_on: again.release_on.toISOString(), recipients: sent, ...(o.script ? { script: o.script } : {}) },
          });
          report.applied = true;
        } else report.error = 'heads-up e-mail could not be sent to any owner; nothing recorded, will retry on the next run';
      } else if (again.action === 'release') {
        report.outcome = await executeRelease(fresh, { notice: again.notice, actor: o.actor, script: o.script, signal }, deps);
        report.applied = true;
      }
      return { gone: false } as const;
    });
    if (!run.acquired) report.error = 'another release or provisioning run holds this business right now; nothing was changed, try again in a minute';
    else if (run.value.gone) return null;
  } catch (err) {
    log.error('process_failed', { business: facts.id, err });
    report.error = (err as Error).message;
  }
  return report;
}

/** Ids of every business the script should look at (canceled/unpaid). */
export async function listReleaseCandidates(): Promise<string[]> {
  const rows = await prisma.business.findMany({ where: { billingStatus: { in: ['canceled', 'unpaid'] } }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => r.id);
}
