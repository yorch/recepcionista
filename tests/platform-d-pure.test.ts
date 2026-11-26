process.env.TZ = 'UTC';
/**
 * Agent D (platform / scheduling / audio / ops), pure parts: configurable slot maths (grid, notice, horizon, buffer, crews), the time zone
 * list (DST aware), briefing audio voice choice and range parsing, the automatic-text label, the LLM / tenant-release switches, the content
 * gate in the readiness check, and the production refusals of deploy.sh and the seed script. No database, no network.
 */
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { buildSlots, hasConflict, upcomingDateKeys, validateSlot } from '../src/lib/availability';
import { AUTO_MARK, markAuto, splitAuto } from '../src/lib/auto-label';
import { tenantReleaseSetting } from '../src/lib/jobs/tenants';
import { llmRequiredProblem } from '../src/lib/providers/llm-required';
import { kbReadiness } from '../src/lib/kb/readiness';
import { briefingVoiceId, synthesizeBriefing } from '../src/lib/briefing/tts';
import { DEFAULT_VOICE_ID } from '../src/lib/voice/elevenlabs';
import { TIME_ZONE_IDS, tzOptionLabel, tzSelectOptions, TIME_ZONE_OPTIONS } from '../src/lib/tz-options';
import { isIanaTimeZone, inferTimeZoneFromPhone } from '../src/lib/tz-infer';
import { zonedTimeToUtc } from '../src/lib/time';
import { parseRange } from '../src/app/api/briefings/[id]/audio/route';
import { templateResult } from '../src/lib/extraction';
import type { Hours } from '../src/lib/types';

const NY = 'America/New_York';
const HOURS: Hours = { monday: { open: '08:00', close: '18:00' }, tuesday: { open: '08:00', close: '18:00' } };
const at = (date: string, hhmm: string, tz = NY) => zonedTimeToUtc(date, hhmm, tz).getTime();
const MIN = 60_000;
const NOW = at('2026-11-23', '07:00'); // a Monday, 07:00 ET

describe('buildSlots with the scheduling configuration', () => {
  test('slot grid: 30 and 15 minute steps inside the hours (a job still has to END by closing)', () => {
    expect(buildSlots(HOURS, '2026-11-23', NY, 60, []).length).toBe(10);
    expect(buildSlots(HOURS, '2026-11-23', NY, 60, [], { stepMin: 30 }).length).toBe(19);
    expect(buildSlots(HOURS, '2026-11-23', NY, 30, [], { stepMin: 15 }).length).toBe(39);
  });
  test('minimum notice hides the slots that start too soon (07:00 now + 2h notice -> first slot 09:00)', () => {
    const slots = buildSlots(HOURS, '2026-11-23', NY, 60, [], { nowMs: NOW, leadMin: 120 });
    expect(slots.filter((s) => s.available)[0].start).toBe(new Date(at('2026-11-23', '09:00')).toISOString());
  });
  test('buffer keeps free time on both sides of a busy interval (and applies to blocks that stop every crew)', () => {
    const busy = [{ start: at('2026-11-23', '10:00'), end: at('2026-11-23', '11:00') }];
    const free = (buffer: number) => buildSlots(HOURS, '2026-11-23', NY, 60, busy, { bufferMin: buffer }).filter((s) => s.available).map((s) => new Date(s.start).getTime());
    expect(free(0)).toContain(at('2026-11-23', '09:00'));
    expect(free(0)).toContain(at('2026-11-23', '11:00'));
    expect(free(15)).not.toContain(at('2026-11-23', '09:00')); // would end exactly when the busy block starts: inside the 15 minute buffer
    expect(free(15)).not.toContain(at('2026-11-23', '11:00'));
    expect(free(15)).toContain(at('2026-11-23', '08:00'));
    expect(free(15)).toContain(at('2026-11-23', '12:00'));
    expect(hasConflict({ start: 0, end: 60 * MIN }, [{ start: 70 * MIN, end: 90 * MIN }], 15)).toBe(true);
    expect(hasConflict({ start: 0, end: 60 * MIN }, [{ start: 70 * MIN, end: 90 * MIN }], 5)).toBe(false);
  });
  test('crews: a slot stays available while at least one crew is free; the buffer is per crew', () => {
    const a = { crew: 1, start: at('2026-11-23', '10:00'), end: at('2026-11-23', '11:00') };
    const b = { crew: 2, start: at('2026-11-23', '10:00'), end: at('2026-11-23', '11:00') };
    const avail = (crews: number, crewBusy: typeof a[], buffer = 0) => buildSlots(HOURS, '2026-11-23', NY, 60, [], { crews, crewBusy, bufferMin: buffer }).find((s) => s.start === new Date(at('2026-11-23', '10:00')).toISOString())!.available;
    expect(avail(1, [a])).toBe(false);
    expect(avail(2, [a])).toBe(true);
    expect(avail(2, [a, b])).toBe(false);
    expect(avail(3, [a, b])).toBe(true);
    // crew 1 busy 10-11, crew 2 busy 11-12, 30 minute buffer: 11:00 is inside both crews' buffers, 11:30 clears crew 1's (it ends 11:00)
    const c = { crew: 2, start: at('2026-11-23', '11:00'), end: at('2026-11-23', '12:00') };
    const slot = (start: string) => buildSlots(HOURS, '2026-11-23', NY, 60, [], { crews: 2, crewBusy: [a, c], bufferMin: 30, stepMin: 30 }).find((s) => s.start === new Date(at('2026-11-23', start)).toISOString())!.available;
    expect(slot('11:00')).toBe(false);
    expect(slot('11:30')).toBe(true);
  });
  test('an owner-wide block (Google Calendar) stops every crew', () => {
    const block = [{ start: at('2026-11-23', '10:00'), end: at('2026-11-23', '11:00') }];
    const s = buildSlots(HOURS, '2026-11-23', NY, 60, block, { crews: 3, crewBusy: [] }).find((x) => x.start === new Date(at('2026-11-23', '10:00')).toISOString())!;
    expect(s.available).toBe(false);
  });
});

describe('validateSlot: notice, horizon', () => {
  test('past vs too_soon vs too_far (horizon counts today as day 1)', () => {
    expect(validateSlot(HOURS, NOW - 1, 60, NY, NOW)).toEqual({ ok: false, reason: 'past' });
    expect(validateSlot(HOURS, at('2026-11-23', '08:00'), 60, NY, NOW, 120)).toEqual({ ok: false, reason: 'too_soon' });
    expect(validateSlot(HOURS, at('2026-11-23', '09:00'), 60, NY, NOW, 120)).toEqual({ ok: true });
    const hours7: Hours = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((d) => [d, { open: '08:00', close: '18:00' }])) as Hours;
    // horizon 3 days: Nov 23 (today), 24, 25 are inside; 26 is not
    expect(validateSlot(hours7, at('2026-11-25', '10:00'), 60, NY, NOW, 0, null, { horizonDays: 3 })).toEqual({ ok: true });
    expect(validateSlot(hours7, at('2026-11-26', '10:00'), 60, NY, NOW, 0, null, { horizonDays: 3 })).toEqual({ ok: false, reason: 'too_far' });
    expect(validateSlot(hours7, at('2026-11-26', '10:00'), 60, NY, NOW, 0, null, { horizonDays: null })).toEqual({ ok: true });
    expect(upcomingDateKeys(NOW, NY, 3)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25']);
  });
  test('horizon follows the BUSINESS zone, not the server zone (Los Angeles is still Sunday while UTC is Monday)', () => {
    const LA = 'America/Los_Angeles';
    const sunEvening = at('2026-11-22', '19:00', LA); // Monday 03:00 UTC
    const hours7: Hours = Object.fromEntries(['sunday', 'monday', 'tuesday'].map((d) => [d, { open: '08:00', close: '18:00' }])) as Hours;
    // today in LA is Sunday 22nd; horizon 2 = 22nd and 23rd; the 24th is too far
    expect(validateSlot(hours7, at('2026-11-23', '10:00', LA), 60, LA, sunEvening, 0, null, { horizonDays: 2 })).toEqual({ ok: true });
    expect(validateSlot(hours7, at('2026-11-24', '10:00', LA), 60, LA, sunEvening, 0, null, { horizonDays: 2 })).toEqual({ ok: false, reason: 'too_far' });
  });
});

describe('time zone options', () => {
  test('every option is a strict IANA name and the list covers the US and Canada mainland zones', () => {
    for (const id of TIME_ZONE_IDS) expect(isIanaTimeZone(id)).toBe(true);
    for (const id of ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Halifax', 'America/St_Johns', 'America/Toronto', 'America/Vancouver']) expect(TIME_ZONE_IDS).toContain(id);
    expect(new Set(TIME_ZONE_IDS).size).toBe(TIME_ZONE_IDS.length);
    for (const o of TIME_ZONE_OPTIONS) expect(o.es.length).toBeGreaterThan(3);
  });
  test('labels carry the offset in force at that instant (daylight saving aware)', () => {
    const ny = TIME_ZONE_OPTIONS.find((o) => o.id === 'America/New_York')!;
    const phx = TIME_ZONE_OPTIONS.find((o) => o.id === 'America/Phoenix')!;
    expect(tzOptionLabel(ny, 'en', new Date('2026-01-15T12:00:00Z'))).toContain('UTC-05:00');
    expect(tzOptionLabel(ny, 'en', new Date('2026-07-15T12:00:00Z'))).toContain('UTC-04:00');
    expect(tzOptionLabel(phx, 'en', new Date('2026-07-15T12:00:00Z'))).toContain('UTC-07:00'); // Arizona never changes
    expect(tzOptionLabel(phx, 'es', new Date('2026-01-15T12:00:00Z'))).toContain('sin horario de verano');
  });
  test('a stored zone outside the list stays selectable (never silently dropped)', () => {
    const opts = tzSelectOptions('Europe/Madrid', 'en', new Date('2026-01-15T12:00:00Z'));
    expect(opts[0].id).toBe('Europe/Madrid');
    expect(tzSelectOptions('America/Chicago', 'en').some((o) => o.id === 'Europe/Madrid')).toBe(false);
  });
  test('area code suggestions are hints for the list; ambiguous codes give none', () => {
    expect(inferTimeZoneFromPhone('+13125550100')).toBe('America/Chicago');
    expect(inferTimeZoneFromPhone('+13055550100')).toBe('America/New_York');
    expect(inferTimeZoneFromPhone('+16025550100')).toBe('America/Phoenix');
    expect(inferTimeZoneFromPhone('+18505550100')).toBeNull();
    for (const code of ['312', '305', '602', '213', '907', '808']) {
      const z = inferTimeZoneFromPhone(`+1${code}5550100`)!;
      expect(TIME_ZONE_IDS).toContain(z);
    }
  });
});

describe('briefing audio', () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  afterEach(() => { process.env = { ...saved }; globalThis.fetch = realFetch; });

  test('voice choice: the business voice, then ELEVENLABS_VOICE_ID, then the platform default; junk ids are skipped', () => {
    expect(briefingVoiceId({ voice_id: 'bizVoice12345' }, { ELEVENLABS_VOICE_ID: 'envVoice12345' } as never)).toBe('bizVoice12345');
    expect(briefingVoiceId({ voice_id: null }, { ELEVENLABS_VOICE_ID: 'envVoice12345' } as never)).toBe('envVoice12345');
    expect(briefingVoiceId({ voice_id: null }, {} as never)).toBe(DEFAULT_VOICE_ID);
    expect(briefingVoiceId({ voice_id: '../etc/passwd' }, { ELEVENLABS_VOICE_ID: '  ' } as never)).toBe(DEFAULT_VOICE_ID);
  });
  test('no ELEVENLABS_API_KEY: fails closed with no network call, no local voice, no files', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('x'); }) as typeof fetch;
    expect(await synthesizeBriefing('Hola, este es el resumen.')).toEqual({ ok: false, reason: 'not_configured' });
    expect(calls).toBe(0);
  });
  test('calls the provider with the business voice and returns the bytes; provider errors and tiny / huge replies fail closed', async () => {
    process.env.ELEVENLABS_API_KEY = 'xi-test';
    let url = '';
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (u: unknown, init?: RequestInit) => { url = String(u); body = JSON.parse(String(init?.body)); return new Response(new Uint8Array(4096).fill(7), { headers: { 'content-type': 'audio/mpeg' } }); }) as typeof fetch;
    const ok = await synthesizeBriefing('Hola, este es el resumen.', { voiceId: 'bizVoice12345' });
    expect(ok.ok).toBe(true);
    expect(url).toContain('/v1/text-to-speech/bizVoice12345');
    expect(body.model_id).toBe('eleven_multilingual_v2');
    expect(ok.ok && ok.bytes.byteLength).toBe(4096);
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    expect(await synthesizeBriefing('x y z')).toEqual({ ok: false, reason: 'provider_failed' });
    globalThis.fetch = (async () => new Response(new Uint8Array(10))) as typeof fetch;
    expect(await synthesizeBriefing('x y z')).toEqual({ ok: false, reason: 'bad_audio' });
    globalThis.fetch = (async () => { throw new Error('socket'); }) as typeof fetch;
    expect(await synthesizeBriefing('x y z')).toEqual({ ok: false, reason: 'provider_failed' });
    expect(await synthesizeBriefing('a'.repeat(3000))).toEqual({ ok: false, reason: 'text_too_long' });
  });
  test('Range parsing: bytes, open end, suffix, invalid and ignored forms', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=0-999', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=50-10', 100)).toBe('invalid');
    expect(parseRange('bytes=-0', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull(); // multi-range: a full answer is valid
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});

describe('automatic text labels', () => {
  test('mark / split round trip; marking twice is idempotent; plain text is not automatic', () => {
    expect(markAuto('Routine. Leaky tap.')).toBe(`${AUTO_MARK}Routine. Leaky tap.`);
    expect(markAuto(markAuto('x'))).toBe(`${AUTO_MARK}x`);
    expect(splitAuto(markAuto('x'))).toEqual({ auto: true, text: 'x' });
    expect(splitAuto('Caller wants a quote.')).toEqual({ auto: false, text: 'Caller wants a quote.' });
    expect(splitAuto(null)).toEqual({ auto: false, text: '' });
  });
});

describe('production switches', () => {
  test('an LLM key is required in production (not in tests or during the build)', () => {
    expect(llmRequiredProblem({ NODE_ENV: 'production' } as never)).toMatch(/OPENAI_API_KEY or ANTHROPIC_API_KEY/);
    expect(llmRequiredProblem({ NODE_ENV: 'production', OPENAI_API_KEY: ' ' } as never)).not.toBeNull();
    expect(llmRequiredProblem({ NODE_ENV: 'production', OPENAI_API_KEY: 'sk-x' } as never)).toBeNull();
    expect(llmRequiredProblem({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'sk-ant' } as never)).toBeNull();
    expect(llmRequiredProblem({ NODE_ENV: 'development' } as never)).toBeNull();
    expect(llmRequiredProblem({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' } as never)).toBeNull();
  });
  test('TENANT_RELEASE_JOB: only the exact values act; anything else is off', () => {
    expect(tenantReleaseSetting({} as never)).toBe('off');
    expect(tenantReleaseSetting({ TENANT_RELEASE_JOB: 'on' } as never)).toBe('on');
    expect(tenantReleaseSetting({ TENANT_RELEASE_JOB: 'ON' } as never)).toBe('on');
    expect(tenantReleaseSetting({ TENANT_RELEASE_JOB: 'report' } as never)).toBe('report');
    for (const v of ['true', '1', 'yes', 'enabled', '']) expect(tenantReleaseSetting({ TENANT_RELEASE_JOB: v } as never)).toBe('off');
  });
  test('deploy.sh refuses --seed outright, and the seed script refuses NODE_ENV=production', () => {
    const d = spawnSync('bash', ['deploy.sh', '--seed', '--i-know-this-wipes-data'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(d.status).toBe(2);
    expect(d.stderr).toMatch(/--seed is refused/);
    const s = spawnSync('bun', ['scripts/seed.ts'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/seed_scratch' } });
    expect(s.status).toBe(2);
    expect(s.stderr).toMatch(/refused/);
  });
});

describe('go-live content gate and the template', () => {
  const svc = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `S${i}`, base_price: 100 + i }));
  const faqs = [{ question: 'q', answer: 'a' }];
  const hours = { monday: { open: '08:00', close: '17:00' } };
  test('the service area is required (never defaulted) and the unconfirmed / stale content is a blocker', () => {
    const base = { services: svc(3), faqs };
    expect(kbReadiness(base, { hours, service_area: [] }).blockers.map((b) => b.key)).toEqual(['service_area']);
    expect(kbReadiness(base, { hours, service_area: ['Dade'] }).ready).toBe(true);
    expect(kbReadiness(base, { hours, service_area: ['Dade'], content_state: 'unconfirmed' }).blockers.map((b) => b.key)).toEqual(['content']);
    expect(kbReadiness(base, { hours, service_area: ['Dade'], content_state: 'stale' }, 'es').blockers[0].message).toMatch(/cambiaron/);
    expect(kbReadiness(base, { hours, service_area: ['Dade'], content_state: 'confirmed' }).ready).toBe(true);
    expect(kbReadiness(base, { hours, service_area: ['Dade'] }).ready).toBe(true); // unknown state = not checked (the browser draft)
  });
  test('the template carries NO literal county: the owner input or empty', () => {
    expect(templateResult('Acme').service_area).toEqual([]);
    expect(templateResult('Acme', 'plumbing', 'es').service_area).toEqual([]);
    expect(templateResult('Acme', 'hvac', 'en', ['  Broward  ', ''])).toMatchObject({ service_area: ['Broward'], source: 'template' });
    expect(JSON.stringify(templateResult('Acme'))).not.toContain('Miami');
  });
});
