/** Phase 2 telephony, pure parts: STIR trust classes and buckets, screening TwiML, live-stream frames/limits, transfer helpers, warnings maths. */
import { describe, expect, test } from 'bun:test';
import { callerKey, failedPerHour, trustClassOf, withheldPerHour } from '../src/lib/voice/caller-limits';
import { forwardTwiml, screenAcceptTwiml, screenDeclineTwiml, screenPromptTwiml, spokenNumber } from '../src/lib/voice/twiml';
import { bridgedSeconds } from '../src/lib/voice/screening';
import { forwardingSupported } from '../src/lib/voice/line';
import { nativeTransferEnabled, transferOutcomeFromTranscript, transferRefusalMessage } from '../src/lib/voice/transfer';
import { acquireLiveSlot, createLiveStream, liveLimits, type LiveStreamDeps } from '../src/lib/voice/live-stream';
import { parseConversation } from '../src/lib/voice/conversations';
import { snapshotToEvents } from '../src/lib/voice/live-transcript';
import { reconcileBackoffMinutes } from '../src/lib/voice/reconcile';
import { dueWarnings, usageLines, warningMessage } from '../src/lib/billing/warnings';
import { normalizeLanguage } from '../src/lib/voice/postcall';
import type { TranscriptEvent } from '../src/lib/types';

describe('STIR/SHAKEN trust', () => {
  test('only attestation A is verified; B, C, none, absent and failed are not', () => {
    expect(trustClassOf('TN-Validation-Passed-A')).toBe('verified');
    for (const s of ['TN-Validation-Passed-B', 'TN-Validation-Passed-C', 'No-TN-Validation', '', null, undefined, 'garbage']) expect(trustClassOf(s)).toBe('unverified');
    expect(trustClassOf('TN-Validation-Failed-A')).toBe('failed');
    expect(trustClassOf('TN-Validation-Failed-C')).toBe('failed');
  });
  test('STIR_TRUST=off restores caller-id identity', () => {
    expect(trustClassOf(null, { STIR_TRUST: 'off' })).toBe('verified');
  });
  test('per-caller identity only for verified callers; the rest share one bucket per business', () => {
    const n = '+13055550123';
    const a = callerKey(n, 'biz1', 'verified');
    expect(a.e164).toBe(n);
    expect(a.bucket).not.toBe('unverified');
    const u1 = callerKey(n, 'biz1', 'unverified'); const u2 = callerKey('+13055550999', 'biz1', 'unverified');
    expect(u1).toEqual({ e164: null, bucket: 'unverified' });
    expect(u2.bucket).toBe(u1.bucket);
    expect(callerKey(n, 'biz1', 'failed').bucket).toBe('failed');
    expect(callerKey('anonymous', 'biz1', 'verified').bucket).toBe('withheld');
  });
  test('a failed attestation gets a stricter budget than an unverified one', () => {
    expect(failedPerHour('forward', {})).toBeLessThan(withheldPerHour('forward', {}));
    expect(failedPerHour('voicemail', { VOICEMAIL_WITHHELD_PER_HOUR: '1' })).toBe(1);
  });
});

describe('call screening TwiML', () => {
  const biz = { name: 'Acme Air & Heat' };
  test('forward leg carries the whisper url on <Number>, still with the status callback', () => {
    const xml = forwardTwiml('+13055550142', { screenUrl: '/api/voice/screen', statusCallback: '/api/voice/dial-status', action: '/api/voice/voicemail' });
    expect(xml).toContain('<Number url="/api/voice/screen" method="POST" statusCallback="/api/voice/dial-status"');
    expect(forwardTwiml('+13055550142')).not.toContain('url=');
  });
  test('the whisper announces the business and the caller and asks to press 1 (escaped, digit by digit)', () => {
    const xml = screenPromptTwiml(biz, '+13055550123', '/api/voice/screen');
    expect(xml).toContain('<Gather input="dtmf" numDigits="1"');
    expect(xml).toContain('action="/api/voice/screen"');
    expect(xml).toContain('Acme Air &amp; Heat call from 1 3 0 5 5 5 5 0 1 2 3. Press 1 to accept.');
    expect(xml.trim().endsWith('<Hangup/></Response>')).toBe(true); // no input -> the leg is dropped
    expect(screenPromptTwiml(biz, 'anonymous', '/x')).toContain('an unknown number');
  });
  test('accept bridges (empty response); decline hangs up the owner leg only', () => {
    expect(screenAcceptTwiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(screenDeclineTwiml()).toContain('<Hangup/>');
    expect(spokenNumber('')).toBe('an unknown number');
  });
  test('only bridged seconds count', () => {
    const none = { screened: false, declined: false, accepted: false, whisperSeconds: 0 };
    expect(bridgedSeconds(120, none)).toBe(120);
    expect(bridgedSeconds(120, { screened: true, declined: true, accepted: false, whisperSeconds: 0 })).toBe(0);
    expect(bridgedSeconds(25, { screened: true, declined: false, accepted: false, whisperSeconds: 0 })).toBe(0); // carrier voicemail answered, nobody pressed 1
    expect(bridgedSeconds(100, { screened: true, declined: false, accepted: true, whisperSeconds: 8 })).toBe(92);
    expect(bridgedSeconds(null, { screened: true, declined: false, accepted: true, whisperSeconds: 3 })).toBeNull();
  });
});

describe('native transfer switches and outcome', () => {
  test('NATIVE_TRANSFER defaults off; forwarding is supported on the native line only when on', () => {
    expect(nativeTransferEnabled({})).toBe(false);
    expect(nativeTransferEnabled({ NATIVE_TRANSFER: 'ON' })).toBe(true);
    expect(nativeTransferEnabled({ NATIVE_TRANSFER: 'true' })).toBe(false);
    expect(forwardingSupported('native', {})).toBe(false);
    expect(forwardingSupported('native', { NATIVE_TRANSFER: 'on' })).toBe(true);
    expect(forwardingSupported('webhook', {})).toBe(true);
  });
  test('outcome from the post-call transcript', () => {
    const t = (calls: unknown[], results: unknown[]) => [{ role: 'agent', message: 'x', tool_calls: calls, tool_results: results }];
    expect(transferOutcomeFromTranscript(t([{ tool_name: 'transfer_to_number' }], [{ tool_name: 'transfer_to_number', is_error: false, result_value: 'ok' }]))).toBe('connected');
    expect(transferOutcomeFromTranscript(t([{ tool_name: 'transfer_to_number' }], [{ tool_name: 'transfer_to_number', is_error: true }]))).toBe('failed');
    expect(transferOutcomeFromTranscript(t([{ tool_name: 'get_pricing' }], []))).toBe('none');
    expect(transferOutcomeFromTranscript('text')).toBe('unknown');
  });
  test('refusal messages are honest, bilingual and move to a callback', () => {
    expect(transferRefusalMessage('outside_hours', false)).toMatch(/not available/);
    expect(transferRefusalMessage('cap_reached', true)).toMatch(/dueño/);
  });
});

describe('live stream', () => {
  const ev = (seq: number): TranscriptEvent => ({ call_id: 'c', seq, role: seq % 2 ? 'caller' : 'agent', text: `line ${seq}`, at: new Date().toISOString(), is_final: true });
  const read = async (stream: ReadableStream<Uint8Array>, stop: (text: string) => boolean, ms = 3000): Promise<string> => {
    const reader = stream.getReader(); let out = ''; const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((res) => setTimeout(() => res({ done: true, value: undefined }), 200))]);
      if (r.value) out += new TextDecoder().decode(r.value);
      if (stop(out) || (r.done && !r.value && out.includes('event: ended'))) break;
      if (r.done && r.value === undefined && stop(out)) break;
    }
    await reader.cancel().catch(() => undefined);
    return out;
  };
  const deps = (store: TranscriptEvent[], state: { live: boolean; consent: string } = { live: true, consent: 'disclosed' }, extra: Partial<LiveStreamDeps> = {}): LiveStreamDeps => ({
    poll: async () => 'polled', listAfter: async (_c, after) => store.filter((e) => e.seq > after), callState: async () => state, reauth: async () => true, ...extra,
  });

  test('streams events with ids, resumes after Last-Event-ID and never repeats a line', async () => {
    const store = [ev(0), ev(1), ev(2), ev(3)];
    const text = await read(createLiveStream({ callId: 'c', after: 1, deps: deps(store), tickMs: 10, heartbeatMs: 5 }), (t) => t.includes('id: 3') && t.includes(': hb'));
    expect(text.startsWith('retry: 3000')).toBe(true);
    expect(text).not.toContain('id: 0\n');
    expect(text).not.toContain('id: 1\n');
    expect(text).toContain('id: 2\nevent: transcript');
    expect(text).toContain('id: 3\nevent: transcript');
    expect((text.match(/id: 2\n/g) ?? []).length).toBe(1);
    expect(text).toContain(': hb');
    expect(text).toContain('event: status');
  });
  test('ends with an ended frame once the call is over and everything was delivered', async () => {
    const text = await read(createLiveStream({ callId: 'c', after: -1, deps: deps([ev(0)], { live: false, consent: 'disclosed' }), tickMs: 10 }), (t) => t.includes('event: ended'));
    expect(text).toContain('id: 0');
    expect(text).toContain('event: ended');
  });
  test('a declined call sends no transcript at all', async () => {
    const text = await read(createLiveStream({ callId: 'c', after: -1, deps: deps([ev(0)], { live: true, consent: 'declined' }, { listAfter: async () => { throw new Error('must not read'); } }), tickMs: 10 }), (t) => t.includes('event: ended'));
    expect(text).not.toContain('event: transcript');
    expect(text).toContain('"state":"declined"');
  });
  test('auth is re-checked and a lost session closes the stream', async () => {
    let n = 0;
    const text = await read(createLiveStream({ callId: 'c', after: -1, deps: deps([], undefined, { reauth: async () => ++n < 2 }), tickMs: 10, reauthMs: 20 }), (t) => t.includes('event: auth'));
    expect(text).toContain('event: auth');
  });
  test('closing the client runs onClose once and stops polling', async () => {
    let closed = 0; let polls = 0;
    const ac = new AbortController();
    const s = createLiveStream({ callId: 'c', after: -1, signal: ac.signal, deps: deps([], undefined, { poll: async () => { polls++; return 'polled'; } }), tickMs: 5, onClose: () => { closed++; } });
    const reader = s.getReader(); await reader.read(); await new Promise((r) => setTimeout(r, 40));
    ac.abort(); await new Promise((r) => setTimeout(r, 40));
    const after = polls; await new Promise((r) => setTimeout(r, 40));
    expect(closed).toBe(1);
    expect(polls).toBe(after);
  });
  test('a client that never reads is dropped (backpressure) instead of buffering forever', async () => {
    let closed = 0;
    createLiveStream({ callId: 'c', after: -1, deps: deps(Array.from({ length: 50 }, (_, i) => ev(i))), tickMs: 3, maxStalledTicks: 4, onClose: () => { closed++; } });
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(1);
  });
  test('connection limits per user and per business, released exactly once', () => {
    const env = { LIVE_MAX_PER_USER: '2', LIVE_MAX_PER_BUSINESS: '3' };
    expect(liveLimits(env)).toEqual({ perUser: 2, perBusiness: 3 });
    const a = acquireLiveSlot('u1', 'b1', env); const b = acquireLiveSlot('u1', 'b1', env);
    expect(a && b).toBeTruthy();
    expect(acquireLiveSlot('u1', 'b1', env)).toBeNull(); // user limit
    const c = acquireLiveSlot('u2', 'b1', env); expect(c).toBeTruthy();
    expect(acquireLiveSlot('u3', 'b1', env)).toBeNull(); // business limit
    a!(); a!(); // idempotent
    const d = acquireLiveSlot('u3', 'b1', env); expect(d).toBeTruthy();
    for (const f of [b, c, d]) f!();
  });
});

describe('conversation parsing and reconcile maths', () => {
  test('parseConversation keeps spoken turns only', () => {
    const s = parseConversation({ status: 'in-progress', metadata: { call_duration_secs: 42, start_time_unix_secs: 1_700_000_000, main_language: 'es' },
      transcript: [{ role: 'agent', message: 'Hola', time_in_call_secs: 0 }, { role: 'user', message: null, time_in_call_secs: 2 }, { role: 'user', message: 'Quiero una cita', time_in_call_secs: 4 }] });
    expect(s.status).toBe('in-progress'); expect(s.durationSecs).toBe(42); expect(s.language).toBe('es');
    expect(s.turns.map((t) => t.message)).toEqual(['Hola', 'Quiero una cita']);
    const ev = snapshotToEvents(s, new Date().toISOString());
    expect(ev.map((e) => [e.seq, e.role])).toEqual([[0, 'agent'], [1, 'caller']]);
    expect(parseConversation(null).status).toBe('unknown');
  });
  test('backoff grows and is capped', () => {
    expect([0, 1, 2, 3, 4].map(reconcileBackoffMinutes)).toEqual([0, 10, 20, 40, 80]);
    expect(reconcileBackoffMinutes(20)).toBe(360);
  });
  test('language comes from the metadata (es / en / mixed)', () => {
    expect(normalizeLanguage('es-MX', '')).toBe('es');
    expect(normalizeLanguage('en', '')).toBe('en');
    expect(normalizeLanguage(undefined, 'hola, my AC is broken, please')).toBe('mixed');
    expect(normalizeLanguage(undefined, 'hello')).toBeNull();
  });
});

describe('cap warnings maths', () => {
  const biz = { billing_status: 'active' as const, sms_cap_override: 100, call_minutes_cap_override: 10 };
  test('percent per kind, due levels, one level per kind', () => {
    const lines = usageLines(biz as never, { sms_count: 80, call_seconds: 600, forward_seconds: 0 }, { FORWARD_MINUTES_CAP: '10' } as unknown as NodeJS.ProcessEnv);
    expect(lines.map((l) => [l.kind, l.percent])).toEqual([['sms', 80], ['ai', 100], ['forward', 0]]);
    const due = dueWarnings(lines, null);
    expect(due.map((d) => `${d.kind}:${d.level}`)).toEqual(['sms:80', 'ai:100']);
    const sent = { sms_80: 'x', sms_100: null, ai_80: 'x', ai_100: null, forward_80: null, forward_100: null };
    expect(dueWarnings(lines, sent).map((d) => `${d.kind}:${d.level}`)).toEqual(['ai:100']);
  });
  test('messages name the amount and the consequence', () => {
    const m = warningMessage({ kind: 'ai', level: 100, used: 10, cap: 10, unit: 'minutes' }, 'Acme');
    expect(m.sms).toContain('Acme'); expect(m.sms).toContain('10 of 10 minutes');
    expect(warningMessage({ kind: 'sms', level: 80, used: 80, cap: 100, unit: 'texts' }, 'Acme').subject).toContain('80%');
  });
});
