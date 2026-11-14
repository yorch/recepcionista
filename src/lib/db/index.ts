/**
 * Single import point for persistence — now Postgres via Prisma.
 *
 * Every function is async. Callers get plain domain objects from
 * `@/lib/types` (ISO date strings, not JS Dates), so no route, page or agent
 * tool ever touches Prisma types directly.
 */
import { prisma } from './client';
import type {
  Business, KnowledgeBase, Call, Booking, Briefing, SmsLog, ID, Hours,
  Service, FAQ, BriefingStats,
} from '@/lib/types';

export { prisma };
export { newId, nowIso } from './ids';

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
  if (patch.phone !== undefined) out.phone = patch.phone;
  if (patch.owner_phone !== undefined) out.ownerPhone = patch.owner_phone;
  if (patch.owner_name !== undefined) out.ownerName = patch.owner_name;
  if (patch.hours !== undefined) out.hours = patch.hours;
  if (patch.service_area !== undefined) out.serviceArea = patch.service_area;
  if (patch.status !== undefined) out.status = patch.status;
  return out;
}

/** local YYYY-MM-DD day bounds in America/New_York, as a UTC range */
function dayRange(date: string): { gte: Date; lt: Date } {
  const gte = new Date(`${date}T00:00:00-05:00`);
  const lt = new Date(gte.getTime() + 24 * 60 * 60 * 1000);
  return { gte, lt };
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

export async function getBusinessByPhone(phone: string): Promise<Business | null> {
  const digits = phone.replace(/\D/g, '').slice(-10);
  const rows = await prisma.business.findMany({ where: { phone: { not: null } } });
  const row = rows.find((r) => r.phone && r.phone.replace(/\D/g, '').slice(-10) === digits);
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
      ownerPhone: input.owner_phone ?? null,
      ownerName: input.owner_name ?? null,
      hours: (input.hours ?? DEFAULT_HOURS) as object,
      serviceArea: input.service_area ?? [],
      status: input.status ?? 'onboarding',
    },
  });
  return toBusiness(row);
}

export async function updateBusiness(id: ID, patch: Partial<Business>): Promise<Business | null> {
  const data = businessPatch(patch);
  if (Object.keys(data).length === 0) return getBusiness(id);
  try {
    const row = await prisma.business.update({ where: { id }, data });
    return toBusiness(row);
  } catch {
    return null;
  }
}

// ---------- knowledge bases ----------
export async function getKnowledgeBase(businessId: ID): Promise<KnowledgeBase | null> {
  const row = await prisma.knowledgeBase.findUnique({ where: { businessId } });
  return row ? toKnowledgeBase(row) : null;
}

export async function upsertKnowledgeBase(
  businessId: ID,
  patch: Partial<Omit<KnowledgeBase, 'id' | 'business_id' | 'updated_at'>>,
): Promise<KnowledgeBase> {
  const data = {
    services: (patch.services ?? []) as object,
    faqs: (patch.faqs ?? []) as object,
    pricingNotes: patch.pricing_notes ?? '',
    systemPrompt: patch.system_prompt ?? '',
    callScript: patch.call_script ?? '',
  };

  const existing = await prisma.knowledgeBase.findUnique({ where: { businessId } });
  const row = existing
    ? await prisma.knowledgeBase.update({ where: { businessId }, data })
    : await prisma.knowledgeBase.create({ data: { businessId, ...data } });
  return toKnowledgeBase(row);
}

// ---------- calls ----------
export async function createCall(input: Partial<Call> & { business_id: ID }): Promise<Call> {
  const row = await prisma.call.create({
    data: {
      businessId: input.business_id,
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
  return toCall(row);
}

export async function updateCall(id: ID, patch: Partial<Call>): Promise<Call | null> {
  const data = callPatch(patch);
  if (Object.keys(data).length === 0) return getCall(id);
  try {
    const row = await prisma.call.update({ where: { id }, data });
    return toCall(row);
  } catch {
    return null;
  }
}

export async function getCall(id: ID): Promise<Call | null> {
  const row = await prisma.call.findUnique({ where: { id } });
  return row ? toCall(row) : null;
}

export async function listCalls(businessId?: ID, date?: string): Promise<Call[]> {
  const row = await prisma.call.findMany({
    where: {
      ...(businessId ? { businessId } : {}),
      ...(date ? { startedAt: dayRange(date) } : {}),
    },
    orderBy: { startedAt: 'desc' },
  });
  return row.map(toCall);
}

// ---------- bookings ----------
export async function createBooking(input: Partial<Booking> & {
  business_id: ID; customer_name: string; customer_phone: string;
  service: string; scheduled_at: string;
}): Promise<Booking> {
  const row = await prisma.booking.create({
    data: {
      businessId: input.business_id,
      callId: input.call_id ?? null,
      customerName: input.customer_name,
      customerPhone: input.customer_phone,
      service: input.service,
      scheduledAt: new Date(input.scheduled_at),
      address: input.address ?? null,
      priceEstimate: input.price_estimate ?? null,
      depositAmount: input.deposit_amount ?? null,
      depositPaid: input.deposit_paid ?? false,
      status: input.status ?? 'confirmed',
    },
  });
  return toBooking(row);
}

export async function listBookings(businessId?: ID, date?: string): Promise<Booking[]> {
  const rows = await prisma.booking.findMany({
    where: {
      ...(businessId ? { businessId } : {}),
      ...(date ? { scheduledAt: dayRange(date) } : {}),
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
    return toBooking(row);
  } catch {
    return null;
  }
}

export async function getBookedSlots(businessId: ID, date: string): Promise<string[]> {
  const bookings = await listBookings(businessId, date);
  return bookings.map((b) => b.scheduled_at);
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
  opts: { kind: string; toLast10?: string; withinMs: number },
): Promise<SmsLog | null> {
  const since = new Date(Date.now() - opts.withinMs);
  const rows = await prisma.smsLog.findMany({
    where: { businessId, kind: opts.kind, createdAt: { gte: since } },
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
