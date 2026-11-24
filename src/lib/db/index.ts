/**
 * Single import point for persistence — now Postgres via Prisma.
 *
 * Every function is async. Callers get plain domain objects from
 * `@/lib/types` (ISO date strings, not JS Dates), so no route, page or agent
 * tool ever touches Prisma types directly.
 */
import type {
  Prisma,
  Business as BusinessRow, KnowledgeBase as KnowledgeBaseRow, Call as CallRow, Booking as BookingRow,
  Briefing as BriefingRow, SmsLog as SmsRow,
} from '@prisma/client';
import { prisma, type DbClient } from './client';
import { clampLimit, encodeTimeCursor, MAX_LIST, parseTimeCursor, toPage, type Page } from './paging';
import { logger } from '@/lib/log';
import { closedDatesOf, normalizeClosedDates } from '@/lib/closures';
import { dayRange as zonedDayRange, localDateKey, tzOf, DEFAULT_TIMEZONE, isValidTimeZone } from '@/lib/time';
import {
  bookingInterval, clampDuration, intervalsOverlap, validateSlot, MAX_DURATION_MIN,
  type Interval, type SlotRejection,
} from '@/lib/availability';
import { phoneKey } from '@/lib/format';
import { defaultPhoneCountry, toE164 } from '@/lib/phone';
import { countryForBusiness, phoneIdent } from './compliance';
import { enqueueRecordingDeletions } from './recording-deletions';
import type {
  Business, KnowledgeBase, Call, Booking, Briefing, SmsLog, ID, Hours,
  Service, FAQ, BriefingStats, ConsentStatus, BillingStatus, CallMode, CallKind, TransferStatus, RefundStatus, DisputeStatus,
  Locale, Vertical, RefundPolicy, BillingInterval,
} from '@/lib/types';
import { BILLING_INTERVALS, LOCALES, REFUND_POLICIES, REFUND_POLICY_TEXT_MAX, TRANSFER_STATUSES, VERTICALS } from '@/lib/types';
import { sanitizeAuditMeta } from './audit';
import { calendarBusyConflict } from '@/lib/integrations/google/busy';

const MAX_PAGE_SIZE_RANGE = 500;

export { prisma };
export { newId, nowIso } from './ids';
export * from './events';
export * from './locks';
export * from './forward-leases';
export * from './recording-deletions';
export * from './number-attempts';
export * from './compliance';
export * from './users';
export * from './email-tokens';
export * from './audit';
export * from './usage';
export * from './call-mode';
export * from './paging';
export * from './calendar';
export * from './owner-kb';
export * from './transcript';
export * from './call-trust';
export * from './passkeys';
export * from './memberships';

/** Every write logs what changed; reads stay quiet (they are the hot path). */
const log = logger('db');

export const DEFAULT_HOURS: Hours = {
  monday: { open: '08:00', close: '18:00' },
  tuesday: { open: '08:00', close: '18:00' },
  wednesday: { open: '08:00', close: '18:00' },
  thursday: { open: '08:00', close: '18:00' },
  friday: { open: '08:00', close: '18:00' },
  saturday: { open: '09:00', close: '14:00' },
  sunday: null,
};

// ---------- mappers: DB row -> domain object ----------
const callModeOf = (v: string | null | undefined): CallMode => (v === 'paused' || v === 'forward' ? v : 'ai');

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoReq = (d: Date): string => d.toISOString();

function toBusiness(row: BusinessRow): Business {
  return {
    id: row.id,
    name: row.name,
    url: row.url ?? null,
    phone: row.phone ?? null,
    owner_phone: row.ownerPhone ?? null,
    owner_name: row.ownerName ?? null,
    hours: (row.hours ?? DEFAULT_HOURS) as unknown as Hours,
    closed_dates: closedDatesOf(row.closedDates),
    service_area: (row.serviceArea ?? []) as string[],
    status: row.status as Business['status'],
    agent_id: row.agentId ?? null,
    timezone: tzOf(row.timezone),
    retention_days: row.retentionDays ?? 365,
    recording_disclosure_text: row.recordingDisclosureText ?? null,
    created_at: isoReq(row.createdAt),
    phone_e164: row.phoneE164 ?? null,
    owner_phone_e164: row.ownerPhoneE164 ?? null,
    owner_phone_verified_at: row.ownerPhoneVerifiedAt ? row.ownerPhoneVerifiedAt.toISOString() : null,
    billing_status: (row.billingStatus ?? 'none') as Business['billing_status'],
    plan: row.plan ?? null,
    stripe_customer_id: row.stripeCustomerId ?? null,
    stripe_subscription_id: row.stripeSubscriptionId ?? null,
    trial_ends_at: row.trialEndsAt ? row.trialEndsAt.toISOString() : null,
    current_period_end: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
    cancel_at_period_end: row.cancelAtPeriodEnd ?? false,
    past_due_since: row.pastDueSince ? row.pastDueSince.toISOString() : null,
    sms_cap_override: row.smsCapOverride ?? null,
    call_minutes_cap_override: row.callMinutesCapOverride ?? null,
    call_mode: callModeOf(row.callMode),
    forward_number: row.forwardNumber ?? null,
    forward_number_e164: row.forwardNumberE164 ?? null,
    forward_number_verified_at: iso(row.forwardNumberVerifiedAt),
    forward_during_hours: row.forwardDuringHours ?? false,
    locale_default: (row.localeDefault === 'es' ? 'es' : 'en') as Locale,
    vertical: (VERTICALS.includes(row.vertical as Vertical) ? row.vertical : 'hvac') as Vertical,
    voice_id: row.voiceId ?? null,
    voice_name: row.voiceName ?? null,
    refund_policy: (REFUND_POLICIES.includes(row.refundPolicy as RefundPolicy) ? row.refundPolicy : 'full_24h') as RefundPolicy,
    refund_policy_text: row.refundPolicyText ?? null,
    billing_interval: (row.billingInterval === 'year' ? 'year' : 'month') as BillingInterval,
  };
}

function toKnowledgeBase(row: KnowledgeBaseRow): KnowledgeBase {
  return {
    id: row.id,
    business_id: row.businessId,
    services: (row.services ?? []) as unknown as Service[],
    faqs: (row.faqs ?? []) as unknown as FAQ[],
    pricing_notes: row.pricingNotes ?? '',
    system_prompt: row.systemPrompt ?? '',
    call_script: row.callScript ?? '',
    updated_at: isoReq(row.updatedAt),
  };
}

function toCall(row: CallRow): Call {
  return {
    id: row.id,
    business_id: row.businessId,
    call_sid: row.callSid ?? null,
    conversation_id: row.conversationId ?? null,
    caller_phone: row.callerPhone ?? null,
    caller_name: row.callerName ?? null,
    started_at: isoReq(row.startedAt),
    ended_at: iso(row.endedAt),
    duration_sec: row.durationSec ?? null,
    language: (row.language ?? null) as Call['language'],
    transcript: row.transcript ?? null,
    summary: row.summary ?? null,
    urgency: row.urgency as Call['urgency'],
    status: row.status as Call['status'],
    recording_url: row.recordingUrl ?? null,
    flagged_reason: row.flaggedReason ?? null,
    recording_disclosed: row.recordingDisclosed ?? false,
    consent_status: (row.consentStatus ?? 'unknown') as ConsentStatus,
    kind: (row.kind === 'owner' ? 'owner' : 'customer') as CallKind,
    transfer_status: (TRANSFER_STATUSES.includes(row.transferStatus as TransferStatus) ? row.transferStatus : 'none') as TransferStatus,
    stir_status: row.stirStatus ?? null,
    caller_verified: row.callerVerified ?? null,
    metered_at: iso(row.meteredAt),
    reconcile_attempts: row.reconcileAttempts ?? 0,
  };
}

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    call_id: row.callId ?? null,
    business_id: row.businessId,
    customer_name: row.customerName,
    customer_phone: row.customerPhone,
    service: row.service,
    scheduled_at: isoReq(row.scheduledAt),
    duration_minutes: row.durationMinutes ?? 60,
    address: row.address ?? null,
    price_estimate: row.priceEstimate ?? null,
    deposit_amount: row.depositAmount ?? null,
    deposit_paid: row.depositPaid,
    status: row.status as Booking['status'],
    created_at: isoReq(row.createdAt),
    anonymized_at: iso(row.anonymizedAt),
    followup_consent_at: iso(row.followupConsentAt),
    followup_consent_source: row.followupConsentSource ?? null,
    rescheduled_from_id: row.rescheduledFromId ?? null,
    reschedule_count: row.rescheduleCount ?? 0,
    cancelled_at: iso(row.cancelledAt),
    cancel_reason: row.cancelReason ?? null,
    customer_notified_at: iso(row.customerNotifiedAt),
    stripe_payment_intent_id: row.stripePaymentIntentId ?? null,
    stripe_checkout_session_id: row.stripeCheckoutSessionId ?? null,
    refund_status: (row.refundStatus ?? 'none') as RefundStatus,
    refund_amount_cents: row.refundAmountCents ?? null,
    stripe_refund_id: row.stripeRefundId ?? null,
    refunded_at: iso(row.refundedAt),
    dispute_status: (['open', 'won', 'lost'].includes(row.disputeStatus) ? row.disputeStatus : 'none') as DisputeStatus,
  };
}

function toBriefing(row: BriefingRow): Briefing {
  return {
    id: row.id,
    business_id: row.businessId,
    date: row.date,
    audio_url: row.audioUrl ?? null,
    transcript: row.transcript,
    stats: (row.stats ?? { calls: 0, bookings: 0, revenue: 0, flags: 0 }) as unknown as BriefingStats,
    created_at: isoReq(row.createdAt),
  };
}

function toSms(row: SmsRow): SmsLog {
  return {
    id: row.id,
    business_id: row.businessId,
    to_phone: row.toPhone,
    body: row.body,
    kind: row.kind as SmsLog['kind'],
    booking_id: row.bookingId ?? null,
    provider_id: row.providerId ?? null,
    status: row.status as SmsLog['status'],
    consent_basis: row.consentBasis ?? null,
    created_at: isoReq(row.createdAt),
  };
}

/** Domain patch -> Prisma column names. Only defined keys are written. */
function callPatch(patch: Partial<Call>) {
  const out: Prisma.CallUncheckedUpdateInput = {};
  if (patch.call_sid !== undefined) out.callSid = patch.call_sid;
  if (patch.conversation_id !== undefined) out.conversationId = patch.conversation_id;
  if (patch.caller_phone !== undefined) out.callerPhone = patch.caller_phone;
  if (patch.caller_name !== undefined) out.callerName = patch.caller_name;
  if (patch.started_at !== undefined) out.startedAt = new Date(patch.started_at);
  if (patch.ended_at !== undefined) out.endedAt = patch.ended_at ? new Date(patch.ended_at) : null;
  if (patch.duration_sec !== undefined) out.durationSec = patch.duration_sec;
  if (patch.language !== undefined) out.language = patch.language;
  if (patch.transcript !== undefined) out.transcript = patch.transcript;
  if (patch.summary !== undefined) out.summary = patch.summary;
  if (patch.urgency !== undefined) out.urgency = patch.urgency;
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.recording_url !== undefined) out.recordingUrl = patch.recording_url;
  if (patch.flagged_reason !== undefined) out.flaggedReason = patch.flagged_reason;
  if (patch.recording_disclosed !== undefined) out.recordingDisclosed = patch.recording_disclosed;
  if (patch.consent_status !== undefined) out.consentStatus = patch.consent_status;
  if (patch.kind !== undefined && (patch.kind === 'customer' || patch.kind === 'owner')) out.kind = patch.kind;
  if (patch.transfer_status !== undefined && TRANSFER_STATUSES.includes(patch.transfer_status)) out.transferStatus = patch.transfer_status;
  return out;
}

function bookingPatch(patch: Partial<Booking>) {
  const out: Prisma.BookingUncheckedUpdateInput = {};
  if (patch.call_id !== undefined) out.callId = patch.call_id;
  if (patch.customer_name !== undefined) out.customerName = patch.customer_name;
  if (patch.customer_phone !== undefined) out.customerPhone = patch.customer_phone;
  if (patch.service !== undefined) out.service = patch.service;
  if (patch.scheduled_at !== undefined) out.scheduledAt = new Date(patch.scheduled_at);
  if (patch.duration_minutes !== undefined) out.durationMinutes = clampDuration(patch.duration_minutes);
  if (patch.address !== undefined) out.address = patch.address;
  if (patch.price_estimate !== undefined) out.priceEstimate = patch.price_estimate;
  if (patch.deposit_amount !== undefined) out.depositAmount = patch.deposit_amount;
  if (patch.deposit_paid !== undefined) out.depositPaid = patch.deposit_paid;
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.followup_consent_at !== undefined) out.followupConsentAt = patch.followup_consent_at ? new Date(patch.followup_consent_at) : null;
  if (patch.followup_consent_source !== undefined) out.followupConsentSource = patch.followup_consent_source;
  if (patch.customer_notified_at !== undefined) out.customerNotifiedAt = patch.customer_notified_at ? new Date(patch.customer_notified_at) : null;
  if (patch.stripe_payment_intent_id !== undefined) out.stripePaymentIntentId = patch.stripe_payment_intent_id;
  if (patch.stripe_checkout_session_id !== undefined) out.stripeCheckoutSessionId = patch.stripe_checkout_session_id;
  if (patch.cancel_reason !== undefined) out.cancelReason = patch.cancel_reason ? patch.cancel_reason.slice(0, 500) : null;
  return out;
}

function businessPatch(patch: Partial<Business>, country: string = defaultPhoneCountry()) {
  const out: Prisma.BusinessUncheckedUpdateInput = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.url !== undefined) out.url = patch.url;
  if (patch.phone !== undefined) { out.phone = patch.phone; out.phoneKey = phoneKey(patch.phone); out.phoneE164 = toE164(patch.phone, country); }
  if (patch.timezone !== undefined && isValidTimeZone(patch.timezone)) out.timezone = patch.timezone;
  if (patch.owner_phone !== undefined) { out.ownerPhone = patch.owner_phone; out.ownerPhoneE164 = toE164(patch.owner_phone, country); }
  if (patch.owner_name !== undefined) out.ownerName = patch.owner_name;
  if (patch.hours !== undefined) out.hours = patch.hours as Prisma.InputJsonObject;
  if (patch.service_area !== undefined) out.serviceArea = patch.service_area;
  if (patch.closed_dates !== undefined) { const c = normalizeClosedDates(patch.closed_dates); if (c) out.closedDates = c as unknown as Prisma.InputJsonValue; }
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.agent_id !== undefined) out.agentId = patch.agent_id;
  if (patch.retention_days !== undefined && Number.isInteger(patch.retention_days)
      && patch.retention_days >= 1 && patch.retention_days <= 3650) out.retentionDays = patch.retention_days;
  if (patch.recording_disclosure_text !== undefined) out.recordingDisclosureText = patch.recording_disclosure_text;
  // Enumerated settings: an unknown value is ignored (the database CHECKs would reject it anyway).
  if (patch.locale_default !== undefined && LOCALES.includes(patch.locale_default)) out.localeDefault = patch.locale_default;
  if (patch.vertical !== undefined && VERTICALS.includes(patch.vertical)) out.vertical = patch.vertical;
  if (patch.voice_id !== undefined) out.voiceId = patch.voice_id ? String(patch.voice_id).slice(0, 100) : null;
  if (patch.voice_name !== undefined) out.voiceName = patch.voice_name ? String(patch.voice_name).slice(0, 100) : null;
  if (patch.refund_policy !== undefined && REFUND_POLICIES.includes(patch.refund_policy)) out.refundPolicy = patch.refund_policy;
  if (patch.refund_policy_text !== undefined && (patch.refund_policy_text === null || patch.refund_policy_text.length <= REFUND_POLICY_TEXT_MAX)) {
    out.refundPolicyText = patch.refund_policy_text && patch.refund_policy_text.trim() ? patch.refund_policy_text : null;
  }
  if (patch.billing_interval !== undefined && BILLING_INTERVALS.includes(patch.billing_interval)) out.billingInterval = patch.billing_interval;
  return out;
}

/** Prisma's "record to update does not exist" (P2025): the ONLY failure the updateX helpers turn into `null`. */
function isRecordNotFound(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2025';
}

/** Local YYYY-MM-DD day bounds in the business zone, as a UTC range (DST-correct). */
function dayRange(date: string, tz: string = DEFAULT_TIMEZONE): { gte: Date; lt: Date } {
  return zonedDayRange(date, tz);
}

// ---------- businesses ----------
/**
 * Every business (admin switcher, routing fallback), oldest first, BOUNDED to `limit` rows (default MAX_LIST). To walk the whole
 * table use listBusinessesPage / listAllBusinesses (keyset, tolerant of rows deleted mid-walk).
 */
export async function listBusinesses(opts: { limit?: number } = {}): Promise<Business[]> {
  const rows = await prisma.business.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: clampLimit(opts.limit, MAX_LIST, MAX_LIST),
  });
  return rows.map(toBusiness);
}

/** EVERY business, walking the keyset pages (for the background jobs, which must not silently skip tenant #1001). */
export async function listAllBusinesses(): Promise<Business[]> {
  const out: Business[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<Business> = await listBusinessesPage({ limit: MAX_PAGE_SIZE_RANGE, cursor });
    out.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return out;
}

/** The few columns the background jobs need to decide whether a tenant is due (never the whole row: hours, KB-sized json, tokens...). */
export type JobBusiness = Pick<Business, 'id' | 'timezone' | 'billing_status' | 'past_due_since' | 'status'>;

/**
 * Live businesses for the job runner, narrow columns only, keyset-paged (indexed on status; walks every page so tenant #1001 is
 * not skipped). `businessId` restricts to one. Jobs load a full row (`getBusiness`) only for a tenant they actually act on.
 */
export async function listLiveBusinessesForJobs(opts: { businessId?: ID } = {}): Promise<JobBusiness[]> {
  const out: JobBusiness[] = [];
  // Keyset on (created_at, id) carrying the LAST ROW'S VALUES, never `cursor: { id }`: a tenant deleted between two pages must
  // not end the walk (Prisma returns an empty page for a cursor row that no longer exists, skipping every later tenant).
  let cursor: { at: Date; id: string } | null = null;
  for (;;) {
    const rows: { id: string; createdAt: Date; timezone: string; billingStatus: string; pastDueSince: Date | null }[] = await prisma.business.findMany({
      where: {
        status: 'live',
        ...(opts.businessId ? { id: opts.businessId } : {}),
        ...(cursor ? { OR: [{ createdAt: { gt: cursor.at } }, { createdAt: cursor.at, id: { gt: cursor.id } }] } : {}),
      },
      select: { id: true, createdAt: true, timezone: true, billingStatus: true, pastDueSince: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_PAGE_SIZE_RANGE,
    });
    for (const r of rows) {
      out.push({
        id: r.id, status: 'live', timezone: r.timezone,
        billing_status: r.billingStatus as Business['billing_status'],
        past_due_since: r.pastDueSince ? r.pastDueSince.toISOString() : null,
      });
    }
    if (rows.length < MAX_PAGE_SIZE_RANGE) break;
    const last = rows[rows.length - 1];
    cursor = { at: last.createdAt, id: last.id };
  }
  return out;
}

/** One page of businesses plus the cursor of the next page. */
export async function listBusinessesPage(opts: { limit?: number; cursor?: string | null } = {}): Promise<Page<Business>> {
  const limit = clampLimit(opts.limit, 50);
  const cur = parseTimeCursor(opts.cursor);
  // Keyset on (created_at, id) with the values carried IN the cursor (`<iso>~<id>`): a cursor whose row was deleted since the
  // last page still resumes at the right place (Prisma's `cursor: { id }` returns nothing for a deleted row, which made a
  // background job silently skip every later tenant).
  const rows = await prisma.business.findMany({
    where: cur ? { OR: [{ createdAt: { gt: cur.at } }, { createdAt: cur.at, id: { gt: cur.id } }] } : {},
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  });
  return toPage(rows, limit, toBusiness, (r) => encodeTimeCursor(r.createdAt, r.id));
}

export async function getBusiness(id: ID): Promise<Business | null> {
  const row = await prisma.business.findUnique({ where: { id } });
  return row ? toBusiness(row) : null;
}

/** Every business that stores this agent id (should never be more than one). */
export async function listBusinessesByAgentId(agentId: string): Promise<Business[]> {
  const id = agentId.trim();
  if (!id) return [];
  const rows = await prisma.business.findMany({ where: { agentId: id }, orderBy: { createdAt: 'asc' }, take: 5 });
  return rows.map(toBusiness);
}

/**
 * Tenant lookup by ElevenLabs agent id. Fails closed: when several businesses
 * claim the same agent the mapping is ambiguous, so NO tenant is returned
 * (never "the oldest one").
 */
export async function getBusinessByAgentId(agentId: string): Promise<Business | null> {
  const rows = await listBusinessesByAgentId(agentId);
  return rows.length === 1 ? rows[0] : null;
}

export type BillingPatch = {
  billing_status?: BillingStatus;
  plan?: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  trial_ends_at?: Date | string | null;
  current_period_end?: Date | string | null;
  cancel_at_period_end?: boolean;
  sms_cap_override?: number | null;
  call_minutes_cap_override?: number | null;
  owner_phone_verified_at?: Date | string | null;
};

const toDateOrNull = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

/**
 * Update billing fields of a business (Stripe webhooks, admin overrides). `past_due_since` is maintained here:
 * set to `now` when the status BECOMES 'past_due', kept while it stays past due, cleared otherwise.
 * Returns the updated business, or null when it does not exist. Unknown keys are ignored.
 */
export async function setBillingState(businessId: string, patch: BillingPatch, now: Date = new Date()): Promise<Business | null> {
  const data: Record<string, unknown> = {};
  if (patch.plan !== undefined) data.plan = patch.plan;
  if (patch.stripe_customer_id !== undefined) data.stripeCustomerId = patch.stripe_customer_id;
  if (patch.stripe_subscription_id !== undefined) data.stripeSubscriptionId = patch.stripe_subscription_id;
  if (patch.trial_ends_at !== undefined) data.trialEndsAt = toDateOrNull(patch.trial_ends_at);
  if (patch.current_period_end !== undefined) data.currentPeriodEnd = toDateOrNull(patch.current_period_end);
  if (patch.cancel_at_period_end !== undefined) data.cancelAtPeriodEnd = patch.cancel_at_period_end;
  if (patch.sms_cap_override !== undefined) data.smsCapOverride = patch.sms_cap_override;
  if (patch.call_minutes_cap_override !== undefined) data.callMinutesCapOverride = patch.call_minutes_cap_override;
  if (patch.owner_phone_verified_at !== undefined) data.ownerPhoneVerifiedAt = toDateOrNull(patch.owner_phone_verified_at);
  return prisma.$transaction(async (tx) => {
    const current = await tx.business.findUnique({ where: { id: businessId }, select: { billingStatus: true, pastDueSince: true } });
    if (!current) return null;
    if (patch.billing_status !== undefined) {
      data.billingStatus = patch.billing_status;
      data.pastDueSince = patch.billing_status === 'past_due' ? (current.billingStatus === 'past_due' && current.pastDueSince ? current.pastDueSince : now) : null;
    }
    const row = await tx.business.update({ where: { id: businessId }, data });
    return toBusiness(row);
  });
}

/** The business billed under a Stripe customer id (null when none). */
export async function getBusinessByStripeCustomer(stripeCustomerId: string): Promise<Business | null> {
  if (!stripeCustomerId) return null;
  const row = await prisma.business.findFirst({ where: { stripeCustomerId }, orderBy: { createdAt: 'asc' } });
  return row ? toBusiness(row) : null;
}

/**
 * Tenant lookup by phone number: exact on E.164 first. Only a business row WITHOUT a stored E.164 (legacy) may be
 * matched on the last-10-digit key, and only for a US/Canada number, so a +44 number never routes to a +1 business
 * that shares its last ten digits.
 */
export async function getBusinessByPhone(phone: string, country: string = defaultPhoneCountry()): Promise<Business | null> {
  const id = phoneIdent(phone, country);
  if (id.e164) {
    const exact = await prisma.business.findFirst({ where: { phoneE164: id.e164 }, orderBy: { createdAt: 'asc' } });
    if (exact) return toBusiness(exact);
    if (!id.nanp) return null;
    const legacy = await prisma.business.findFirst({ where: { phoneE164: null, phoneKey: id.e164.slice(-10) }, orderBy: { createdAt: 'asc' } });
    return legacy ? toBusiness(legacy) : null;
  }
  const key = phoneKey(phone);
  if (!key) return null;
  const row = await prisma.business.findFirst({ where: { phoneE164: null, phoneKey: key }, orderBy: { createdAt: 'asc' } });
  return row ? toBusiness(row) : null;
}

export async function createBusiness(
  input: Partial<Business> & { name: string },
  /** Pass a transaction client to create the business atomically with other rows (e.g. signup: business + owner). */
  db: DbClient = prisma,
): Promise<Business> {
  const row = await db.business.create({
    data: {
      name: input.name,
      url: input.url ?? null,
      phone: input.phone ?? null,
      phoneKey: phoneKey(input.phone),
      phoneE164: toE164(input.phone),
      timezone: isValidTimeZone(input.timezone) ? input.timezone : DEFAULT_TIMEZONE,
      ownerPhone: input.owner_phone ?? null,
      ownerPhoneE164: toE164(input.owner_phone),
      ownerName: input.owner_name ?? null,
      hours: (input.hours ?? DEFAULT_HOURS) as object,
      serviceArea: input.service_area ?? [],
      status: input.status ?? 'onboarding',
      ...(input.retention_days ? { retentionDays: input.retention_days } : {}),
      recordingDisclosureText: input.recording_disclosure_text ?? null,
      ...(input.locale_default && LOCALES.includes(input.locale_default) ? { localeDefault: input.locale_default } : {}),
      ...(input.vertical && VERTICALS.includes(input.vertical) ? { vertical: input.vertical } : {}),
      ...(input.voice_id ? { voiceId: input.voice_id.slice(0, 100) } : {}),
      ...(input.voice_name ? { voiceName: input.voice_name.slice(0, 100) } : {}),
    },
  });
  log.info('business.created', { id: row.id, name: row.name, url: row.url });
  return toBusiness(row);
}

export async function updateBusiness(id: ID, patch: Partial<Business>): Promise<Business | null> {
  let country: string = defaultPhoneCountry();
  let current: { phoneE164: string | null; ownerPhoneE164: string | null } | null = null;
  if (patch.phone !== undefined || patch.owner_phone !== undefined) {
    current = await prisma.business.findUnique({ where: { id }, select: { phoneE164: true, ownerPhoneE164: true } });
    country = countryForBusiness({ phone_e164: current?.phoneE164 });
  }
  const data = businessPatch(patch, country);
  // The owner phone is an alert destination only once the owner PROVED they control it (owner-phone verification).
  // Any change through this generic path therefore drops the verification, unless it is the very same number.
  if ('ownerPhone' in data && !(data.ownerPhoneE164 && data.ownerPhoneE164 === current?.ownerPhoneE164)) {
    data.ownerPhoneVerifiedAt = null;
  }
  if (Object.keys(data).length === 0) return getBusiness(id);
  try {
    const row = await prisma.business.update({ where: { id }, data });
    log.debug('business.updated', { id, fields: Object.keys(data) });
    return toBusiness(row);
  } catch (err) {
    // Only "no such row" is `null` (callers answer 404). A real failure (database down, constraint violation) is thrown, never
    // disguised as "not found".
    if (isRecordNotFound(err)) return null;
    log.warn('business.update_failed', { id, fields: Object.keys(data), err });
    throw err;
  }
}

/**
 * After provider resources were released (scripts/release-canceled-tenants.ts): forget the number and agent so nothing keeps
 * pointing at a number/agent that no longer exists. Only the fields asked for are cleared; when the number is cleared the
 * business is 'paused' (it can no longer take calls; re-provisioning after a new subscription buys a fresh line).
 */
export async function clearBusinessProviderResources(id: ID, what: { phone?: boolean; agent?: boolean }): Promise<Business | null> {
  const data: Record<string, unknown> = {};
  if (what.phone) { data.phone = null; data.phoneKey = null; data.phoneE164 = null; data.status = 'paused'; }
  if (what.agent) data.agentId = null;
  if (Object.keys(data).length === 0) return getBusiness(id);
  try {
    return toBusiness(await prisma.business.update({ where: { id }, data }));
  } catch (err) {
    if (isRecordNotFound(err)) return null;
    log.warn('business.clear_provider_failed', { id, err });
    throw err;
  }
}

// ---------- knowledge bases ----------
export async function getKnowledgeBase(businessId: ID): Promise<KnowledgeBase | null> {
  const row = await prisma.knowledgeBase.findUnique({ where: { businessId } });
  return row ? toKnowledgeBase(row) : null;
}

/** Merges: only keys present in `patch` are written; everything else is preserved. */
export async function upsertKnowledgeBase(
  businessId: ID,
  patch: Partial<Omit<KnowledgeBase, 'id' | 'business_id' | 'updated_at'>>,
): Promise<KnowledgeBase> {
  const data: Record<string, unknown> = {};
  if (patch.services !== undefined) data.services = patch.services as object;
  if (patch.faqs !== undefined) data.faqs = patch.faqs as object;
  if (patch.pricing_notes !== undefined) data.pricingNotes = patch.pricing_notes;
  if (patch.system_prompt !== undefined) data.systemPrompt = patch.system_prompt;
  if (patch.call_script !== undefined) data.callScript = patch.call_script;

  const row = await prisma.knowledgeBase.upsert({
    where: { businessId },
    update: data,
    create: { businessId, ...data },
  });
  log.debug('knowledge_base.saved', {
    business: businessId,
    fields: Object.keys(data),
    services: (row.services as unknown[] | null)?.length ?? 0,
    faqs: (row.faqs as unknown[] | null)?.length ?? 0,
    prompt_chars: row.systemPrompt.length,
  });
  return toKnowledgeBase(row);
}

// ---------- phone dual-write ----------
/**
 * E.164 of a raw number for a business: numbers with a '+' need no country, others use the business's own country
 * (the country of its phone number), else DEFAULT_PHONE_COUNTRY. Null when the number is not valid.
 */
export async function e164ForBusiness(raw: string | null | undefined, businessId: ID): Promise<string | null> {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (raw.trim().startsWith('+')) return toE164(raw);
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { phoneE164: true } });
  return toE164(raw, countryForBusiness({ phone_e164: b?.phoneE164 }));
}

// ---------- calls ----------
export async function createCall(input: Partial<Call> & { business_id: ID }): Promise<Call> {
  const row = await prisma.call.create({
    data: {
      businessId: input.business_id,
      callSid: input.call_sid ?? null,
      conversationId: input.conversation_id ?? null,
      callerPhone: input.caller_phone ?? null,
      callerE164: await e164ForBusiness(input.caller_phone, input.business_id),
      callerName: input.caller_name ?? null,
      startedAt: input.started_at ? new Date(input.started_at) : new Date(),
      endedAt: input.ended_at ? new Date(input.ended_at) : null,
      durationSec: input.duration_sec ?? null,
      language: input.language ?? null,
      transcript: input.transcript ?? null,
      summary: input.summary ?? null,
      urgency: input.urgency ?? 'unsure',
      status: input.status ?? 'in_progress',
      recordingUrl: input.recording_url ?? null,
      flaggedReason: input.flagged_reason ?? null,
      recordingDisclosed: input.recording_disclosed ?? false,
      consentStatus: input.consent_status ?? 'unknown',
      kind: input.kind === 'owner' ? 'owner' : 'customer',
      ...(input.transfer_status && TRANSFER_STATUSES.includes(input.transfer_status) ? { transferStatus: input.transfer_status } : {}),
      stirStatus: input.stir_status ?? null,
      callerVerified: input.caller_verified ?? null,
    },
  });
  log.info('call.created', {
    id: row.id,
    business: input.business_id,
    from: input.caller_phone ?? null,
    urgency: input.urgency ?? 'unsure',
    status: input.status ?? 'in_progress',
  });
  return toCall(row);
}

export async function updateCall(id: ID, patch: Partial<Call>): Promise<Call | null> {
  const data = callPatch(patch);
  if (Object.keys(data).length === 0) return getCall(id);
  // A recorded objection to recording/AI is permanent: nothing may move consent OUT of 'declined'
  // (not a late "disclosed" from post-call evidence, not a retry). Enforced here, in the write itself.
  if ('callerPhone' in data) {
    const owner = await prisma.call.findUnique({ where: { id }, select: { businessId: true } });
    data.callerE164 = owner ? await e164ForBusiness(data.callerPhone as string | null, owner.businessId) : null;
  }
  const consent: Record<string, unknown> = {};
  if ('consentStatus' in data) { consent.consentStatus = data.consentStatus; delete data.consentStatus; }
  if ('recordingDisclosed' in data) { consent.recordingDisclosed = data.recordingDisclosed; delete data.recordingDisclosed; }
  try {
    if (Object.keys(consent).length > 0) {
      const where = consent.consentStatus === 'declined' ? { id } : { id, consentStatus: { not: 'declined' } };
      await prisma.call.updateMany({ where, data: consent });
    }
    if (Object.keys(data).length === 0) return getCall(id);
    const row = await prisma.call.update({ where: { id }, data });
    log.debug('call.updated', { id, fields: [...Object.keys(data), ...Object.keys(consent)] });
    return toCall(row);
  } catch (err) {
    if (isRecordNotFound(err)) return null;
    log.warn('call.update_failed', { id, fields: Object.keys(data), err });
    throw err;
  }
}

export async function getCall(id: ID): Promise<Call | null> {
  const row = await prisma.call.findUnique({ where: { id } });
  return row ? toCall(row) : null;
}

export async function getCallBySid(callSid: string): Promise<Call | null> {
  if (!callSid) return null;
  const row = await prisma.call.findUnique({ where: { callSid } });
  return row ? toCall(row) : null;
}

export async function getCallByConversationId(conversationId: string): Promise<Call | null> {
  if (!conversationId) return null;
  const row = await prisma.call.findUnique({ where: { conversationId } });
  return row ? toCall(row) : null;
}

/**
 * Resolve the live call a tool belongs to. Strict: explicit id, then the telephony SID and/or
 * ElevenLabs conversation id (matched against BOTH key columns: older rows stored the conversation
 * id in `call_sid`). There is deliberately NO caller-phone or "only call in progress" fallback: a
 * fuzzy match can attach one caller's data to another caller's call. No trusted identifier => null.
 */
export async function findActiveCall(
  businessId: ID,
  hint: { callId?: string; callSid?: string; conversationId?: string } = {},
): Promise<Call | null> {
  if (hint.callId) {
    const row = await prisma.call.findFirst({ where: { id: hint.callId, businessId } });
    if (row) return toCall(row);
  }
  const keys = [hint.callSid, hint.conversationId].filter((k): k is string => Boolean(k));
  if (keys.length > 0) {
    const row = await prisma.call.findFirst({
      where: { businessId, OR: [{ callSid: { in: keys } }, { conversationId: { in: keys } }] },
      orderBy: { startedAt: 'asc' },
    });
    if (row) return toCall(row);
  }
  return null;
}

/**
 * The call row for a conversation, created on the FIRST tool call when none exists yet (a phone call
 * that reached the agent natively has no /api/voice/incoming row). Keyed by call SID / conversation id,
 * race-safe (unique indexes), and backfills keys / the platform caller id onto an existing row.
 * Returns null when there is no key at all.
 */
export async function upsertCallForConversation(
  businessId: ID,
  keys: { callSid?: string; conversationId?: string; callerPhone?: string | null },
): Promise<Call | null> {
  const callSid = keys.callSid || undefined;
  const conversationId = keys.conversationId || undefined;
  if (!callSid && !conversationId) return null;
  const find = () => findActiveCall(businessId, { callSid, conversationId });
  let call = await find();
  if (!call) {
    try {
      call = await createCall({
        business_id: businessId,
        call_sid: callSid ?? null,
        conversation_id: conversationId ?? null,
        caller_phone: keys.callerPhone ?? null,
        status: 'in_progress',
      });
    } catch (err) {
      call = await find(); // lost the race to a concurrent tool call: use the winner's row
      if (!call) throw err;
    }
    return call;
  }
  const patch: Partial<Call> = {};
  if (callSid && !call.call_sid) patch.call_sid = callSid;
  if (conversationId && !call.conversation_id && call.call_sid !== conversationId) patch.conversation_id = conversationId;
  if (keys.callerPhone && !call.caller_phone) patch.caller_phone = keys.callerPhone;
  if (Object.keys(patch).length === 0) return call;
  try {
    return (await updateCall(call.id, patch)) ?? call;
  } catch {
    return call;
  }
}

/**
 * Calls of one business (or, without an id, every business: admin/ops use only), newest first. BOUNDED: at most `limit`
 * rows (default MAX_LIST). For a UI list use listCallsPage; for "all calls of a local day" pass `date`.
 */
export async function listCalls(
  businessId?: ID, date?: string, tz?: string, opts: { limit?: number; flaggedSince?: Date } = {},
): Promise<Call[]> {
  const rows = await prisma.call.findMany({
    where: {
      kind: 'customer', // owner call-in sessions (voice/owner) are not customer calls
      ...(businessId ? { businessId } : {}),
      ...(date ? { startedAt: dayRange(date, tz) } : {}),
      ...(opts.flaggedSince ? { flaggedReason: { not: null }, startedAt: { gte: opts.flaggedSince } } : {}),
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: clampLimit(opts.limit, MAX_LIST, MAX_LIST),
  });
  return rows.map(toCall);
}

/** How many calls the business has logged (a count, not a list). */
export async function countCalls(businessId: ID): Promise<number> {
  return prisma.call.count({ where: { businessId, kind: 'customer' } });
}

/** Cursor-paginated calls, newest first. */
export async function listCallsPage(businessId: ID, opts: { limit?: number; cursor?: string | null; voicemailOnly?: boolean } = {}): Promise<Page<Call>> {
  const limit = clampLimit(opts.limit);
  const cur = parseTimeCursor(opts.cursor);
  const rows = await prisma.call.findMany({
    where: {
      businessId, kind: 'customer',
      // A voicemail is a call whose Twilio recording is stored (the URL is only ever written after the recording notice was spoken).
      ...(opts.voicemailOnly ? { recordingUrl: { startsWith: 'https://api.twilio.com/2010-04-01/Accounts/' } } : {}),
      ...(cur ? { OR: [{ startedAt: { lt: cur.at } }, { startedAt: cur.at, id: { lt: cur.id } }] } : {}),
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  return toPage(rows, limit, toCall, (r) => encodeTimeCursor(r.startedAt, r.id));
}

// ---------- bookings ----------
export type BookingRejection = SlotRejection | 'call_cap' | 'no_call' | 'slot_taken' | 'invalid_time' | 'business_not_found' | 'booking_not_found' | 'not_reschedulable' | 'calendar_busy';

/** Thrown by createBooking when the slot cannot be booked; `reason` is machine-readable. */
export class BookingRejectedError extends Error {
  constructor(public reason: BookingRejection) {
    super(`booking rejected: ${reason}`);
    this.name = 'BookingRejectedError';
  }
}

/** Postgres exclusion violation (23P01) / unique violation, however Prisma surfaces it. */
function isOverlapViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string; meta?: { code?: string; message?: string } };
  const text = `${e?.message ?? ''} ${e?.meta?.message ?? ''}`;
  return (
    e?.meta?.code === '23P01' || e?.code === '23P01' ||
    /bookings_no_overlap|exclusion constraint|23P01/i.test(text)
  );
}

/**
 * Atomically books a slot: advisory lock per business, re-validation (not in the past,
 * inside opening hours and finishing by close), duration-overlap check against
 * non-cancelled bookings, insert. A Postgres exclusion constraint is the backstop.
 * Throws BookingRejectedError for any business-rule rejection. Pass `{ enforce: false }`
 * to skip only the past/hours validation (overlap is always enforced). `max_per_call` caps
 * non-cancelled bookings per call_id inside the transaction ('call_cap').
 */
export async function createBooking(
  input: Partial<Booking> & {
    business_id: ID; customer_name: string; customer_phone: string;
    service: string; scheduled_at: string;
  },
  opts: { enforce?: boolean; max_per_call?: number } = {},
): Promise<Booking> {
  const enforce = opts.enforce ?? true;
  const start = new Date(input.scheduled_at);
  if (Number.isNaN(start.getTime())) throw new BookingRejectedError('invalid_time');
  const duration = clampDuration(input.duration_minutes);
  const candidate: Interval = { start: start.getTime(), end: start.getTime() + duration * 60_000 };
  const status = input.status ?? 'confirmed';

  let row;
  try {
    row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.business_id}))`;
      const biz = await tx.business.findUnique({ where: { id: input.business_id } });
      if (!biz) throw new BookingRejectedError('business_not_found');

      // Per-call cap: counted under the same advisory lock as the insert, so concurrent calls cannot overshoot.
      if (opts.max_per_call != null) {
        // A capped booking must belong to a call row (its key is what the cap counts on): no key, no booking.
        if (!input.call_id) throw new BookingRejectedError('no_call');
        const made = await tx.booking.count({ where: { callId: input.call_id, status: { not: 'cancelled' } } });
        if (made >= opts.max_per_call) throw new BookingRejectedError('call_cap');
      }

      if (enforce) {
        const v = validateSlot(toBusiness(biz).hours, candidate.start, duration, tzOf(biz.timezone), Date.now(), 0, closedDatesOf(biz.closedDates));
        if (!v.ok) throw new BookingRejectedError(v.reason);
      }

      if (status !== 'cancelled') {
        const near = await tx.booking.findMany({
          where: {
            businessId: input.business_id,
            status: { not: 'cancelled' },
            scheduledAt: {
              gte: new Date(candidate.start - MAX_DURATION_MIN * 60_000),
              lt: new Date(candidate.end),
            },
          },
          select: { scheduledAt: true, durationMinutes: true },
        });
        const clash = near.some((b) => intervalsOverlap(candidate, bookingInterval({
          scheduled_at: b.scheduledAt.toISOString(), duration_minutes: b.durationMinutes,
        })));
        if (clash) throw new BookingRejectedError('slot_taken');
        // Owner's Google Calendar busy time (healthy connection + "block on busy" on); same transaction, same advisory lock.
        if (enforce && (await calendarBusyConflict(tx, input.business_id, candidate.start, candidate.end))) throw new BookingRejectedError('calendar_busy');
      }

      return tx.booking.create({
        data: {
          businessId: input.business_id,
          callId: input.call_id ?? null,
          customerName: input.customer_name,
          customerPhone: input.customer_phone,
          phoneE164: toE164(input.customer_phone, countryForBusiness({ phone_e164: biz.phoneE164 })),
          service: input.service,
          scheduledAt: start,
          durationMinutes: duration,
          address: input.address ?? null,
          priceEstimate: input.price_estimate ?? null,
          depositAmount: input.deposit_amount ?? null,
          depositPaid: input.deposit_paid ?? false,
          status,
          followupConsentAt: input.followup_consent_at ? new Date(input.followup_consent_at) : null,
          followupConsentSource: input.followup_consent_source ?? null,
          rescheduledFromId: input.rescheduled_from_id ?? null,
          stripePaymentIntentId: input.stripe_payment_intent_id ?? null,
          stripeCheckoutSessionId: input.stripe_checkout_session_id ?? null,
        },
      });
    });
  } catch (err) {
    if (err instanceof BookingRejectedError) throw err;
    if (isOverlapViolation(err)) throw new BookingRejectedError('slot_taken');
    throw err;
  }

  log.info('booking.created', {
    id: row.id,
    business: input.business_id,
    service: input.service,
    at: input.scheduled_at,
    minutes: duration,
    deposit_cents: input.deposit_amount ?? null,
  });
  return toBooking(row);
}

/** Bookings (soonest first), BOUNDED to `limit` rows (default MAX_LIST). UI lists use listBookingsPage / listBookingsInRange. */
export async function listBookings(businessId?: ID, date?: string, tz?: string, opts: { limit?: number } = {}): Promise<Booking[]> {
  const rows = await prisma.booking.findMany({
    where: {
      ...(businessId ? { businessId } : {}),
      ...(date ? { scheduledAt: dayRange(date, tz) } : {}),
    },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    take: clampLimit(opts.limit, MAX_LIST, MAX_LIST),
  });
  return rows.map(toBooking);
}

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

/**
 * Bookings that OVERLAP the half-open range [fromUtc, toUtc) (a job that started before `fromUtc` but runs into it is
 * included), soonest first, scoped to ONE business. Keyset-paginated: pass the previous page's `next_cursor` as `cursor`.
 * One indexed range scan on (business_id, scheduled_at): the calendar fetches exactly the visible week/day/month.
 * Cancelled bookings are included (the calendar shows them struck through); pass `statuses` to narrow.
 */
export async function listBookingsInRange(
  businessId: ID,
  fromUtc: Date | string,
  toUtc: Date | string,
  opts: { limit?: number; cursor?: string | null; statuses?: Booking['status'][] } = {},
): Promise<Page<Booking>> {
  const from = asDate(fromUtc);
  const to = asDate(toUtc);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return { items: [], next_cursor: null };
  const limit = clampLimit(opts.limit, 100, MAX_PAGE_SIZE_RANGE);
  const cur = parseTimeCursor(opts.cursor);
  const earliestStart = new Date(from.getTime() - MAX_DURATION_MIN * 60_000);
  const rows = await prisma.booking.findMany({
    where: {
      businessId,
      scheduledAt: { gte: cur && cur.at > earliestStart ? cur.at : earliestStart, lt: to },
      ...(opts.statuses?.length ? { status: { in: opts.statuses } } : {}),
      ...(cur ? { NOT: { scheduledAt: cur.at, id: { lte: cur.id } } } : {}),
    },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  });
  const more = rows.length > limit;
  const slice = more ? rows.slice(0, limit) : rows;
  // The lower bound is widened by the longest possible job; trim the ones that really ended before `from`.
  const items = slice
    .map(toBooking)
    .filter((b) => bookingInterval(b).end > from.getTime());
  return { items, next_cursor: more && slice.length > 0 ? encodeTimeCursor(slice[slice.length - 1].scheduledAt, slice[slice.length - 1].id) : null };
}

/** Every booking overlapping [from, to), following cursors up to `max` rows (a month never has that many for one business). */
export async function listAllBookingsInRange(businessId: ID, from: Date | string, to: Date | string, max = 2000): Promise<{ items: Booking[]; truncated: boolean }> {
  const items: Booking[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<Booking> = await listBookingsInRange(businessId, from, to, { limit: MAX_PAGE_SIZE_RANGE, cursor });
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor && items.length < max);
  return { items: items.slice(0, max), truncated: Boolean(cursor) || items.length > max };
}

/**
 * Agenda list: `upcoming` = jobs that have not ended yet (soonest first), `past` = jobs that already ended (most recent
 * first). Cursor-paginated; `now` is injectable for tests.
 */
export async function listBookingsPage(
  businessId: ID,
  opts: { direction: 'upcoming' | 'past'; limit?: number; cursor?: string | null; now?: Date },
): Promise<Page<Booking>> {
  const limit = clampLimit(opts.limit);
  const cur = parseTimeCursor(opts.cursor);
  const now = opts.now ?? new Date();
  const upcoming = opts.direction === 'upcoming';
  // A job that started before `now` but has not ended yet is "in progress": it belongs to `upcoming` (it leads the first page)
  // and NEVER to `past`, so it is never listed twice.
  const runningRows = await prisma.booking.findMany({
    where: { businessId, scheduledAt: { gte: new Date(now.getTime() - MAX_DURATION_MIN * 60_000), lt: now } },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
  });
  const running = runningRows.map(toBooking).filter((b) => bookingInterval(b).end > now.getTime());
  const runningIds = new Set(running.map((b) => b.id));
  const rows = await prisma.booking.findMany({
    where: {
      businessId,
      scheduledAt: upcoming ? { gte: now } : { lt: now },
      ...(!upcoming && runningIds.size > 0 ? { id: { notIn: [...runningIds] } } : {}),
      ...(cur
        ? { OR: upcoming
          ? [{ scheduledAt: { gt: cur.at } }, { scheduledAt: cur.at, id: { gt: cur.id } }]
          : [{ scheduledAt: { lt: cur.at } }, { scheduledAt: cur.at, id: { lt: cur.id } }] }
        : {}),
    },
    orderBy: upcoming ? [{ scheduledAt: 'asc' }, { id: 'asc' }] : [{ scheduledAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const page = toPage(rows, limit, toBooking, (r) => encodeTimeCursor(r.scheduledAt, r.id));
  if (upcoming && !cur) page.items.unshift(...running);
  return page;
}

export type BookingTransition = 'cancelled' | 'completed';

export type TransitionResult =
  | { ok: true; booking: Booking; changed: boolean; previous: Booking['status'] }
  | { ok: false; reason: 'not_found' | 'invalid_transition' | 'not_started'; current?: Booking['status'] };

/**
 * Owner-driven status change, scoped to the business (a booking of another tenant is `not_found`). Atomic: the update is
 * conditional on the status it was validated against, so two concurrent clicks cannot both "win".
 *  - cancelled: from pending | confirmed (a completed job cannot be cancelled); idempotent when already cancelled.
 *  - completed: from pending | confirmed, and only once the job has started; idempotent when already completed.
 * Cancelling frees the slot (cancelled bookings never block anything).
 */
export async function transitionBooking(
  businessId: ID, bookingId: ID, to: BookingTransition, now: Date = new Date(), opts: { reason?: string | null } = {},
): Promise<TransitionResult> {
  const row = await prisma.booking.findFirst({ where: { id: bookingId, businessId } });
  if (!row) return { ok: false, reason: 'not_found' };
  const previous = row.status as Booking['status'];
  if (previous === to) return { ok: true, booking: toBooking(row), changed: false, previous };
  if (previous !== 'pending' && previous !== 'confirmed') return { ok: false, reason: 'invalid_transition', current: previous };
  if (to === 'completed' && row.scheduledAt.getTime() > now.getTime()) return { ok: false, reason: 'not_started', current: previous };
  const res = await prisma.booking.updateMany({
    where: { id: bookingId, businessId, status: previous },
    data: to === 'cancelled' ? { status: to, cancelledAt: now, cancelReason: opts.reason ? opts.reason.slice(0, 500) : null } : { status: to },
  });
  const fresh = await prisma.booking.findFirst({ where: { id: bookingId, businessId } });
  if (!fresh) return { ok: false, reason: 'not_found' };
  if (res.count === 0) {
    // Lost a race: report what is there now (same target = fine, anything else = conflict).
    return fresh.status === to
      ? { ok: true, booking: toBooking(fresh), changed: false, previous }
      : { ok: false, reason: 'invalid_transition', current: fresh.status as Booking['status'] };
  }
  log.info('booking.transitioned', { id: bookingId, business: businessId, from: previous, to });
  return { ok: true, booking: toBooking(fresh), changed: true, previous };
}

/** Bookings scheduled for, or created on, a local calendar day (briefing bucketing). */
export async function listBookingsForDay(businessId: ID, date: string, tz?: string): Promise<Booking[]> {
  const range = dayRange(date, tz);
  const rows = await prisma.booking.findMany({
    where: {
      businessId,
      OR: [{ scheduledAt: range }, { createdAt: range }],
    },
    orderBy: { scheduledAt: 'asc' },
  });
  return rows.map(toBooking);
}

export async function getBooking(id: ID): Promise<Booking | null> {
  const row = await prisma.booking.findUnique({ where: { id } });
  return row ? toBooking(row) : null;
}

export async function updateBooking(id: ID, patch: Partial<Booking>): Promise<Booking | null> {
  const data = bookingPatch(patch);
  if (Object.keys(data).length === 0) return getBooking(id);
  if ('customerPhone' in data) {
    const owner = await prisma.booking.findUnique({ where: { id }, select: { businessId: true } });
    data.phoneE164 = owner ? await e164ForBusiness(data.customerPhone as string, owner.businessId) : null;
  }
  try {
    const row = await prisma.booking.update({ where: { id }, data });
    log.debug('booking.updated', { id, fields: Object.keys(data) });
    return toBooking(row);
  } catch (err) {
    if (isRecordNotFound(err)) return null;
    log.warn('booking.update_failed', { id, fields: Object.keys(data), err });
    throw err;
  }
}

/**
 * Blocked time ranges (non-cancelled bookings, scheduled_at + duration) that intersect
 * [fromMs, toMs). One ranged query — replaces whole-history scans.
 */
export async function listBlockingIntervals(businessId: ID, fromMs: number, toMs: number): Promise<Interval[]> {
  const rows = await prisma.booking.findMany({
    where: {
      businessId,
      status: { not: 'cancelled' },
      scheduledAt: { gte: new Date(fromMs - MAX_DURATION_MIN * 60_000), lt: new Date(toMs) },
    },
    select: { scheduledAt: true, durationMinutes: true },
  });
  return rows
    .map((b) => bookingInterval({ scheduled_at: b.scheduledAt.toISOString(), duration_minutes: b.durationMinutes }))
    .filter((iv) => iv.end > fromMs && iv.start < toMs);
}

/** Start instants (ISO) of non-cancelled bookings on a local day. Kept for compatibility. */
export async function getBookedSlots(businessId: ID, date: string, tz?: string): Promise<string[]> {
  const { gte, lt } = dayRange(date, tz);
  const intervals = await listBlockingIntervals(businessId, gte.getTime(), lt.getTime());
  return intervals.map((iv) => new Date(iv.start).toISOString());
}

/**
 * Record a successful deposit (Stripe webhook / demo checkout). Idempotent; sets
 * deposit_paid + deposit_amount (integer cents); only a `pending` booking becomes
 * `confirmed` — cancelled/completed bookings keep their status.
 */
export async function markDepositPaid(bookingId: string, amountCents: number): Promise<{ updated: boolean }> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    log.warn('deposit.invalid_amount', { booking: bookingId, amount_cents: amountCents });
    return { updated: false };
  }
  const paid = await prisma.booking.updateMany({
    where: {
      id: bookingId,
      OR: [{ depositPaid: false }, { depositAmount: null }, { depositAmount: { not: amountCents } }],
    },
    data: { depositPaid: true, depositAmount: amountCents },
  });
  const confirmed = await prisma.booking.updateMany({
    where: { id: bookingId, status: 'pending' },
    data: { status: 'confirmed' },
  });
  const updated = paid.count > 0 || confirmed.count > 0;
  if (updated) log.info('deposit.paid', { booking: bookingId, amount_cents: amountCents, confirmed: confirmed.count > 0 });
  return { updated };
}

// ---------- reschedule, notification and refunds ----------

export interface RescheduleInput {
  business_id: ID;
  booking_id: ID;
  /** The new start (ISO). */
  scheduled_at: string;
  /** The new length; default: keep the current one. */
  duration_minutes?: number;
  /** Who moved it (recorded in the audit event). Default: system. */
  actor?: { kind?: 'user' | 'admin_token' | 'system' | 'webhook'; user_id?: string | null; ip?: string | null; reason?: string | null };
}

export interface RescheduleResult {
  booking: Booking;
  /** What it was before the move. */
  previous: { scheduled_at: string; duration_minutes: number };
  /** False when the new time and length equal the old ones (nothing was written). */
  changed: boolean;
}

/**
 * Move a booking to a new time ATOMICALLY: under the same per-business advisory lock as createBooking it re-validates the new slot
 * (not in the past, inside opening hours; skip with `{ enforce: false }`), checks the overlap against every OTHER non-cancelled booking
 * and updates the row in place (the `bookings_no_overlap` exclusion constraint is the backstop). It bumps `reschedule_count`, clears
 * `customer_notified_at` (the customer must be told again) and writes an audit event `booking.rescheduled` whose meta holds the previous
 * and new time, all in the same transaction.
 * Throws BookingRejectedError: 'booking_not_found' (also another business's booking), 'not_reschedulable' (only pending/confirmed move),
 * 'invalid_time', a SlotRejection (past / outside hours), or 'slot_taken'.
 */
export async function rescheduleBooking(input: RescheduleInput, opts: { enforce?: boolean } = {}): Promise<RescheduleResult> {
  const enforce = opts.enforce ?? true;
  const start = new Date(input.scheduled_at);
  if (Number.isNaN(start.getTime())) throw new BookingRejectedError('invalid_time');
  let result: RescheduleResult;
  try {
    result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.business_id}))`;
      const biz = await tx.business.findUnique({ where: { id: input.business_id } });
      if (!biz) throw new BookingRejectedError('business_not_found');
      const cur = await tx.booking.findFirst({ where: { id: input.booking_id, businessId: input.business_id } });
      if (!cur) throw new BookingRejectedError('booking_not_found');
      if (cur.status !== 'pending' && cur.status !== 'confirmed') throw new BookingRejectedError('not_reschedulable');
      const duration = clampDuration(input.duration_minutes ?? cur.durationMinutes);
      const previous = { scheduled_at: cur.scheduledAt.toISOString(), duration_minutes: cur.durationMinutes };
      if (cur.scheduledAt.getTime() === start.getTime() && cur.durationMinutes === duration) return { booking: toBooking(cur), previous, changed: false };
      const candidate: Interval = { start: start.getTime(), end: start.getTime() + duration * 60_000 };
      if (enforce) {
        const v = validateSlot(toBusiness(biz).hours, candidate.start, duration, tzOf(biz.timezone), Date.now(), 0, closedDatesOf(biz.closedDates));
        if (!v.ok) throw new BookingRejectedError(v.reason);
      }
      const near = await tx.booking.findMany({
        where: {
          businessId: input.business_id, status: { not: 'cancelled' }, id: { not: cur.id },
          scheduledAt: { gte: new Date(candidate.start - MAX_DURATION_MIN * 60_000), lt: new Date(candidate.end) },
        },
        select: { scheduledAt: true, durationMinutes: true },
      });
      if (near.some((b) => intervalsOverlap(candidate, bookingInterval({ scheduled_at: b.scheduledAt.toISOString(), duration_minutes: b.durationMinutes })))) {
        throw new BookingRejectedError('slot_taken');
      }
      if (enforce && (await calendarBusyConflict(tx, input.business_id, candidate.start, candidate.end))) throw new BookingRejectedError('calendar_busy');
      const row = await tx.booking.update({
        where: { id: cur.id },
        data: { scheduledAt: start, durationMinutes: duration, rescheduleCount: { increment: 1 }, customerNotifiedAt: null },
      });
      await tx.auditEvent.create({
        data: {
          actorKind: input.actor?.kind ?? 'system', actorUserId: input.actor?.user_id ?? null, businessId: input.business_id,
          action: 'booking.rescheduled', target: `booking:${cur.id}`, ip: input.actor?.ip ? input.actor.ip.slice(0, 64) : null,
          meta: sanitizeAuditMeta({
            from: previous.scheduled_at, to: row.scheduledAt.toISOString(), previous_duration_minutes: previous.duration_minutes,
            duration_minutes: row.durationMinutes, reschedule_count: row.rescheduleCount, reason: input.actor?.reason ?? null,
          }) as object,
        },
      });
      return { booking: toBooking(row), previous, changed: true };
    });
  } catch (err) {
    if (err instanceof BookingRejectedError) throw err;
    if (isOverlapViolation(err)) throw new BookingRejectedError('slot_taken');
    throw err;
  }
  if (result.changed) log.info('booking.rescheduled', { id: input.booking_id, business: input.business_id, from: result.previous.scheduled_at, to: result.booking.scheduled_at });
  return result;
}

/** The customer was told about a cancel/reschedule. First stamp wins unless `force`. Returns whether a row changed. */
export async function markCustomerNotified(bookingId: ID, at: Date = new Date(), opts: { force?: boolean } = {}): Promise<boolean> {
  const res = await prisma.booking.updateMany({ where: { id: bookingId, ...(opts.force ? {} : { customerNotifiedAt: null }) }, data: { customerNotifiedAt: at } });
  return res.count === 1;
}

/** Remember the Stripe ids a payment was made with (webhook). Only the ids given are written; never blanks one. */
export async function setBookingStripeRefs(bookingId: ID, refs: { payment_intent_id?: string | null; checkout_session_id?: string | null }): Promise<boolean> {
  const data: Prisma.BookingUncheckedUpdateManyInput = {};
  if (refs.payment_intent_id) data.stripePaymentIntentId = refs.payment_intent_id.slice(0, 255);
  if (refs.checkout_session_id) data.stripeCheckoutSessionId = refs.checkout_session_id.slice(0, 255);
  if (Object.keys(data).length === 0) return false;
  const res = await prisma.booking.updateMany({ where: { id: bookingId }, data });
  return res.count === 1;
}

/** The booking a Stripe payment intent or checkout session belongs to (refund / dispute webhooks). */
export async function getBookingByStripeRef(ref: { payment_intent_id?: string; checkout_session_id?: string }): Promise<Booking | null> {
  const or: Prisma.BookingWhereInput[] = [];
  if (ref.payment_intent_id) or.push({ stripePaymentIntentId: ref.payment_intent_id });
  if (ref.checkout_session_id) or.push({ stripeCheckoutSessionId: ref.checkout_session_id });
  if (or.length === 0) return null;
  const row = await prisma.booking.findFirst({ where: { OR: or }, orderBy: { createdAt: 'desc' } });
  return row ? toBooking(row) : null;
}

export interface RecordRefundInput {
  /** INTEGER CENTS, > 0. */
  amount_cents: number;
  stripe_refund_id?: string | null;
  /** 'refunded' (default) once Stripe confirms; 'pending' while it is being processed. */
  status?: 'pending' | 'refunded';
  at?: Date;
}

/**
 * Record a refund of the deposit. Idempotent and monotonic: once a booking is 'refunded' nothing changes it again (a duplicate webhook
 * is `updated: false`); 'pending' may be recorded again or turn into 'refunded'/'failed'. Returns the booking as it is now.
 */
export async function recordRefund(bookingId: ID, input: RecordRefundInput): Promise<{ updated: boolean; booking: Booking | null }> {
  if (!Number.isInteger(input.amount_cents) || input.amount_cents <= 0) {
    log.warn('refund.invalid_amount', { booking: bookingId, amount_cents: input.amount_cents });
    return { updated: false, booking: await getBooking(bookingId) };
  }
  const status = input.status ?? 'refunded';
  const at = input.at ?? new Date();
  const res = await prisma.booking.updateMany({
    where: { id: bookingId, refundStatus: status === 'refunded' ? { not: 'refunded' } : { in: ['none', 'pending', 'failed'] } },
    data: {
      refundStatus: status, refundAmountCents: input.amount_cents, ...(input.stripe_refund_id ? { stripeRefundId: input.stripe_refund_id.slice(0, 255) } : {}),
      refundedAt: status === 'refunded' ? at : null,
    },
  });
  if (res.count === 1) log.info('refund.recorded', { booking: bookingId, status, amount_cents: input.amount_cents });
  return { updated: res.count === 1, booking: await getBooking(bookingId) };
}

/** The refund could not be made. Never downgrades a 'refunded' booking. `reason` is logged only (it can quote provider text). */
export async function markRefundFailed(bookingId: ID, reason?: string): Promise<{ updated: boolean; booking: Booking | null }> {
  const res = await prisma.booking.updateMany({ where: { id: bookingId, refundStatus: { in: ['none', 'pending', 'failed'] } }, data: { refundStatus: 'failed', refundedAt: null } });
  if (res.count === 1) log.warn('refund.failed', { booking: bookingId, reason: reason ? reason.slice(0, 200) : null });
  return { updated: res.count === 1, booking: await getBooking(bookingId) };
}

/**
 * Record a card dispute's state on the booking. Monotonic: a settled dispute ('won' / 'lost') is never reopened by an out-of-order
 * event; 'won' <-> 'lost' may still be corrected (funds reinstated after a loss). Returns whether the row changed.
 */
export async function setDisputeStatus(bookingId: ID, status: Exclude<DisputeStatus, 'none'>): Promise<boolean> {
  const where = status === 'open' ? { id: bookingId, disputeStatus: 'none' } : { id: bookingId, disputeStatus: { not: status } };
  return (await prisma.booking.updateMany({ where, data: { disputeStatus: status } })).count === 1;
}

/** No refund is owed (no paid deposit, or the policy says none). Only from 'none'. */
export async function markRefundNotApplicable(bookingId: ID): Promise<boolean> {
  const res = await prisma.booking.updateMany({ where: { id: bookingId, refundStatus: 'none' }, data: { refundStatus: 'not_applicable' } });
  return res.count === 1;
}

// ---------- briefings ----------
export async function createBriefing(input: Partial<Briefing> & {
  business_id: ID; date: string; transcript: string;
}): Promise<Briefing> {
  const data = {
    audioUrl: input.audio_url ?? null,
    transcript: input.transcript,
    stats: (input.stats ?? { calls: 0, bookings: 0, revenue: 0, flags: 0 }) as object,
  };
  const row = await prisma.briefing.upsert({
    where: { businessId_date: { businessId: input.business_id, date: input.date } },
    update: data,
    create: { businessId: input.business_id, date: input.date, ...data },
  });
  log.info('briefing.saved', {
    business: input.business_id,
    date: input.date,
    audio: input.audio_url ?? null,
    words: input.transcript.split(/\s+/).filter(Boolean).length,
  });
  return toBriefing(row);
}

/** Briefings, newest first, BOUNDED to `limit` rows (default 60 = about two months). UI: listBriefingsPage. */
export async function listBriefings(businessId: ID, opts: { limit?: number } = {}): Promise<Briefing[]> {
  const rows = await prisma.briefing.findMany({
    where: { businessId },
    orderBy: { date: 'desc' },
    take: clampLimit(opts.limit, 60, MAX_LIST),
  });
  return rows.map(toBriefing);
}

/** Cursor-paginated briefings (the cursor is the last date of the previous page). */
export async function listBriefingsPage(businessId: ID, opts: { limit?: number; cursor?: string | null } = {}): Promise<Page<Briefing>> {
  const limit = clampLimit(opts.limit, 14);
  const cursor = typeof opts.cursor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.cursor) ? opts.cursor : null;
  const rows = await prisma.briefing.findMany({
    where: { businessId, ...(cursor ? { date: { lt: cursor } } : {}) },
    orderBy: { date: 'desc' },
    take: limit + 1,
  });
  return toPage(rows, limit, toBriefing, (r) => r.date);
}

export async function getLatestBriefing(businessId: ID): Promise<Briefing | null> {
  const row = await prisma.briefing.findFirst({
    where: { businessId },
    orderBy: { date: 'desc' },
  });
  return row ? toBriefing(row) : null;
}

// ---------- sms log ----------
export async function logSms(entry: Omit<SmsLog, 'id' | 'created_at'>, opts: { country?: string } = {}): Promise<SmsLog> {
  const row = await prisma.smsLog.create({
    data: {
      businessId: entry.business_id,
      toPhone: entry.to_phone,
      toE164: opts.country ? toE164(entry.to_phone, opts.country) : await e164ForBusiness(entry.to_phone, entry.business_id),
      body: entry.body,
      kind: entry.kind,
      bookingId: entry.booking_id ?? null,
      providerId: entry.provider_id ?? null,
      status: entry.status,
      consentBasis: entry.consent_basis ?? null,
    },
  });
  log.debug('sms.logged', {
    business: entry.business_id,
    to: entry.to_phone,
    kind: entry.kind,
    status: entry.status,
  });
  return toSms(row);
}

/** Text log, newest first, BOUNDED to `limit` rows (default MAX_LIST). UI: listSmsPage. */
export async function listSms(businessId?: ID, opts: { limit?: number; kind?: string; since?: Date } = {}): Promise<SmsLog[]> {
  const rows = await prisma.smsLog.findMany({
    where: {
      ...(businessId ? { businessId } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.since ? { createdAt: { gte: opts.since } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: clampLimit(opts.limit, MAX_LIST, MAX_LIST),
  });
  return rows.map(toSms);
}

/** How many texts the business has logged (a count, not a list). */
export async function countSms(businessId: ID): Promise<number> {
  return prisma.smsLog.count({ where: { businessId } });
}

/** Cursor-paginated text log, newest first. */
export async function listSmsPage(businessId: ID, opts: { limit?: number; cursor?: string | null } = {}): Promise<Page<SmsLog>> {
  const limit = clampLimit(opts.limit);
  const cur = parseTimeCursor(opts.cursor);
  const rows = await prisma.smsLog.findMany({
    where: {
      businessId,
      ...(cur ? { OR: [{ createdAt: { lt: cur.at } }, { createdAt: cur.at, id: { lt: cur.id } }] } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  return toPage(rows, limit, toSms, (r) => encodeTimeCursor(r.createdAt, r.id));
}

/**
 * Gratitude texts that already went (or are waiting) to any of `phones` for this business, i.e. every status except the
 * retryable "blocked" ones. Indexed on (business, to_e164); raw numbers that never normalised are matched on `to_phone`.
 */
export async function listGratitudeSmsTo(businessId: ID, phones: string[], country: string = defaultPhoneCountry()): Promise<SmsLog[]> {
  const e164s = [...new Set(phones.map((p) => toE164(p, country)).filter((e): e is string => Boolean(e)))];
  const raws = [...new Set(phones)];
  if (e164s.length === 0 && raws.length === 0) return [];
  const rows = await prisma.smsLog.findMany({
    where: {
      businessId,
      kind: 'gratitude',
      status: { notIn: ['blocked_quiet_hours', 'blocked_cap'] },
      OR: [{ toE164: { in: e164s } }, { toPhone: { in: raws } }],
    },
    take: 5000,
  });
  return rows.map(toSms);
}

/** Bookings of one business (or all) in a status that STARTED in [from, to): the gratitude sweep's candidate window. */
export async function listBookingsStartedBetween(
  opts: { businessId?: ID; from: Date; to: Date; status?: Booking['status']; limit?: number },
): Promise<Booking[]> {
  const rows = await prisma.booking.findMany({
    where: {
      ...(opts.businessId ? { businessId: opts.businessId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      scheduledAt: { gte: opts.from, lt: opts.to },
    },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    take: clampLimit(opts.limit, MAX_LIST, MAX_LIST),
  });
  return rows.map(toBooking);
}

/** Sends inside a recent window — used for confirmation de-duplication. */
export async function findRecentSms(
  businessId: ID,
  opts: { kind: string; bookingId?: string | null; toE164?: string; withinMs: number },
): Promise<SmsLog | null> {
  const since = new Date(Date.now() - opts.withinMs);
  const rows = await prisma.smsLog.findMany({
    where: {
      businessId,
      kind: opts.kind,
      ...(opts.bookingId ? { bookingId: opts.bookingId } : {}),
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const match = opts.toE164
    ? rows.find((r) => (r.toE164 ?? toE164(r.toPhone)) === opts.toE164)
    : rows[0];
  return match ? toSms(match) : null;
}

// ---------- aggregates (SQL, not "load everything and count") ----------
export interface DashboardStats {
  /** Calls that started on the business's local day. */
  calls_today: number;
  /** Calls today in Spanish or mixed. */
  bilingual_today: number;
  /** Non-cancelled jobs that have not ended yet. */
  bookings_upcoming: number;
  /** INTEGER CENTS of deposits paid on bookings SCHEDULED in the business's current local month. */
  deposits_month_cents: number;
  /** INTEGER CENTS: price of confirmed/completed bookings created in the current local month. */
  revenue_month_cents: number;
  /** Calls in the last 7 days that were flagged for the owner. */
  needs_attention: number;
}

/** Local month bounds [first day 00:00, next month first day 00:00) as UTC instants. */
export function monthRange(dateKey: string, tz: string): { gte: Date; lt: Date } {
  const first = `${dateKey.slice(0, 7)}-01`;
  const [y, m] = dateKey.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { gte: zonedDayRange(first, tz).gte, lt: zonedDayRange(next, tz).gte };
}

export async function getDashboardStats(businessId: ID, tz: string, now: Date = new Date()): Promise<DashboardStats> {
  const today = localDateKey(now, tz);
  const day = dayRange(today, tz);
  const month = monthRange(today, tz);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
  const upcomingFloor = new Date(now.getTime() - MAX_DURATION_MIN * 60_000);
  const [callsToday, bilingual, upcomingRows, deposits, revenue, flagged] = await Promise.all([
    prisma.call.count({ where: { businessId, kind: 'customer', startedAt: day } }),
    prisma.call.count({ where: { businessId, kind: 'customer', startedAt: day, language: { in: ['es', 'mixed'] } } }),
    prisma.booking.findMany({
      where: { businessId, status: { not: 'cancelled' }, scheduledAt: { gte: upcomingFloor } },
      select: { scheduledAt: true, durationMinutes: true },
      take: 5000,
    }),
    prisma.booking.aggregate({ _sum: { depositAmount: true }, where: { businessId, depositPaid: true, scheduledAt: month } }),
    prisma.booking.aggregate({ _sum: { priceEstimate: true }, where: { businessId, status: { in: ['confirmed', 'completed'] }, createdAt: month } }),
    prisma.call.count({ where: { businessId, kind: 'customer', startedAt: { gte: weekAgo }, flaggedReason: { not: null } } }),
  ]);
  const nowMs = now.getTime();
  return {
    calls_today: callsToday,
    bilingual_today: bilingual,
    bookings_upcoming: upcomingRows.filter((b) => b.scheduledAt.getTime() + clampDuration(b.durationMinutes) * 60_000 > nowMs).length,
    deposits_month_cents: deposits._sum.depositAmount ?? 0,
    revenue_month_cents: revenue._sum.priceEstimate ?? 0,
    needs_attention: flagged,
  };
}

/** Is `phone` a number this business already knows (its owner, a booking customer or a past caller)? Indexed lookups on E.164. */
export async function isKnownContact(businessId: ID, phone: string): Promise<boolean> {
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { ownerPhoneE164: true, phoneE164: true } });
  if (!biz) return false;
  const e164 = toE164(phone, countryForBusiness({ phone_e164: biz.phoneE164 }));
  if (!e164) return false;
  if (biz.ownerPhoneE164 === e164) return true;
  const [booking, call] = await Promise.all([
    prisma.booking.findFirst({ where: { businessId, phoneE164: e164 }, select: { id: true } }),
    prisma.call.findFirst({ where: { businessId, kind: 'customer', callerE164: e164 }, select: { id: true } }),
  ]);
  return Boolean(booking || call);
}

// ---------- lifecycle ----------
/**
 * Wipes the tenant data for the seed script and the demo reset: EVERY table is emptied except
 *   - `_prisma_migrations` (schema history),
 *   - `pending_recording_deletions` (the queue the recordings above were just added to: provider-side audio must still be deleted),
 *   - admin accounts (role 'admin') with their sessions, recovery codes and passkeys (the operator must still be able to sign in).
 * Tables with no foreign key to a business (audit events, forward leases, rate limits, processed events, provision locks, trial
 * fingerprints, WebAuthn challenges, email tokens) are deleted explicitly: they would otherwise outlive the business they describe.
 * tests/db/clear-all.test.ts fills every table and fails when a new table is neither wiped nor listed above.
 */
export async function clearAll(): Promise<void> {
  // Destructive and reachable over HTTP (POST /api/demo/reset): always warn,
  // even at info-level logging, so a wiped database is never a mystery.
  log.warn('clear_all');
  await prisma.$transaction(async (tx) => {
    // The recordings at the provider must not outlive the only rows pointing at them: queue them first (same transaction).
    const withRecording = await tx.call.findMany({ where: { recordingUrl: { not: null } }, select: { recordingUrl: true, businessId: true } });
    await enqueueRecordingDeletions(tx, withRecording.map((c) => ({ url: c.recordingUrl, businessId: c.businessId })));
    // Leaves first (explicit, so the order does not depend on cascade rules), then the parents.
    await tx.callTranscriptEvent.deleteMany();
    await tx.calendarBusyBlock.deleteMany();
    await tx.calendarEventLink.deleteMany();
    await tx.calendarConnection.deleteMany();
    await tx.ownerKbChange.deleteMany();
    await tx.smsLog.deleteMany();
    await tx.smsOptOut.deleteMany();
    await tx.briefing.deleteMany();
    await tx.booking.deleteMany();
    await tx.call.deleteMany();
    await tx.usageCounter.deleteMany();
    await tx.forwardLease.deleteMany();
    await tx.knowledgeBase.deleteMany();
    await tx.emailToken.deleteMany();
    await tx.webauthnChallenge.deleteMany();
    await tx.auditEvent.deleteMany();
    await tx.processedEvent.deleteMany();
    await tx.rateLimitBucket.deleteMany();
    await tx.provisionLock.deleteMany();
    await tx.trialFingerprint.deleteMany();
    // Memberships first: the database trigger that keeps a person with SEVERAL businesses alive when one is deleted would otherwise try to
    // re-point them to another business that this same statement is deleting (foreign key violation on a multi-business account).
    await tx.membership.deleteMany();
    await tx.user.deleteMany({ where: { role: { not: 'admin' } } }); // cascades their sessions, recovery codes, passkeys
    await tx.userSession.updateMany({ where: { activeBusinessId: { not: null } }, data: { activeBusinessId: null } });
    await tx.business.deleteMany(); // cascades anything left
  });
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

