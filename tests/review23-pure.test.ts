/**
 * Review 23, the PURE parts (no database): the Messaging Service send and its pool membership, the sender warning, the migration layout (A3).
 * Every request goes to a fake `fetch`; nothing leaves the machine.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smsSenderProblem } from '../src/lib/messaging/sender';
import { ensureNumberInMessagingService, messagingServiceSid, releaseNumber, removeNumberFromMessagingService, sendSms, smsStatusCallbackUrl } from '../src/lib/providers/twilio';

const SERVICE = `MG${'b2'.repeat(16)}`;
const PN = `PN${'c3'.repeat(16)}`;
const ENV = { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_PHONE_NUMBER: '+15005550006', NODE_ENV: 'test', APP_URL: 'https://app.example.test' } as NodeJS.ProcessEnv;
const TENANT = '+17862081234';
const CUSTOMER = '+13052087777';

interface Call { method: string; url: string; body: URLSearchParams }
function fake(handler: (c: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const c: Call = { method: init?.method ?? 'GET', url: String(input), body: new URLSearchParams(init?.body ? String(init.body) : '') };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe('23 A2: sending through the Messaging Service', () => {
  test('messagingServiceSid accepts only an MG sid; the status callback needs a public base URL', () => {
    expect(messagingServiceSid({ ...ENV, TWILIO_MESSAGING_SERVICE_SID: SERVICE })).toBe(SERVICE);
    expect(messagingServiceSid({ ...ENV, TWILIO_MESSAGING_SERVICE_SID: 'MGshort' })).toBeNull();
    expect(messagingServiceSid(ENV)).toBeNull();
    expect(smsStatusCallbackUrl(ENV)).toBe('https://app.example.test/api/sms/status');
    expect(smsStatusCallbackUrl({ ...ENV, APP_URL: undefined })).toBeNull();
  });

  test('a customer text carries MessagingServiceSid and NO From; the sender the answer reports is returned; texts that are not customer-facing keep the shared sender', async () => {
    const f = fake(() => Response.json({ sid: 'SM1', from: '+17865559999' }, { status: 201 }));
    const env = { ...ENV, TWILIO_MESSAGING_SERVICE_SID: SERVICE };
    const r = await sendSms(CUSTOMER, 'hi', { from: TENANT, messagingService: true, env, fetchImpl: f.fetch });
    expect(r).toMatchObject({ status: 'sent', sender: 'service', from: '+17865559999', id: 'SM1' });
    expect(f.calls[0].body.get('MessagingServiceSid')).toBe(SERVICE);
    expect(f.calls[0].body.get('From')).toBeNull();
    expect(f.calls[0].body.get('StatusCallback')).toBe('https://app.example.test/api/sms/status');
    // an answer without `from` (the pool has not picked yet): sender known only as the service
    const g = fake(() => Response.json({ sid: 'SM2', from: null }, { status: 201 }));
    expect(await sendSms(CUSTOMER, 'hi', { messagingService: true, env, fetchImpl: g.fetch })).toMatchObject({ sender: 'service', from: null });
    // not a customer-facing text (the owner's verification code): the shared sender, never the service
    const h = fake(() => Response.json({ sid: 'SM3' }, { status: 201 }));
    expect(await sendSms(CUSTOMER, 'code', { env, fetchImpl: h.fetch })).toMatchObject({ sender: 'shared', from: '+15005550006' });
    expect(h.calls[0].body.get('MessagingServiceSid')).toBeNull();
  });

  test('without the variable the tenant number is used (and the shared sender when Twilio refuses it); PIN_SENDER sends both; an unusable service falls back', async () => {
    const f = fake(() => Response.json({ sid: 'SM1' }, { status: 201 }));
    expect(await sendSms(CUSTOMER, 'hi', { from: TENANT, messagingService: true, env: ENV, fetchImpl: f.fetch })).toMatchObject({ sender: 'tenant', from: TENANT });
    expect(f.calls[0].body.get('From')).toBe(TENANT);
    const refused = fake((c) => (c.body.get('From') === TENANT ? Response.json({ code: 21606 }, { status: 400 }) : Response.json({ sid: 'SM2' }, { status: 201 })));
    expect(await sendSms(CUSTOMER, 'hi', { from: TENANT, messagingService: true, env: ENV, fetchImpl: refused.fetch })).toMatchObject({ sender: 'shared', from: '+15005550006' });
    const pinned = fake(() => Response.json({ sid: 'SM3' }, { status: 201 }));
    const env = { ...ENV, TWILIO_MESSAGING_SERVICE_SID: SERVICE, TWILIO_MESSAGING_SERVICE_PIN_SENDER: 'on' };
    expect(await sendSms(CUSTOMER, 'hi', { from: TENANT, messagingService: true, env, fetchImpl: pinned.fetch })).toMatchObject({ sender: 'service', from: TENANT });
    expect([pinned.calls[0].body.get('From'), pinned.calls[0].body.get('MessagingServiceSid')]).toEqual([TENANT, SERVICE]);
    // a pinned number that is not in the pool: the same text through the service alone
    const notInPool = fake((c) => (c.body.get('From') ? Response.json({ code: 21606 }, { status: 400 }) : Response.json({ sid: 'SM4' }, { status: 201 })));
    expect(await sendSms(CUSTOMER, 'hi', { from: TENANT, messagingService: true, env, fetchImpl: notInPool.fetch })).toMatchObject({ status: 'sent', sender: 'service', from: null });
    // a real failure of the service is a failure (never silently sent from an unregistered number)
    const down = fake(() => Response.json({ message: 'boom' }, { status: 500 }));
    expect(await sendSms(CUSTOMER, 'hi', { from: TENANT, messagingService: true, env: { ...ENV, TWILIO_MESSAGING_SERVICE_SID: SERVICE }, fetchImpl: down.fetch })).toMatchObject({ status: 'failed' });
    expect(down.calls).toHaveLength(1);
  });

  test('mock mode records the sender a real send would have used', async () => {
    const env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    expect(await sendSms(CUSTOMER, 'hi', { from: TENANT, env })).toMatchObject({ status: 'mock', sender: 'tenant', from: TENANT });
  });

  test('smsSenderProblem: warns in production without a Messaging Service, for a malformed sid anywhere, never for mock mode', () => {
    const prod = { ...ENV, NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(smsSenderProblem(prod)).toContain('A2P');
    expect(smsSenderProblem({ ...prod, TWILIO_MESSAGING_SERVICE_SID: SERVICE } as NodeJS.ProcessEnv)).toBeNull();
    expect(smsSenderProblem({ ...ENV, TWILIO_MESSAGING_SERVICE_SID: 'oops' } as NodeJS.ProcessEnv)).toContain('IGNORED');
    expect(smsSenderProblem(ENV)).toBeNull(); // development: no noise
    expect(smsSenderProblem({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBeNull(); // Twilio not configured: reported elsewhere
  });
});

describe('23 A2: the tenant number joins and leaves the Messaging Service sender pool', () => {
  const env = { ...ENV, TWILIO_MESSAGING_SERVICE_SID: SERVICE };
  const account = (pool: { member: boolean; addStatus?: number; lookupStatus?: number }) => fake((c) => {
    if (c.url.includes('/IncomingPhoneNumbers.json')) return Response.json({ incoming_phone_numbers: [{ sid: PN, phone_number: TENANT }] });
    if (c.url.startsWith('https://messaging.twilio.com/v1/Services/') && c.method === 'GET') return pool.lookupStatus ? new Response('{}', { status: pool.lookupStatus }) : pool.member ? Response.json({ sid: PN }) : new Response('{}', { status: 404 });
    if (c.url.startsWith('https://messaging.twilio.com/v1/Services/') && c.method === 'POST') return new Response('{}', { status: pool.addStatus ?? 201 });
    if (c.url.startsWith('https://messaging.twilio.com/v1/Services/') && c.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({});
  });

  test('add: reads the pool first (a member is a no-op), posts PhoneNumberSid otherwise, a 409 is success, a failure is reported and never thrown, a dry run changes nothing', async () => {
    const member = account({ member: true });
    expect(await ensureNumberInMessagingService(TENANT, { env, fetchImpl: member.fetch })).toEqual({ outcome: 'ok' });
    expect(member.calls.some((c) => c.method === 'POST' && c.url.includes('messaging.twilio.com'))).toBe(false);
    const fresh = account({ member: false });
    expect(await ensureNumberInMessagingService(TENANT, { env, fetchImpl: fresh.fetch })).toEqual({ outcome: 'added' });
    const post = fresh.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`https://messaging.twilio.com/v1/Services/${SERVICE}/PhoneNumbers`);
    expect(post.body.get('PhoneNumberSid')).toBe(PN);
    expect((await ensureNumberInMessagingService(TENANT, { env, fetchImpl: account({ member: false, addStatus: 409 }).fetch })).outcome).toBe('ok');
    expect((await ensureNumberInMessagingService(TENANT, { env, fetchImpl: account({ member: false, addStatus: 500 }).fetch })).outcome).toBe('failed');
    expect((await ensureNumberInMessagingService(TENANT, { env, fetchImpl: account({ member: false, lookupStatus: 500 }).fetch })).outcome).toBe('failed');
    const dry = account({ member: false });
    expect(await ensureNumberInMessagingService(TENANT, { env, fetchImpl: dry.fetch, dryRun: true })).toEqual({ outcome: 'would_add' });
    expect(dry.calls.some((c) => c.method === 'POST')).toBe(false);
    const throwing = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect((await ensureNumberInMessagingService(TENANT, { env, fetchImpl: throwing })).outcome).toBe('failed');
    // a known PN sid skips the account lookup
    const known = account({ member: true });
    await ensureNumberInMessagingService(TENANT, { env, fetchImpl: known.fetch, phoneSid: PN });
    expect(known.calls.some((c) => c.url.includes('/IncomingPhoneNumbers.json'))).toBe(false);
  });

  test('skipped: no service sid, Twilio incomplete, a mock-pool number, the platform sender; not_found when the account does not list it', async () => {
    const f = account({ member: false });
    expect((await ensureNumberInMessagingService(TENANT, { env: ENV, fetchImpl: f.fetch })).outcome).toBe('skipped');
    expect((await ensureNumberInMessagingService(TENANT, { env: { ...env, TWILIO_AUTH_TOKEN: undefined }, fetchImpl: f.fetch })).outcome).toBe('skipped');
    expect((await ensureNumberInMessagingService('+13055550142', { env, fetchImpl: f.fetch })).outcome).toBe('skipped');
    expect((await ensureNumberInMessagingService('+15005550006', { env, fetchImpl: f.fetch })).outcome).toBe('skipped');
    expect(f.calls).toHaveLength(0);
    const none = fake(() => Response.json({ incoming_phone_numbers: [] }));
    expect((await ensureNumberInMessagingService(TENANT, { env, fetchImpl: none.fetch })).outcome).toBe('not_found');
  });

  test('release: the number leaves the pool BEFORE it is deleted; a failed removal does not block the release; removal is idempotent', async () => {
    const f = fake((c) => {
      if (c.url.includes('/IncomingPhoneNumbers.json') && c.method === 'GET') return Response.json({ incoming_phone_numbers: [{ sid: PN, phone_number: TENANT }] });
      if (c.url.includes('messaging.twilio.com')) return new Response('{}', { status: 500 });
      return new Response(null, { status: 204 });
    });
    const r = await releaseNumber(TENANT, { env, fetchImpl: f.fetch, heldByOther: async () => false });
    expect(r).toMatchObject({ ok: true, sid: PN });
    const order = f.calls.map((c) => `${c.method} ${c.url.includes('messaging.twilio.com') ? 'pool' : c.url.includes('IncomingPhoneNumbers') ? 'number' : '?'}`);
    expect(order.indexOf('DELETE pool')).toBeGreaterThan(-1);
    expect(order.indexOf('DELETE pool')).toBeLessThan(order.lastIndexOf('DELETE number'));
    expect((await removeNumberFromMessagingService(TENANT, { env, fetchImpl: account({ member: false }).fetch })).outcome).toBe('removed');
    const gone = fake((c) => (c.method === 'DELETE' ? new Response('{}', { status: 404 }) : Response.json({ incoming_phone_numbers: [{ sid: PN, phone_number: TENANT }] })));
    expect((await removeNumberFromMessagingService(TENANT, { env, fetchImpl: gone.fetch })).outcome).toBe('ok');
  });
});

describe('23 A3: the migrations keep every lock short', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations');
  const sql = (d: string) => readFileSync(path.join(root, d, 'migration.sql'), 'utf8').replace(/^--.*$/gm, '').trim();
  const code = (d: string) => sql(d).split(';').map((x) => x.trim()).filter(Boolean);
  test('the ACCESS EXCLUSIVE GiST rebuild is alone in its file; the sms_log index is one CONCURRENT statement alone in its file; the column migration scans nothing', () => {
    const dirs = readdirSync(root).filter((d) => /^\d{14}_/.test(d)).sort();
    const at = (d: string) => dirs.indexOf(d);
    expect(at('20261209120000_review19_fixes')).toBeGreaterThan(-1);
    expect(at('20261209120100_bookings_overlap_per_crew')).toBeGreaterThan(at('20261209120000_review19_fixes'));
    expect(at('20261210120000_review23_fixes')).toBeGreaterThan(at('20261209120100_bookings_overlap_per_crew'));
    expect(at('20261210120100_sms_log_from_index')).toBeGreaterThan(at('20261210120000_review23_fixes'));
    const validate = sql('20261209120000_review19_fixes');
    expect(validate).not.toMatch(/CREATE INDEX|EXCLUDE USING gist/);
    const gist = sql('20261209120100_bookings_overlap_per_crew');
    expect(gist).toContain('EXCLUDE USING gist');
    expect(gist).not.toMatch(/CREATE INDEX|VALIDATE CONSTRAINT|ALTER TABLE "public"."(?!bookings)/);
    const cols = sql('20261210120000_review23_fixes');
    expect(cols).not.toMatch(/CREATE INDEX|VALIDATE CONSTRAINT|EXCLUDE USING|UPDATE /);
    expect(cols).toContain('"from_e164"');
    // a single statement (apart from nothing) outside any transaction block: CREATE INDEX CONCURRENTLY refuses to run inside one
    const idx = code('20261210120100_sms_log_from_index');
    expect(idx).toHaveLength(1);
    expect(idx[0]).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS "sms_log_from_e164_to_e164_created_at_idx" ON "public"."sms_log"\("from_e164", "to_e164", "created_at"\)$/);
  });
});
