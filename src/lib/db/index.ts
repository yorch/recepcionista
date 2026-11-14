/**
 * Single import point for persistence. Local JSON store today; swap the
 * implementation body for Supabase without touching callers.
 */
import { readDb, mutate, newId, nowIso } from './store';
import type {
  Business, KnowledgeBase, Call, Booking, Briefing, SmsLog, ID, Hours,
} from '@/lib/types';

export { newId, nowIso };

const DEFAULT_HOURS: Hours = {
  monday: { open: '08:00', close: '18:00' },
  tuesday: { open: '08:00', close: '18:00' },
  wednesday: { open: '08:00', close: '18:00' },
  thursday: { open: '08:00', close: '18:00' },
  friday: { open: '08:00', close: '18:00' },
  saturday: { open: '09:00', close: '14:00' },
  sunday: null,
};

// ---------- businesses ----------
export function listBusinesses(): Business[] {
  return readDb().businesses.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function getBusiness(id: ID): Business | null {
  return readDb().businesses.find((b) => b.id === id) ?? null;
}

export function getBusinessByPhone(phone: string): Business | null {
  const norm = (p: string) => p.replace(/\D/g, '').slice(-10);
  return readDb().businesses.find((b) => b.phone && norm(b.phone) === norm(phone)) ?? null;
}

export function createBusiness(
  input: Partial<Business> & { name: string },
): Business {
  const biz: Business = {
    id: newId(),
    name: input.name,
    url: input.url ?? null,
    phone: input.phone ?? null,
    owner_phone: input.owner_phone ?? null,
    owner_name: input.owner_name ?? null,
    hours: input.hours ?? DEFAULT_HOURS,
    service_area: input.service_area ?? [],
    status: input.status ?? 'onboarding',
    created_at: nowIso(),
  };
  mutate((db) => db.businesses.push(biz));
  return biz;
}

export function updateBusiness(id: ID, patch: Partial<Business>): Business | null {
  return mutate((db) => {
    const i = db.businesses.findIndex((b) => b.id === id);
    if (i < 0) return null;
    db.businesses[i] = { ...db.businesses[i], ...patch, id };
    return db.businesses[i];
  });
}

// ---------- knowledge bases ----------
export function getKnowledgeBase(businessId: ID): KnowledgeBase | null {
  return readDb().knowledge_bases.find((k) => k.business_id === businessId) ?? null;
}

export function upsertKnowledgeBase(
  businessId: ID,
  patch: Partial<Omit<KnowledgeBase, 'id' | 'business_id' | 'updated_at'>>,
): KnowledgeBase {
  return mutate((db) => {
    const existing = db.knowledge_bases.find((k) => k.business_id === businessId);
    if (existing) {
      Object.assign(existing, patch, { updated_at: nowIso() });
      return existing;
    }
    const kb: KnowledgeBase = {
      id: newId(),
      business_id: businessId,
      services: patch.services ?? [],
      faqs: patch.faqs ?? [],
      pricing_notes: patch.pricing_notes ?? '',
      system_prompt: patch.system_prompt ?? '',
      call_script: patch.call_script ?? '',
      updated_at: nowIso(),
    };
    db.knowledge_bases.push(kb);
    return kb;
  });
}

// ---------- calls ----------
export function createCall(input: Partial<Call> & { business_id: ID }): Call {
  const call: Call = {
    id: newId(),
    business_id: input.business_id,
    caller_phone: input.caller_phone ?? null,
    caller_name: input.caller_name ?? null,
    started_at: input.started_at ?? nowIso(),
    ended_at: input.ended_at ?? null,
    duration_sec: input.duration_sec ?? null,
    language: input.language ?? null,
    transcript: input.transcript ?? null,
    summary: input.summary ?? null,
    urgency: input.urgency ?? 'unsure',
    status: input.status ?? 'in_progress',
    recording_url: input.recording_url ?? null,
    flagged_reason: input.flagged_reason ?? null,
  };
  mutate((db) => db.calls.push(call));
  return call;
}

export function updateCall(id: ID, patch: Partial<Call>): Call | null {
  return mutate((db) => {
    const i = db.calls.findIndex((c) => c.id === id);
    if (i < 0) return null;
    db.calls[i] = { ...db.calls[i], ...patch, id };
    return db.calls[i];
  });
}

export function getCall(id: ID): Call | null {
  return readDb().calls.find((c) => c.id === id) ?? null;
}

export function listCalls(businessId?: ID, date?: string): Call[] {
  return readDb().calls
    .filter((c) => (businessId ? c.business_id === businessId : true))
    .filter((c) => (date ? c.started_at.startsWith(date) : true))
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

// ---------- bookings ----------
export function createBooking(input: Partial<Booking> & {
  business_id: ID; customer_name: string; customer_phone: string;
  service: string; scheduled_at: string;
}): Booking {
  const booking: Booking = {
    id: newId(),
    call_id: input.call_id ?? null,
    business_id: input.business_id,
    customer_name: input.customer_name,
    customer_phone: input.customer_phone,
    service: input.service,
    scheduled_at: input.scheduled_at,
    address: input.address ?? null,
    price_estimate: input.price_estimate ?? null,
    deposit_amount: input.deposit_amount ?? null,
    deposit_paid: input.deposit_paid ?? false,
    status: input.status ?? 'confirmed',
    created_at: nowIso(),
  };
  mutate((db) => db.bookings.push(booking));
  return booking;
}

export function listBookings(businessId?: ID, date?: string): Booking[] {
  return readDb().bookings
    .filter((b) => (businessId ? b.business_id === businessId : true))
    .filter((b) => (date ? b.scheduled_at.startsWith(date) : true))
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
}

export function getBooking(id: ID): Booking | null {
  return readDb().bookings.find((b) => b.id === id) ?? null;
}

export function updateBooking(id: ID, patch: Partial<Booking>): Booking | null {
  return mutate((db) => {
    const i = db.bookings.findIndex((b) => b.id === id);
    if (i < 0) return null;
    db.bookings[i] = { ...db.bookings[i], ...patch, id };
    return db.bookings[i];
  });
}

export function getBookedSlots(businessId: ID, date: string): string[] {
  return listBookings(businessId, date).map((b) => b.scheduled_at);
}

// ---------- briefings ----------
export function createBriefing(input: Partial<Briefing> & {
  business_id: ID; date: string; transcript: string;
}): Briefing {
  const briefing: Briefing = {
    id: newId(),
    business_id: input.business_id,
    date: input.date,
    audio_url: input.audio_url ?? null,
    transcript: input.transcript,
    stats: input.stats ?? { calls: 0, bookings: 0, revenue: 0, flags: 0 },
    created_at: nowIso(),
  };
  mutate((db) => {
    const i = db.briefings.findIndex(
      (b) => b.business_id === briefing.business_id && b.date === briefing.date,
    );
    if (i >= 0) db.briefings[i] = briefing;
    else db.briefings.push(briefing);
  });
  return briefing;
}

export function listBriefings(businessId: ID): Briefing[] {
  return readDb().briefings
    .filter((b) => b.business_id === businessId)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function getLatestBriefing(businessId: ID): Briefing | null {
  return listBriefings(businessId)[0] ?? null;
}

// ---------- sms log ----------
export function logSms(entry: Omit<SmsLog, 'id' | 'created_at'>): SmsLog {
  const row: SmsLog = { ...entry, id: newId(), created_at: nowIso() };
  mutate((db) => db.sms_log.push(row));
  return row;
}

export function listSms(businessId?: ID): SmsLog[] {
  return readDb().sms_log
    .filter((s) => (businessId ? s.business_id === businessId : true))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export const DEFAULT_HOURS_EXPORT = DEFAULT_HOURS;
