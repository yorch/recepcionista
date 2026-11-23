/**
 * Single import point for persistence — now Postgres via Prisma.
 *
 * Every function is async. Callers get plain domain objects from
 * `@/lib/types` (ISO date strings, not JS Dates), so no route, page or agent
 * tool ever touches Prisma types directly.
 */
import { prisma } from './client';
import { logger } from '@/lib/log';
import { dayRange as zonedDayRange, tzOf, DEFAULT_TIMEZONE, isValidTimeZone } from '@/lib/time';
import {
  bookingInterval, clampDuration, intervalsOverlap, validateSlot, MAX_DURATION_MIN,
  type Interval, type SlotRejection,
} from '@/lib/availability';
import { phoneKey } from '@/lib/format';
import type {
  Business, KnowledgeBase, Call, Booking, Briefing, SmsLog, ID, Hours,
  Service, FAQ, BriefingStats,
} from '@/lib/types';

export { prisma };
export { newId, nowIso } from './ids';

/** Every write logs what changed; reads stay quiet (they are the hot path). */
const log = logger('db');

const DEFAULT_HOURS: Hours = {
  monday: { open: '08:00', close: '18:00' },
  tuesday: { open: '08:00', close: '18:00' },
  wednesday: { open: '08:00', close: '18:00' },
  thursday: { open: '08:00', close: '18:00' },
  friday: { open: '08:00', close: '18:00' },
  saturday: { open: '09:00', close: '14:00' },
  sunday: null,
};

// ---------- mappers: DB row -> domain object ----------
/* eslint-disable @typescript-eslint/no-explicit-any */

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoReq = (d: Date): string => d.toISOString();

function toBusiness(row: any): Business {
  return {
    id: row.id,
    name: row.name,
    url: row.url ?? null,
    phone: row.phone ?? null,
    owner_phone: row.ownerPhone ?? null,
    owner_name: row.ownerName ?? null,
    hours: (row.hours ?? DEFAULT_HOURS) as Hours,
    service_area: (row.serviceArea ?? []) as string[],
    status: row.status,
    agent_id: row.agentId ?? null,
    timezone: tzOf(row.timezone),
    created_at: isoReq(row.createdAt),
  };
}

function toKnowledgeBase(row: any): KnowledgeBase {
  return {
    id: row.id,
    business_id: row.businessId,
    services: (row.services ?? []) as Service[],
    faqs: (row.faqs ?? []) as FAQ[],
    pricing_notes: row.pricingNotes ?? '',
    system_prompt: row.systemPrompt ?? '',
    call_script: row.callScript ?? '',
    updated_at: isoReq(row.updatedAt),
  };
}

function toCall(row: any): Call {
  return {
    id: row.id,
    business_id: row.businessId,
    call_sid: row.callSid ?? null,
    caller_phone: row.callerPhone ?? null,
    caller_name: row.callerName ?? null,
    started_at: isoReq(row.startedAt),
    ended_at: iso(row.endedAt),
    duration_sec: row.durationSec ?? null,
    language: row.language ?? null,
    transcript: row.transcript ?? null,
    summary: row.summary ?? null,
    urgency: row.urgency,
    status: row.status,
    recording_url: row.recordingUrl ?? null,
    flagged_reason: row.flaggedReason ?? null,
  };
}

function toBooking(row: any): Booking {
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
    status: row.status,
    created_at: isoReq(row.createdAt),
  };
}

function toBriefing(row: any): Briefing {
  return {
    id: row.id,
    business_id: row.businessId,
    date: row.date,
    audio_url: row.audioUrl ?? null,
    transcript: row.transcript,
    stats: (row.stats ?? { calls: 0, bookings: 0, revenue: 0, flags: 0 }) as BriefingStats,
    created_at: isoReq(row.createdAt),
  };
}

function toSms(row: any): SmsLog {
  return {
    id: row.id,
    business_id: row.businessId,
    to_phone: row.toPhone,
    body: row.body,
    kind: row.kind,
    booking_id: row.bookingId ?? null,
    provider_id: row.providerId ?? null,
    status: row.status,
    created_at: isoReq(row.createdAt),
  };
}

/** Domain patch -> Prisma column names. Only defined keys are written. */
function callPatch(patch: Partial<Call>) {
  const out: Record<string, unknown> = {};
  if (patch.call_sid !== undefined) out.callSid = patch.call_sid;
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
  return out;
}

function bookingPatch(patch: Partial<Booking>) {
  const out: Record<string, unknown> = {};
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
  return out;
}

function businessPatch(patch: Partial<Business>) {
  const out: Record<string, unknown> = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.url !== undefined) out.url = patch.url;
  if (patch.phone !== undefined) { out.phone = patch.phone; out.phoneKey = phoneKey(patch.phone); }
  if (patch.timezone !== undefined && isValidTimeZone(patch.timezone)) out.timezone = patch.timezone;
  if (patch.owner_phone !== undefined) out.ownerPhone = patch.owner_phone;
  if (patch.owner_name !== undefined) out.ownerName = patch.owner_name;
  if (patch.hours !== undefined) out.hours = patch.hours;
  if (patch.service_area !== undefined) out.serviceArea = patch.service_area;
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.agent_id !== undefined) out.agentId = patch.agent_id;
  return out;
}

/** Local YYYY-MM-DD day bounds in the business zone, as a UTC range (DST-correct). */
function dayRange(date: string, tz: string = DEFAULT_TIMEZONE): { gte: Date; lt: Date } {
  return zonedDayRange(date, tz);
}

// ---------- businesses ----------
export async function listBusinesses(): Promise<Business[]> {
  const rows = await prisma.business.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map(toBusiness);
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

/** Indexed lookup on the normalized (last-10-digit) phone key — no table scan. */
export async function getBusinessByPhone(phone: string): Promise<Business | null> {
  const key = phoneKey(phone);
  if (!key) return null;
  const row = await prisma.business.findFirst({ where: { phoneKey: key }, orderBy: { createdAt: 'asc' } });
  return row ? toBusiness(row) : null;
}

export async function createBusiness(
  input: Partial<Business> & { name: string },
): Promise<Business> {
  const row = await prisma.business.create({
    data: {
      name: input.name,
      url: input.url ?? null,
      phone: input.phone ?? null,
      phoneKey: phoneKey(input.phone),
      timezone: isValidTimeZone(input.timezone) ? input.timezone : DEFAULT_TIMEZONE,
      ownerPhone: input.owner_phone ?? null,
      ownerName: input.owner_name ?? null,
      hours: (input.hours ?? DEFAULT_HOURS) as object,
      serviceArea: input.service_area ?? [],
      status: input.status ?? 'onboarding',
    },
  });
  log.info('business.created', { id: row.id, name: row.name, url: row.url });
  return toBusiness(row);
}

export async function updateBusiness(id: ID, patch: Partial<Business>): Promise<Business | null> {
  const data = businessPatch(patch);
  if (Object.keys(data).length === 0) return getBusiness(id);
  try {
    const row = await prisma.business.update({ where: { id }, data });
    log.debug('business.updated', { id, fields: Object.keys(data) });
    return toBusiness(row);
  } catch (err) {
    // Swallowed on purpose (callers treat a missing row as a 404), but a silent
    // null used to be indistinguishable from "nothing to update".
    log.warn('business.update_failed', { id, fields: Object.keys(data), err });
    return null;
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

// ---------- calls ----------
export async function createCall(input: Partial<Call> & { business_id: ID }): Promise<Call> {
  const row = await prisma.call.create({
    data: {
      businessId: input.business_id,
      callSid: input.call_sid ?? null,
      callerPhone: input.caller_phone ?? null,
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
  try {
    const row = await prisma.call.update({ where: { id }, data });
    log.debug('call.updated', { id, fields: Object.keys(data) });
    return toCall(row);
  } catch (err) {
    log.warn('call.update_failed', { id, fields: Object.keys(data), err });
    return null;
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

/**
 * Resolve the live call a tool belongs to. Strict order: explicit id, then SID, then —
 * only when unambiguous — the single in-progress call (optionally for this caller phone)
 * in the last few hours. Two concurrent callers => null rather than the wrong call.
 */
export async function findActiveCall(
  businessId: ID,
  hint: { callId?: string; callSid?: string; callerPhone?: string } = {},
  windowMs = 3 * 60 * 60 * 1000,
): Promise<Call | null> {
  if (hint.callId) {
    const row = await prisma.call.findFirst({ where: { id: hint.callId, businessId } });
    if (row) return toCall(row);
  }
  if (hint.callSid) {
    const row = await prisma.call.findFirst({ where: { callSid: hint.callSid, businessId } });
    if (row) return toCall(row);
  }
  const key = phoneKey(hint.callerPhone);
  const rows = await prisma.call.findMany({
    where: {
      businessId,
      status: 'in_progress',
      startedAt: { gte: new Date(Date.now() - windowMs) },
    },
    orderBy: { startedAt: 'desc' },
    take: 5,
  });
  if (key) {
    const mine = rows.filter((r) => phoneKey(r.callerPhone) === key);
    if (mine.length >= 1) return toCall(mine[0]);
  }
  // No "only call in progress" guess: without a trusted id/SID or a phone match, there is no call.
  return null;
}

export async function listCalls(businessId?: ID, date?: string, tz?: string): Promise<Call[]> {
  const row = await prisma.call.findMany({
    where: {
      ...(businessId ? { businessId } : {}),
      ...(date ? { startedAt: dayRange(date, tz) } : {}),
    },
    orderBy: { startedAt: 'desc' },
  });
  return row.map(toCall);
}

// ---------- bookings ----------
export type BookingRejection = SlotRejection | 'slot_taken' | 'invalid_time' | 'business_not_found';

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
 * to skip only the past/hours validation (overlap is always enforced).
 */
export async function createBooking(
  input: Partial<Booking> & {
    business_id: ID; customer_name: string; customer_phone: string;
    service: string; scheduled_at: string;
  },
  opts: { enforce?: boolean } = {},
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

      if (enforce) {
        const v = validateSlot(toBusiness(biz).hours, candidate.start, duration, tzOf(biz.timezone), Date.now());
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
      }

      return tx.booking.create({
        data: {
          businessId: input.business_id,
          callId: input.call_id ?? null,
          customerName: input.customer_name,
          customerPhone: input.customer_phone,
          service: input.service,
          scheduledAt: start,
          durationMinutes: duration,
          address: input.address ?? null,
          priceEstimate: input.price_estimate ?? null,
          depositAmount: input.deposit_amount ?? null,
          depositPaid: input.deposit_paid ?? false,
          status,
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

export async function listBookings(businessId?: ID, date?: string, tz?: string): Promise<Booking[]> {
  const rows = await prisma.booking.findMany({
    where: {
      ...(businessId ? { businessId } : {}),
      ...(date ? { scheduledAt: dayRange(date, tz) } : {}),
    },
    orderBy: { scheduledAt: 'asc' },
  });
  return rows.map(toBooking);
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
  try {
    const row = await prisma.booking.update({ where: { id }, data });
    log.debug('booking.updated', { id, fields: Object.keys(data) });
    return toBooking(row);
  } catch (err) {
    log.warn('booking.update_failed', { id, fields: Object.keys(data), err });
    return null;
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

export async function listBriefings(businessId: ID): Promise<Briefing[]> {
  const rows = await prisma.briefing.findMany({
    where: { businessId },
    orderBy: { date: 'desc' },
  });
  return rows.map(toBriefing);
}

export async function getLatestBriefing(businessId: ID): Promise<Briefing | null> {
  const row = await prisma.briefing.findFirst({
    where: { businessId },
    orderBy: { date: 'desc' },
  });
  return row ? toBriefing(row) : null;
}

// ---------- sms log ----------
export async function logSms(entry: Omit<SmsLog, 'id' | 'created_at'>): Promise<SmsLog> {
  const row = await prisma.smsLog.create({
    data: {
      businessId: entry.business_id,
      toPhone: entry.to_phone,
      body: entry.body,
      kind: entry.kind,
      bookingId: entry.booking_id ?? null,
      providerId: entry.provider_id ?? null,
      status: entry.status,
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

export async function listSms(businessId?: ID): Promise<SmsLog[]> {
  const rows = await prisma.smsLog.findMany({
    where: businessId ? { businessId } : {},
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toSms);
}

/** Sends inside a recent window — used for confirmation de-duplication. */
export async function findRecentSms(
  businessId: ID,
  opts: { kind: string; bookingId?: string | null; toLast10?: string; withinMs: number },
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
  });
  const match = opts.toLast10
    ? rows.find((r) => r.toPhone.replace(/\D/g, '').endsWith(opts.toLast10 as string))
    : rows[0];
  return match ? toSms(match) : null;
}

// ---------- lifecycle ----------
/** Deletes every row. Used by the seed script and the demo reset. */
export async function clearAll(): Promise<void> {
  // Destructive and reachable over HTTP (POST /api/demo/reset): always warn,
  // even at info-level logging, so a wiped database is never a mystery.
  log.warn('clear_all');
  await prisma.$transaction([
    prisma.smsLog.deleteMany(),
    prisma.briefing.deleteMany(),
    prisma.booking.deleteMany(),
    prisma.call.deleteMany(),
    prisma.knowledgeBase.deleteMany(),
    prisma.business.deleteMany(),
  ]);
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

export const DEFAULT_HOURS_EXPORT = DEFAULT_HOURS;
