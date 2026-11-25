/**
 * Durable briefing audio: the bytes live in Postgres (table briefing_audio, <= 5 MB, one row per briefing), so they survive redeploys and
 * need no volume. `briefings.audio_url` keeps its meaning ("where the dashboard plays it"): for stored audio it is `/api/briefings/<id>/audio`
 * (the authenticated route Phase 2 adds); legacy rows keep their `/audio/<file>` URL. The row cascades with its briefing, so the existing
 * retention purge and customer erasure remove it with no extra code; `pruneBriefingAudio` trims audio earlier than the briefing itself.
 */
import { prisma, type DbClient } from './client';
import { logger } from '@/lib/log';
import { BRIEFING_AUDIO_MAX_BYTES, BRIEFING_AUDIO_TYPES } from '@/lib/business-config';
import type { BriefingAudioMeta, ID } from '@/lib/types';

const log = logger('db.briefing-audio');

/** The playable URL stored in briefings.audio_url for audio kept in the database. */
export const briefingAudioUrl = (briefingId: ID): string => `/api/briefings/${briefingId}/audio`;
/** True for the route URL of a stored briefing (as opposed to a legacy /audio/<file> URL). */
export const isStoredBriefingAudioUrl = (url: string | null | undefined): boolean => typeof url === 'string' && /^\/api\/briefings\/[A-Za-z0-9_-]{1,64}\/audio$/.test(url);

export type SaveBriefingAudioResult =
  | { ok: true; meta: BriefingAudioMeta; audio_url: string }
  | { ok: false; reason: 'briefing_not_found' | 'empty' | 'too_large' | 'bad_type' };

const metaOf = (a: { briefingId: string; contentType: string; voiceId: string | null; textHash: string | null; createdAt: Date }, size: number): BriefingAudioMeta => ({
  briefing_id: a.briefingId, content_type: a.contentType, size_bytes: size, voice_id: a.voiceId, text_hash: a.textHash, created_at: a.createdAt.toISOString(),
});

/**
 * Store (or replace) the audio of a briefing of this business and point `briefings.audio_url` at the route, atomically.
 * Refused when the briefing is not this business's, the clip is empty / over 5 MB, or the type is not an audio type we serve.
 */
export async function saveBriefingAudio(
  businessId: ID, briefingId: ID, input: { content_type: string; bytes: Uint8Array | ArrayBuffer; voice_id?: string | null; text_hash?: string | null },
): Promise<SaveBriefingAudioResult> {
  const data = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  if (data.byteLength === 0) return { ok: false, reason: 'empty' };
  if (data.byteLength > BRIEFING_AUDIO_MAX_BYTES) return { ok: false, reason: 'too_large' };
  if (!(BRIEFING_AUDIO_TYPES as readonly string[]).includes(input.content_type)) return { ok: false, reason: 'bad_type' };
  const copy = new Uint8Array(data); // detach from any shared buffer; also gives Prisma a plain Uint8Array<ArrayBuffer>
  const url = briefingAudioUrl(briefingId);
  const voiceId = input.voice_id ? String(input.voice_id).slice(0, 100) : null;
  const textHash = input.text_hash && /^[0-9a-f]{64}$/.test(input.text_hash) ? input.text_hash : null;
  return prisma.$transaction(async (tx) => {
    const briefing = await tx.briefing.findFirst({ where: { id: briefingId, businessId }, select: { id: true } });
    if (!briefing) return { ok: false, reason: 'briefing_not_found' } as const;
    const row = await tx.briefingAudio.upsert({
      where: { briefingId },
      create: { briefingId, contentType: input.content_type, bytes: copy, voiceId, textHash },
      update: { contentType: input.content_type, bytes: copy, voiceId, textHash, createdAt: new Date() },
    });
    await tx.briefing.update({ where: { id: briefingId }, data: { audioUrl: url } });
    log.info('briefing_audio.saved', { business: businessId, briefing: briefingId, bytes: copy.byteLength });
    return { ok: true, meta: metaOf(row, copy.byteLength), audio_url: url } as const;
  });
}

/** The audio of a briefing of this business, or null (none stored, or another tenant's briefing). */
export async function getBriefingAudio(businessId: ID, briefingId: ID): Promise<{ content_type: string; bytes: Buffer } | null> {
  const row = await prisma.briefingAudio.findFirst({ where: { briefingId, briefing: { businessId } } });
  return row ? { content_type: row.contentType, bytes: Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength) } : null; // no copy
}

/**
 * One byte range [start, end] (inclusive, 0-based) of the clip, cut INSIDE Postgres (`substring(bytea from .. for ..)`): a Range request reads only the
 * bytes it sends, never the whole clip. Null when there is no such clip for this business.
 */
export async function getBriefingAudioSlice(businessId: ID, briefingId: ID, start: number, end: number): Promise<Buffer | null> {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
  const rows = await prisma.$queryRaw<{ chunk: Uint8Array }[]>`
    SELECT substring(a."bytes" from ${start + 1}::int for ${end - start + 1}::int) AS chunk
      FROM "briefing_audio" a JOIN "briefings" b ON b."id" = a."briefing_id"
     WHERE a."briefing_id" = ${briefingId} AND b."business_id" = ${businessId}`;
  const c = rows[0]?.chunk;
  return c ? Buffer.from(c.buffer, c.byteOffset, c.byteLength) : null;
}

/** Metadata only (no bytes are read from the table beyond their length). */
export async function getBriefingAudioMeta(businessId: ID, briefingId: ID): Promise<BriefingAudioMeta | null> {
  const rows = await prisma.$queryRaw<{ briefing_id: string; content_type: string; voice_id: string | null; text_hash: string | null; created_at: Date; size: number }[]>`
    SELECT a."briefing_id", a."content_type", a."voice_id", a."text_hash", a."created_at", octet_length(a."bytes")::int AS size
      FROM "briefing_audio" a JOIN "briefings" b ON b."id" = a."briefing_id"
     WHERE a."briefing_id" = ${briefingId} AND b."business_id" = ${businessId}`;
  const r = rows[0];
  return r ? { briefing_id: r.briefing_id, content_type: r.content_type, size_bytes: r.size, voice_id: r.voice_id, text_hash: r.text_hash, created_at: r.created_at.toISOString() } : null;
}

/** Remove the stored audio of one briefing (and clear its audio_url when that pointed at the stored audio). True when a clip was removed. */
export async function deleteBriefingAudio(businessId: ID, briefingId: ID): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const res = await tx.briefingAudio.deleteMany({ where: { briefingId, briefing: { businessId } } });
    if (res.count > 0) await tx.briefing.updateMany({ where: { id: briefingId, businessId, audioUrl: briefingAudioUrl(briefingId) }, data: { audioUrl: null } });
    return res.count > 0;
  });
}

/** How long audio is kept in the database (days). BRIEFING_AUDIO_KEEP_DAYS, default 30; 0 or invalid = default; the briefing text follows retention_days regardless. */
export function briefingAudioKeepDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Math.floor(Number(env.BRIEFING_AUDIO_KEEP_DAYS));
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : 30;
}

/**
 * Cleanup: delete stored audio older than `keepDays` (default briefingAudioKeepDays()) and clear `audio_url` of those briefings so the dashboard
 * shows no player instead of a broken one. Idempotent; the briefing text/stats stay. Returns how many clips were removed.
 */
export async function pruneBriefingAudio(opts: { now?: Date; keepDays?: number } = {}, db: DbClient = prisma): Promise<{ removed: number }> {
  const now = opts.now ?? new Date();
  const days = opts.keepDays ?? briefingAudioKeepDays();
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const rows = await db.$queryRaw<{ briefing_id: string }[]>`
    DELETE FROM "briefing_audio" WHERE "created_at" < ${cutoff}::timestamptz RETURNING "briefing_id"`;
  if (rows.length > 0) {
    await db.$executeRaw`
      UPDATE "briefings" SET "audio_url" = NULL
       WHERE "id" = ANY(${rows.map((r) => r.briefing_id)}::text[]) AND "audio_url" = '/api/briefings/' || "id" || '/audio'`;
    log.info('briefing_audio.pruned', { removed: rows.length, keep_days: days });
  }
  return { removed: rows.length };
}
