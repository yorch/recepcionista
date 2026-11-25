/**
 * Leads the owner can reply to: recent customer calls and bookings of THIS business, newest first, one per customer number.
 * The numbered reference the owner says ("reply to number 2") is a snapshot taken when the leads were listed on THIS owner call
 * (processed_events rows `owner-lead-ref` / `<owner call id>:<n>:<kind>:<row id>`), so the numbers cannot shift under the owner and the model
 * can never name a row id or a phone number: the recipient is always re-derived from the row, scoped to the business.
 */
import crypto from 'node:crypto';
import { countryForBusiness, isOptedOut, prisma } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { PAUSED_FLAG, FORWARD_UNANSWERED_FLAG } from '@/lib/voice/non-ai';
import type { Business, Call } from '@/lib/types';
import { OWNER_REPLY_DISCLOSED_PER_DAY, OWNER_REPLY_HANDLED_PER_DAY, OWNER_REPLY_LEADS_SHOWN, OWNER_REPLY_LEAD_WINDOW_MS } from './reply-config';
import { ownerBudgetId, type OwnerTrust } from './config';
import { handledMarkerId, HANDLED_SOURCE, type HandledClass } from './reply-marker';
import { firstNameOf, last4Of, type LeadKind } from './reply-text';

const REF_SOURCE = 'owner-lead-ref';
const DISCLOSED_SOURCE = 'owner-lead-disc';
const HANDLED_LOG_SOURCE = 'owner-lead-handled-log';
const DAY_MS = 24 * 3600_000;

export interface Lead {
  n: number;
  kind: LeadKind;
  rowKind: 'call' | 'booking';
  rowId: string;
  e164: string;
  name: string | null;
  last4: string;
  at: Date;
  textable: boolean;
}

function callKind(c: { urgency: string; status: string; flaggedReason: string | null; recordingUrl: string | null }): LeadKind {
  if (c.urgency === 'emergency') return 'emergency';
  if (c.status === 'handed_off') return 'handoff';
  const unanswered = c.flaggedReason === PAUSED_FLAG || c.flaggedReason === FORWARD_UNANSWERED_FLAG;
  if (unanswered && c.recordingUrl) return 'voicemail';
  if (unanswered || c.status === 'failed') return 'missed';
  return 'call';
}

const classOf = (trust: OwnerTrust): HandledClass => (trust === 'verified' ? 'v' : 'u');

/**
 * Was this number marked handled (after `since`)? A mark made on a verified call hides the lead from every listing; a mark made on an unverified
 * call (possibly a spoofed caller id) hides it only from unverified listings, so a spoofer can never hide a lead from an attested owner call.
 */
export async function isHandled(businessId: string, e164: string, since: Date, trust: OwnerTrust = 'unverified'): Promise<boolean> {
  const classes: HandledClass[] = trust === 'verified' ? ['v'] : ['v', 'u'];
  const row = await prisma.processedEvent.findFirst({
    where: { source: HANDLED_SOURCE, id: { in: classes.map((c) => handledMarkerId(businessId, e164, c)) }, claimedAt: { gte: since } }, select: { id: true },
  });
  return row !== null;
}

export async function markHandled(businessId: string, e164: string, trust: OwnerTrust = 'unverified', now: Date = new Date()): Promise<void> {
  const id = handledMarkerId(businessId, e164, classOf(trust));
  await prisma.processedEvent.upsert({ where: { source_id: { source: HANDLED_SOURCE, id } }, create: { source: HANDLED_SOURCE, id, status: 'done', claimedAt: now }, update: { claimedAt: now } });
}

/**
 * Reserve one "handled" mark against the per-class daily budget (atomic: advisory lock + count + insert of a log row that holds only the budget key
 * and a random id, never a number). False = the budget is spent.
 */
export async function reserveHandled(businessId: string, trust: OwnerTrust, now: Date = new Date()): Promise<boolean> {
  const budget = ownerBudgetId(businessId, trust);
  const cap = OWNER_REPLY_HANDLED_PER_DAY[trust];
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`owner-handled:${budget}`}))`;
    const used = await tx.processedEvent.count({ where: { source: HANDLED_LOG_SOURCE, id: { startsWith: `${budget}:` }, claimedAt: { gte: new Date(now.getTime() - DAY_MS) } } });
    if (used >= cap) return false;
    await tx.processedEvent.create({ data: { source: HANDLED_LOG_SOURCE, id: `${budget}:${crypto.randomUUID()}`, status: 'done', claimedAt: now } });
    return true;
  });
}

/** The recent leads of this business (newest first, one per customer number, handled ones left out), numbered 1..N. Does not store anything. */
export async function collectLeads(business: Business, now: Date = new Date(), trust: OwnerTrust = 'unverified'): Promise<Omit<Lead, 'n'>[]> {
  const since = new Date(now.getTime() - OWNER_REPLY_LEAD_WINDOW_MS);
  const country = countryForBusiness(business);
  const [calls, bookings] = await Promise.all([
    prisma.call.findMany({
      where: { businessId: business.id, kind: 'customer', callerE164: { not: null }, startedAt: { gte: since, lte: now } },
      orderBy: { startedAt: 'desc' }, take: 60,
      select: { id: true, callerE164: true, callerName: true, startedAt: true, urgency: true, status: true, flaggedReason: true, recordingUrl: true },
    }),
    prisma.booking.findMany({
      where: { businessId: business.id, phoneE164: { not: null }, anonymizedAt: null, createdAt: { gte: since, lte: now } },
      orderBy: { createdAt: 'desc' }, take: 60,
      select: { id: true, phoneE164: true, customerName: true, createdAt: true },
    }),
  ]);
  const all: Omit<Lead, 'n' | 'textable'>[] = [
    ...calls.map((c) => ({ kind: callKind(c), rowKind: 'call' as const, rowId: c.id, e164: c.callerE164 as string, name: firstNameOf(c.callerName), last4: last4Of(c.callerE164 as string), at: c.startedAt })),
    ...bookings.map((b) => ({ kind: 'booking' as const, rowKind: 'booking' as const, rowId: b.id, e164: b.phoneE164 as string, name: firstNameOf(b.customerName), last4: last4Of(b.phoneE164 as string), at: b.createdAt })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime() || a.rowId.localeCompare(b.rowId));
  const owner = business.owner_phone_e164 ?? null;
  const seen = new Set<string>();
  const out: Omit<Lead, 'n'>[] = [];
  for (const l of all) {
    if (seen.has(l.e164)) continue;
    seen.add(l.e164);
    if (l.e164 === owner || (business.phone_e164 && l.e164 === business.phone_e164)) continue; // never the owner or the business line itself
    if (await isHandled(business.id, l.e164, l.at, trust)) continue;
    // A name seen on an earlier call of the same number is better than none, but only a plain one-word name is ever kept.
    out.push({ ...l, textable: !(await isOptedOut(business.id, l.e164, country)) });
    if (out.length >= OWNER_REPLY_LEADS_SHOWN) break;
  }
  return out;
}

/**
 * Apply the per-class daily DISCLOSURE budget to a candidate list (newest first). A lead already disclosed to this class in the last 24 h is free to
 * list again; a new one needs budget, and when it is spent the older candidates are cut. Atomic (advisory lock), so concurrent lists cannot overshoot.
 * The ledger rows hold only the budget key and the lead ROW id (no number, no name).
 */
async function discloseWithinBudget<T extends { rowKind: string; rowId: string }>(businessId: string, trust: OwnerTrust, leads: T[], now: Date): Promise<T[]> {
  if (leads.length === 0) return leads;
  const budget = ownerBudgetId(businessId, trust);
  const cap = OWNER_REPLY_DISCLOSED_PER_DAY[trust];
  const since = new Date(now.getTime() - DAY_MS);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`owner-disc:${budget}`}))`;
    const rows = await tx.processedEvent.findMany({ where: { source: DISCLOSED_SOURCE, id: { startsWith: `${budget}:` }, claimedAt: { gte: since } }, select: { id: true } });
    const known = new Set(rows.map((r) => r.id));
    let room = cap - known.size;
    const out: T[] = [];
    const fresh: string[] = [];
    for (const l of leads) {
      const id = `${budget}:${l.rowKind}:${l.rowId}`;
      if (known.has(id)) { out.push(l); continue; }
      if (room <= 0) continue;
      room--;
      fresh.push(id);
      out.push(l);
    }
    if (fresh.length) await tx.processedEvent.createMany({ data: fresh.map((id) => ({ source: DISCLOSED_SOURCE, id, status: 'done', claimedAt: now })), skipDuplicates: true });
    return out;
  });
}

/** List the leads and remember their numbers for this owner call (replacing any earlier list of the same call). */
export async function snapshotLeads(business: Business, ownerCall: Call, now: Date = new Date(), trust: OwnerTrust = 'unverified'): Promise<{ leads: Lead[]; capped: boolean }> {
  const candidates = await collectLeads(business, now, trust);
  const allowed = await discloseWithinBudget(business.id, trust, candidates, now);
  const leads = allowed.map((l, i) => ({ ...l, n: i + 1 }));
  await prisma.processedEvent.deleteMany({ where: { source: REF_SOURCE, id: { startsWith: `${ownerCall.id}:` } } });
  if (leads.length) {
    await prisma.processedEvent.createMany({
      data: leads.map((l) => ({ source: REF_SOURCE, id: `${ownerCall.id}:${l.n}:${l.rowKind}:${l.rowId}`, status: 'done', claimedAt: now })),
      skipDuplicates: true,
    });
  }
  return { leads, capped: allowed.length < candidates.length };
}

export type ResolvedLead = Omit<Lead, 'n' | 'textable'> & { n: number };

/**
 * The lead behind a spoken number, or null. Re-derived from the database on every use: the row must belong to THIS business, still be a customer
 * row inside the lead window and not anonymised/erased; its E.164 comes from the row, never from a snapshot or from the model.
 */
export async function resolveLead(business: Business, ownerCall: Call, n: number, now: Date = new Date()): Promise<ResolvedLead | null> {
  const ref = await prisma.processedEvent.findFirst({ where: { source: REF_SOURCE, id: { startsWith: `${ownerCall.id}:${n}:` } }, select: { id: true } });
  if (!ref) return null;
  const [, , rowKind, ...rest] = ref.id.split(':');
  const rowId = rest.join(':');
  const since = new Date(now.getTime() - OWNER_REPLY_LEAD_WINDOW_MS);
  if (rowKind === 'call') {
    const c = await prisma.call.findFirst({
      where: { id: rowId, businessId: business.id, kind: 'customer', callerE164: { not: null }, startedAt: { gte: since } },
      select: { id: true, callerE164: true, callerName: true, startedAt: true, urgency: true, status: true, flaggedReason: true, recordingUrl: true },
    });
    const e164 = c?.callerE164 ? toE164(c.callerE164) : null;
    if (!c || !e164) return null;
    return { n, kind: callKind(c), rowKind: 'call', rowId: c.id, e164, name: firstNameOf(c.callerName), last4: last4Of(e164), at: c.startedAt };
  }
  if (rowKind === 'booking') {
    const b = await prisma.booking.findFirst({
      where: { id: rowId, businessId: business.id, phoneE164: { not: null }, anonymizedAt: null, createdAt: { gte: since } },
      select: { id: true, phoneE164: true, customerName: true, createdAt: true },
    });
    const e164 = b?.phoneE164 ? toE164(b.phoneE164) : null;
    if (!b || !e164) return null;
    return { n, kind: 'booking', rowKind: 'booking', rowId: b.id, e164, name: firstNameOf(b.customerName), last4: last4Of(e164), at: b.createdAt };
  }
  return null;
}
