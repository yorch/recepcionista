import { fail, ok } from '@/lib/http';
import { clientKey } from '@/lib/auth';
import { auditActorOf, authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { getBriefingAudio, getBriefingAudioMeta, getBriefingAudioSlice, getBusiness, recordAudit } from '@/lib/db';
import { prisma } from '@/lib/db/client';
import { rateLimit } from '@/lib/ratelimit';
import { attachBriefingAudio, canReuseBriefingAudio, type BriefingAudioOutcome } from '@/lib/briefing';
import type { Briefing } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Text-to-speech calls the owner's "Generate audio" button may spend per business per day (a clip for the same text and voice is never synthesized again). */
export const BRIEFING_AUDIO_DAILY_LIMIT = 10;

/** The briefing's tenant, or null (no such briefing). Callers answer 404 for a briefing of another business, exactly like a missing one. */
async function briefingOf(id: string) {
  if (!ID.test(id)) return null;
  const row = await prisma.briefing.findUnique({ where: { id } });
  return row;
}

/** A zero-copy view of a Buffer as a response body. */
const asBody = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);

/** One Range header value against a clip of `size` bytes: [start, end] inclusive, 'invalid' (416) or null (not a single range: send it all). */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null; // multi-range / malformed: ignore the header (a full 200 is always valid)
  let start: number;
  let end: number;
  if (!m[1]) { // suffix: the last N bytes
    const n = Number(m[2]);
    if (!(n > 0)) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return 'invalid';
  return { start, end };
}

/**
 * GET /api/briefings/:id/audio   Staff+, tenant-scoped (another business's briefing, or one without audio, is a 404).
 * Streams the stored clip (table briefing_audio) with its own content-type, `accept-ranges: bytes` + Range support (seeking), an ETag (304 on
 * If-None-Match) and `private` caching: the clip never changes for a given ETag and must never be stored by a shared cache.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    const briefing = await briefingOf(id);
    requireBusinessAccess(auth.principal, briefing?.businessId);
    if (!briefing) return fail('no audio for this briefing', 404);
    const meta = await getBriefingAudioMeta(briefing.businessId, id); // metadata only: the clip itself is read only when it is actually sent
    if (!meta) return fail('no audio for this briefing', 404);

    const etag = `"${new Date(meta.created_at).getTime().toString(36)}-${meta.size_bytes.toString(36)}"`;
    const headers: Record<string, string> = {
      'content-type': meta.content_type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600, must-revalidate',
      etag, 'x-content-type-options': 'nosniff', vary: 'Cookie',
    };
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });

    const size = meta.size_bytes;
    const range = parseRange(req.headers.get('range'), size);
    if (range === 'invalid') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    if (range) {
      const part = await getBriefingAudioSlice(briefing.businessId, id, range.start, range.end); // cut inside Postgres: only these bytes are read
      if (!part) return fail('no audio for this briefing', 404);
      return new Response(asBody(part), {
        status: 206, headers: { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(part.byteLength) },
      });
    }
    const audio = await getBriefingAudio(briefing.businessId, id);
    if (!audio) return fail('no audio for this briefing', 404);
    return new Response(asBody(audio.bytes), { headers: { ...headers, 'content-length': String(audio.bytes.byteLength) } });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/**
 * POST /api/briefings/:id/audio   OWNER. Regenerates the audio of an existing briefing from its stored text with the business's voice
 * (the text is not rewritten). A clip already stored for this text and voice is kept (no synthesis); a failed regeneration never deletes a good clip of the same text.
 * Rate limited per user and per hour, and capped per business per day (it spends text-to-speech budget), audited. The answer is honest: `status: 'unavailable'` plus a
 * `reason` when the provider is not configured or failed (the briefing then has no audio, never a stale one).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    const row = await briefingOf(id);
    requireBusinessAccess(auth.principal, row?.businessId);
    if (!row) return fail('briefing not found', 404);
    const who = auth.principal.user?.id ?? `admin:${auth.principal.kind}`;
    const mine = await rateLimit(`briefing-audio:user:${who}`, 5, 60_000);
    const theirs = await rateLimit(`briefing-audio:business:${row.businessId}`, 20, 60 * 60_000);
    const limited = !mine.allowed ? mine : !theirs.allowed ? theirs : null;
    if (limited) return Response.json({ ok: false, error: 'rate limit exceeded' }, { status: 429, headers: { 'retry-after': String(limited.retryAfterS) } });
    const business = await getBusiness(row.businessId);
    if (!business) return fail('business not found', 404);
    const briefing: Briefing = {
      id: row.id, business_id: row.businessId, date: row.date, audio_url: row.audioUrl, transcript: row.transcript,
      stats: row.stats as unknown as Briefing['stats'], created_at: row.createdAt.toISOString(),
    };
    // Spend guard: a clip that already exists for this exact text and voice is kept (no synthesis), and real synthesis is capped per business per day.
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const spentToday = await prisma.auditEvent.count({ where: { businessId: business.id, action: 'briefing.audio_regenerated', at: { gte: since }, meta: { path: ['synthesized'], equals: true } } });
    const existing = await getBriefingAudioMeta(business.id, id);
    const wouldReuse = canReuseBriefingAudio(existing, briefing.transcript, business); // the SAME predicate attachBriefingAudio applies: a clip it would re-synthesize counts toward the cap
    if (!wouldReuse && spentToday >= BRIEFING_AUDIO_DAILY_LIMIT) {
      return Response.json({ ok: false, error: 'Daily audio limit reached for this business. Try again tomorrow.', code: 'audio_daily_limit' }, { status: 429, headers: { 'retry-after': '3600' } });
    }
    const out = await attachBriefingAudio(business, briefing, { reuse: true });
    const synthesized = !(out.audio.status === 'ready' && out.audio.reused);
    const actor = auditActorOf(auth.principal);
    await recordAudit({
      actor_kind: actor.actor_kind, actor_user_id: actor.actor_user_id, business_id: business.id, action: 'briefing.audio_regenerated', target: `briefing:${id}`, ip: clientKey(req),
      meta: { ...actor.meta, status: out.audio.status, synthesized, ...(out.audio.status === 'unavailable' ? { reason: out.audio.reason } : {}) },
    });
    return ok<{ briefing_id: string; audio_url: string | null; audio: BriefingAudioOutcome }>({ briefing_id: id, audio_url: out.briefing.audio_url ?? null, audio: out.audio });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
