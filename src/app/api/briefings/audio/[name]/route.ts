import fs from 'node:fs/promises';
import path from 'node:path';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { AUDIO_DIR } from '@/lib/briefing/audio-files';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Briefing audio, authenticated. `/audio/<file>` (the stored `audio_url`) is rewritten here by next.config.ts, so
 * files written at runtime are served (Next only serves `public/` files that existed at build time) and only to a
 * user of the business the briefing belongs to (the business id is part of the generated file name).
 */
const NAME = /^briefing-([A-Za-z0-9_-]{1,64})-\d{4}-\d{2}-\d{2}\.(mp3|m4a)$/;
const TYPES: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4' };

export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const auth = await authenticate(req); // staff+
  if (!auth.ok) return auth.response;
  try {
    const { name } = await params;
    const m = NAME.exec(name);
    if (!m) return new Response('not found', { status: 404 });
    requireBusinessAccess(auth.principal, m[1]); // other tenants get 404, like every business-scoped route
    let data: Buffer;
    try {
      data = await fs.readFile(path.join(AUDIO_DIR, name));
    } catch {
      return new Response('not found', { status: 404 });
    }
    const headers: Record<string, string> = {
      'content-type': TYPES[m[2]], 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
    if (range && (range[1] || range[2])) {
      const size = data.length;
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      return new Response(new Uint8Array(data.subarray(start, end + 1)), {
        status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
      });
    }
    return new Response(new Uint8Array(data), { headers: { ...headers, 'content-length': String(data.length) } });
  } catch (err) {
    return authErrorResponse(err) ?? new Response('error', { status: 500 });
  }
}
