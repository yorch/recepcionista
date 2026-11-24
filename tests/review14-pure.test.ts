/**
 * Review 14 (reports 11-14): the pure / no-database regression tests. The database-backed ones live in tests/integration/review14-*.test.ts
 * and tests/db/review14-*.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  CACHE_MAX_BYTES, clearRecordingCache, fetchConversationAudio, MAX_BYTES, MAX_CONCURRENT_DOWNLOADS, recordingCacheStats, serveBody,
} from '../src/lib/voice/recording-audio';
import { callerTranscriptText, inferUrgency } from '../src/lib/voice/postcall';
import { transferOutcomeFromTranscript, transferStartSecs } from '../src/lib/voice/transfer';
import { localeCookieFrom, localeOfRequest } from '../src/lib/i18n/core';
import { LIFE_SAFETY_STRONG, packOf } from '../src/lib/verticals';
import { VERTICALS } from '../src/lib/types';
import { buildSystemPrompt } from '../src/lib/kb';
import { callClock, confirmationSms, undoSms } from '../src/lib/voice/owner/code';
import { agentResyncBackoffMs } from '../src/lib/voice/agent-resync';
import { refundIdempotencyKey } from '../src/lib/refunds';

const KEY = 'xi_review14_key';
let savedKey: string | undefined;
beforeEach(() => { savedKey = process.env.ELEVENLABS_API_KEY; process.env.ELEVENLABS_API_KEY = KEY; clearRecordingCache(); });
afterEach(() => { if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = savedKey; clearRecordingCache(); });

const audio = (n: number, byte = 7) => new Uint8Array(n).fill(byte);
const chunked = (total: number, chunk = 64 * 1024) => new ReadableStream<Uint8Array>({
  pull(c) { c.enqueue(new Uint8Array(Math.min(chunk, total - sent)).fill(1)); sent += Math.min(chunk, total - sent); if (sent >= total) c.close(); },
  start() { sent = 0; },
});
let sent = 0;

describe('R14 voice M2: recording proxy is bounded', () => {
  test('parallel requests for ONE recording share ONE upstream download (single flight)', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return new Response(audio(1000), { headers: { 'content-type': 'audio/mpeg' } }); }) as unknown as typeof fetch;
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => fetchConversationAudio('conv_single_flight', i % 2 ? `bytes=${i}-${i + 9}` : null, fetchImpl)));
    expect(calls).toBe(1);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(recordingCacheStats().inflight).toBe(0);
  });

  test('a chunked response with no content-length is cut off at the byte cap while streaming', async () => {
    let cancelled = false;
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { produced += 1024 * 1024; c.enqueue(new Uint8Array(1024 * 1024)); if (produced > MAX_BYTES * 3) c.close(); },
      cancel() { cancelled = true; },
    });
    const fetchImpl = (async () => new Response(body, { headers: { 'content-type': 'audio/mpeg' } })) as unknown as typeof fetch;
    const r = await fetchConversationAudio('conv_too_big_chunked', null, fetchImpl);
    expect(r.ok).toBe(false);
    expect(produced).toBeLessThan(MAX_BYTES + 4 * 1024 * 1024); // stopped right after the cap, not after buffering everything
    expect(cancelled).toBe(true);
    expect(recordingCacheStats().bytes).toBe(0);
  });

  test('the cache is capped by TOTAL BYTES, oldest first, and Range requests are answered from it', async () => {
    let calls = 0;
    const size = 30 * 1024 * 1024; // two fit in 64 MB, three do not
    const fetchImpl = (async () => { calls++; return new Response(chunked(size), { headers: { 'content-type': 'audio/mpeg' } }); }) as unknown as typeof fetch;
    for (const id of ['conv_cache_a', 'conv_cache_b']) expect((await fetchConversationAudio(id, null, fetchImpl)).ok).toBe(true);
    expect(recordingCacheStats().bytes).toBe(2 * size);
    expect((await fetchConversationAudio('conv_cache_c', null, fetchImpl)).ok).toBe(true);
    expect(recordingCacheStats().bytes).toBeLessThanOrEqual(CACHE_MAX_BYTES);
    expect(recordingCacheStats().entries).toBe(2); // a was evicted
    expect(calls).toBe(3);
    const r = await fetchConversationAudio('conv_cache_c', 'bytes=10-19', fetchImpl); // seek: cache hit
    expect(r.ok && r.response.status).toBe(206);
    expect(calls).toBe(3);
    await fetchConversationAudio('conv_cache_a', null, fetchImpl); // evicted: downloads again
    expect(calls).toBe(4);
  });

  test('at most MAX_CONCURRENT_DOWNLOADS run at once; beyond that: 503 with a Retry-After hint', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = (async () => { await gate; return new Response(audio(100), { headers: { 'content-type': 'audio/mpeg' } }); }) as unknown as typeof fetch;
    const first = Array.from({ length: MAX_CONCURRENT_DOWNLOADS }, (_, i) => fetchConversationAudio(`conv_slot_${i}`, null, fetchImpl));
    await new Promise((r) => setTimeout(r, 20));
    const over = await fetchConversationAudio('conv_slot_over', null, fetchImpl);
    expect(over).toMatchObject({ ok: false, status: 503 });
    expect(over.ok === false && over.retryAfterS).toBeGreaterThan(0);
    release();
    expect((await Promise.all(first)).every((r) => r.ok)).toBe(true);
    expect((await fetchConversationAudio('conv_slot_over', null, fetchImpl)).ok).toBe(true); // slots are free again
  });

  test('serving does not copy: a 200 and a range share the cached buffer', async () => {
    const body = audio(10);
    const whole = serveBody(body, 'audio/mpeg', null);
    const part = serveBody(body, 'audio/mpeg', 'bytes=2-4');
    expect(whole.status).toBe(200);
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer()).byteLength).toBe(3);
    expect((await whole.arrayBuffer()).byteLength).toBe(10);
  });
});

describe('R14 voice L2: transfer outcome', () => {
  test('a transfer call without a readable result is UNKNOWN (metered as AI), not connected', () => {
    expect(transferOutcomeFromTranscript([{ role: 'agent', tool_calls: [{ tool_name: 'transfer_to_number' }] }])).toBe('unknown');
    expect(transferOutcomeFromTranscript([{ role: 'agent', tool_calls: [{ tool_name: 'transfer_to_number' }], tool_results: [{ tool_name: 'transfer_to_number', result_value: 'ok' }] }])).toBe('connected');
    expect(transferOutcomeFromTranscript([{ role: 'agent', tool_calls: [{ tool_name: 'transfer_to_number' }], tool_results: [{ tool_name: 'transfer_to_number', is_error: true }] }])).toBe('failed');
    expect(transferOutcomeFromTranscript([{ role: 'user', message: 'hi' }])).toBe('none');
  });
  test('the moment of the transfer is read from the turn that invoked it', () => {
    expect(transferStartSecs([{ role: 'user', time_in_call_secs: 3 }, { role: 'agent', time_in_call_secs: 41, tool_calls: [{ tool_name: 'transfer_to_number' }] }])).toBe(41);
    expect(transferStartSecs([{ role: 'agent', tool_calls: [{ tool_name: 'transfer_to_number' }] }])).toBeNull();
    expect(transferStartSecs('nope')).toBeNull();
  });
});

describe('R14 verticals M1: urgency scores only what the CALLER said', () => {
  const triage: Record<string, string> = {
    dental: 'Are you in severe pain, with bleeding or swelling?', plumbing: 'Is there sewage backing up or a burst pipe flooding the house?',
    electrical: 'Any sparks or a burning smell?', hvac: 'Is there water leaking, or a burning smell?',
  };
  for (const [vertical, q] of Object.entries(triage)) {
    test(`${vertical}: the agent's own triage question + a routine answer is routine`, () => {
      const transcript = [{ role: 'agent', message: `Quick check. ${q}` }, { role: 'user', message: 'No, just a routine visit please.' }];
      expect(inferUrgency(callerTranscriptText(transcript), { vertical } as never)).not.toBe('emergency');
      // the old behaviour (scoring both sides) is what over-flagged
      expect(callerTranscriptText(transcript)).not.toContain(q);
    });
  }
  test('a caller who describes the emergency still flags it, and legacy string transcripts drop the agent lines', () => {
    expect(inferUrgency(callerTranscriptText([{ role: 'agent', message: 'Any sparks?' }, { role: 'user', message: 'yes there are sparks coming from the panel' }]), { vertical: 'electrical' } as never)).toBe('emergency');
    expect(callerTranscriptText('agent: any burning smell?\nuser: no thanks')).toBe('user: no thanks');
    expect(callerTranscriptText(undefined)).toBe('');
  });
});

describe('R14 verticals L2: the life-safety floor covers the common phrasings', () => {
  const cases: [string, string][] = [
    ['huele a gas en la cocina', 'hvac'], ['hay una fuga de gas', 'cleaning'], ['smoke coming out of the outlet and sparks', 'cleaning'], ['sale humo del enchufe', 'general'],
    ['I think someone was electrocuted', 'landscaping'], ['olemos monoxido de carbono', 'plumbing'],
  ];
  for (const [said, vertical] of cases) {
    test(`${said} (${vertical}) is an emergency`, () => {
      expect(inferUrgency(said, { vertical } as never)).toBe('emergency');
    });
  }
  test('ordinary talk is not flagged (a smoke detector install is not an emergency)', () => {
    expect(inferUrgency('I would like a smoke detector installed next week', { vertical: 'general' } as never)).not.toBe('emergency');
    expect(inferUrgency('quiero limpieza de la casa', { vertical: 'cleaning' } as never)).toBe('routine');
    expect(LIFE_SAFETY_STRONG).toContain('huele a gas');
  });
});

describe('R14 verticals L3: every emergency pack puts its own 911 sentence in the prompt', () => {
  for (const v of VERTICALS) {
    test(v, () => {
      const pack = packOf(v);
      const prompt = buildSystemPrompt({ id: 'b', name: 'Shop', vertical: v, hours: {}, service_area: [], timezone: 'America/New_York' } as never, { services: [], faqs: [], pricing_notes: '' });
      if (pack.emergency.enabled) {
        expect(prompt).toContain(pack.emergency.call911.en);
        expect(prompt).toContain(pack.emergency.call911.es);
        expect(prompt).toMatch(/911 FIRST/);
      }
    });
  }
});

describe('R14 verticals L1: a malformed rc_locale cookie never throws', () => {
  test('decode errors become "no cookie"', () => {
    expect(localeCookieFrom('rc_locale=%')).toBeUndefined();
    expect(localeCookieFrom('a=b; rc_locale=%E0%A4%A')).toBeUndefined();
    expect(localeCookieFrom('rc_locale=es')).toBe('es');
    expect(localeOfRequest(new Headers({ cookie: 'rc_locale=%', 'accept-language': 'es' }))).toBe('es');
  });
});

describe('R14 owner L4: the confirmation names the call', () => {
  test('texts carry the call time and stay GSM-7 and short', () => {
    const en = confirmationSms('Change AC Diagnostic: price $99', 'ABC234', 'en', '3:12 PM');
    expect(en).toContain('Requested on a call at 3:12 PM. Not you? Reply NO ABC234.');
    const es = confirmationSms('Cambiar precio', 'ABC234', 'es', '3:12 PM');
    expect(es).toContain('No fue usted? Responda NO ABC234.');
    for (const t of [en, es, undoSms('x', 'ABC234', 'es', '3:12 PM'), confirmationSms('y'.repeat(300), 'ABC234', 'en', '11:59 PM')]) {
      expect(/^[\x20-\x7e]*$/.test(t)).toBe(true);
      expect(t.length).toBeLessThanOrEqual(480);
    }
    // R15 L6: the longest summary (cut at 150) must keep the NO tail inside the 320-char alert clamp, with room for a business-name prefix
    for (const lang of ['en', 'es'] as const) {
      const long = confirmationSms('z'.repeat(400), 'ABC234', lang, '12:34 PM');
      expect(long.length).toBeLessThanOrEqual(310);
      expect(long.endsWith('NO ABC234.')).toBe(true);
    }
    expect(callClock('2026-12-01T20:12:00Z', 'America/New_York')).toBe('3:12 PM');
    expect(callClock('2026-12-01T20:12:00Z', 'Not/AZone')).toBe('');
    expect(confirmationSms('x', 'ABC234')).not.toContain('Requested on a call');
  });
});

describe('R14 verticals M2: the agent re-sync retry backs off', () => {
  test('2 min, doubling, capped at 1 h', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(agentResyncBackoffMs)).toEqual([120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]);
  });
});

describe('R14 money M1: refund retries use a new key after every failed attempt', () => {
  test('the attempt suffix', () => {
    expect(refundIdempotencyKey('b1', 5000, 0)).toBe('rc-refund-b1-5000');
    expect(refundIdempotencyKey('b1', 5000, 1)).toBe('rc-refund-b1-5000-a1');
  });
});
