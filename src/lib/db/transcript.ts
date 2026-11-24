/**
 * Live call transcript: one row per utterance (`call_transcript_events`). Node runtime only.
 *
 * Privacy: events are NEVER stored for a call whose consent is 'declined' (the helper refuses, and a database trigger skips the
 * insert as a backstop; a call that becomes 'declined' loses its rows). Rows are deleted with the call (retention purge, erasure).
 */
import { prisma, type DbClient } from './client';
import type { TranscriptEvent, TranscriptRole } from '@/lib/types';

export const MAX_TRANSCRIPT_BATCH = 500;
export const MAX_TRANSCRIPT_TEXT = 20_000;
const ROLES: readonly TranscriptRole[] = ['agent', 'caller', 'system'];

export interface TranscriptEventInput {
  seq: number;
  role: TranscriptRole;
  text: string;
  at: Date | string;
  /** Default true. An interim (false) row is replaced when the same seq arrives again; a final row never changes. */
  is_final?: boolean;
}

export type AppendResult =
  | { ok: true; stored: number; skipped: number }
  | { ok: false; reason: 'call_not_found' | 'consent_declined' | 'invalid_events' | 'too_many_events' };

function clean(e: TranscriptEventInput): { seq: number; role: TranscriptRole; text: string; at: Date; is_final: boolean } | null {
  const at = new Date(e.at);
  if (!Number.isInteger(e.seq) || e.seq < 0 || !ROLES.includes(e.role) || typeof e.text !== 'string' || Number.isNaN(at.getTime())) return null;
  return { seq: e.seq, role: e.role, text: e.text.slice(0, MAX_TRANSCRIPT_TEXT), at, is_final: e.is_final !== false };
}

/**
 * Idempotent append: upserts by (call, seq), so a retried batch or an interim -> final update never duplicates. A FINAL row is
 * immutable (a late interim cannot overwrite it). One statement per batch, and the consent check is part of that statement.
 * Refuses (stores nothing) for an unknown call, a declined call, a malformed event or more than 500 events.
 * `stored` counts rows inserted or updated, `skipped` the ones left alone (already final).
 */
export async function appendTranscriptEvents(callId: string, events: TranscriptEventInput[], db: DbClient = prisma): Promise<AppendResult> {
  if (events.length > MAX_TRANSCRIPT_BATCH) return { ok: false, reason: 'too_many_events' };
  const rows = events.map(clean);
  if (rows.some((r) => r === null)) return { ok: false, reason: 'invalid_events' };
  // last write wins inside one batch for the same seq (a single statement may not touch a row twice)
  const bySeq = new Map<number, NonNullable<(typeof rows)[number]>>();
  for (const r of rows) if (r) bySeq.set(r.seq, r);
  const list = [...bySeq.values()];
  const call = await db.call.findUnique({ where: { id: callId }, select: { consentStatus: true } });
  if (!call) return { ok: false, reason: 'call_not_found' };
  if (call.consentStatus === 'declined') return { ok: false, reason: 'consent_declined' };
  if (list.length === 0) return { ok: true, stored: 0, skipped: 0 };
  const stored = await db.$queryRaw<{ seq: number }[]>`
    INSERT INTO "call_transcript_events" ("id", "call_id", "seq", "role", "text", "at", "is_final")
    SELECT gen_random_uuid()::text, c."id", t."seq", t."role", t."text", t."at", t."is_final"
      FROM "calls" c
      CROSS JOIN LATERAL unnest(${list.map((e) => e.seq)}::int[], ${list.map((e) => e.role)}::text[], ${list.map((e) => e.text)}::text[],
                                ${list.map((e) => e.at.toISOString())}::text[]::timestamptz[], ${list.map((e) => e.is_final)}::boolean[]) AS t("seq", "role", "text", "at", "is_final")
     WHERE c."id" = ${callId} AND c."consent_status" <> 'declined'
    ON CONFLICT ("call_id", "seq") DO UPDATE
      SET "role" = EXCLUDED."role", "text" = EXCLUDED."text", "at" = EXCLUDED."at", "is_final" = EXCLUDED."is_final"
      WHERE "call_transcript_events"."is_final" = false
    RETURNING "seq"`;
  if (stored.length === 0 && list.length > 0) {
    // either every row was already final, or consent flipped to declined between the read and the insert
    const still = await db.call.findUnique({ where: { id: callId }, select: { consentStatus: true } });
    if (!still) return { ok: false, reason: 'call_not_found' };
    if (still.consentStatus === 'declined') return { ok: false, reason: 'consent_declined' };
  }
  return { ok: true, stored: stored.length, skipped: list.length - stored.length };
}

/**
 * Events with seq > afterSeq (use -1 for all), oldest first, at most `limit` (default 200, max 500). Pass `businessId` to scope the
 * read to that business's call (a call of another tenant yields nothing): the HTTP layer should always pass it.
 */
export async function listTranscriptEventsAfter(
  callId: string, afterSeq: number, limit = 200, opts: { businessId?: string } = {},
): Promise<TranscriptEvent[]> {
  const n = Math.min(Math.max(Math.floor(limit) || 200, 1), MAX_TRANSCRIPT_BATCH);
  const after = Number.isFinite(afterSeq) ? Math.floor(afterSeq) : -1;
  const rows = await prisma.callTranscriptEvent.findMany({
    where: { callId, seq: { gt: after }, ...(opts.businessId ? { call: { businessId: opts.businessId } } : {}) },
    orderBy: { seq: 'asc' }, take: n,
  });
  return rows.map((r) => ({ call_id: r.callId, seq: r.seq, role: r.role as TranscriptRole, text: r.text, at: r.at.toISOString(), is_final: r.isFinal }));
}

/** The highest stored seq of a call (-1 when none): where a resumed stream continues. */
export async function lastTranscriptSeq(callId: string): Promise<number> {
  const r = await prisma.callTranscriptEvent.aggregate({ where: { callId }, _max: { seq: true } });
  return r._max.seq ?? -1;
}

/** Delete every transcript event of a call (consent withdrawn, owner request). Returns how many. */
export async function deleteTranscriptEvents(callId: string): Promise<number> {
  const res = await prisma.callTranscriptEvent.deleteMany({ where: { callId } });
  return res.count;
}
