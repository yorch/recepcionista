/**
 * Provisioning never hands out a fake number outside explicit mock mode, never goes 'live' on a failed step, and a retry
 * after a partial failure reuses the number it already bought (no double purchase). Fake fetch only: nothing leaves the machine.
 */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness } from '../helpers/fixtures';
import { attemptFriendlyName, fakeNumberAllowed, isMockPoolNumber, provisionNumber, type NumberAttemptStore } from '../../src/lib/providers/twilio';

const TWILIO_ENV = { TWILIO_ACCOUNT_SID: 'ACtest0000000000000000000000000000', TWILIO_PHONE_NUMBER: '+15005550006' };
const BOUGHT = '+13057770199';
const BOUGHT_2 = '+13057770198';

interface FakeTwilio {
  fetch: typeof fetch;
  calls: string[];
  buys: () => number;
  deletes: () => string[];
}

/** A scriptable Twilio: search result, purchase outcome, and what the account lists afterwards. */
function fakeTwilio(opts: {
  search?: 'ok' | 'empty' | 500 | 'throw';
  buy?: 'ok' | 400 | 500 | 'throw';
  /** Does the number exist on the account after an ambiguous purchase answer? (our purchase went through but the answer was lost) */
  existsAfter?: boolean;
  /** FriendlyName the listing shows: 'ours' (the tag this fake received on purchase, default), or another tenant's tag. */
  listedName?: 'ours' | string;
  /** The first N listing calls return nothing (Twilio's listing lags the purchase). */
  listLag?: number;
  /** The number on offer (phone numbers are unique per business, so each route test uses its own). */
  number?: string;
  /** Several numbers on offer (first = default). */
  offered?: string[];
  /** Runs when a purchase request arrives (e.g. to simulate another tenant winning the race). */
  onBuy?: (n: string) => Promise<void> | void;
  /** Shared account state across fakes/concurrent tenants: numbers already bought. */
  account?: Map<string, string>;
} = {}): FakeTwilio {
  const num = opts.number ?? BOUGHT;
  const account = opts.account ?? new Map<string, string>(); // number -> friendly name
  const calls: string[] = [];
  let lag = opts.listLag ?? 0;
  const f = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace(/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/[^/]+/, '')}`);
    if (url.includes('/AvailablePhoneNumbers/')) {
      const s = opts.search ?? 'ok';
      if (s === 'throw') throw new Error('network down');
      if (s === 500) return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
      const list = opts.offered ?? [num];
      return Response.json({ available_phone_numbers: s === 'empty' ? [] : list.map((phone_number) => ({ phone_number })) });
    }
    if (url.includes('/IncomingPhoneNumbers.json') && method === 'POST') {
      const body = new URLSearchParams(String(init?.body ?? ''));
      const want = body.get('PhoneNumber') ?? num;
      await opts.onBuy?.(want);
      const b = opts.buy ?? 'ok';
      if (b === 'throw') { if (opts.existsAfter) account.set(want, body.get('FriendlyName') ?? ''); throw new Error('timeout'); }
      if (b === 400) return new Response(JSON.stringify({ message: 'number unavailable' }), { status: 400 });
      if (b === 500) { if (opts.existsAfter) account.set(want, body.get('FriendlyName') ?? ''); return new Response(JSON.stringify({ message: 'oops' }), { status: 500 }); }
      if (account.has(want)) return new Response(JSON.stringify({ message: 'number already purchased' }), { status: 400 });
      account.set(want, body.get('FriendlyName') ?? '');
      return Response.json({ phone_number: want, sid: `PN_${want.slice(-4)}` }, { status: 201 });
    }
    if (url.includes('/IncomingPhoneNumbers.json') && method === 'GET') {
      if (lag > 0) { lag--; return Response.json({ incoming_phone_numbers: [] }); }
      const q = new URL(url).searchParams.get('PhoneNumber') ?? num;
      const listedOther = opts.listedName !== undefined && opts.listedName !== 'ours';
      if (!account.has(q) && !(opts.existsAfter && listedOther)) return Response.json({ incoming_phone_numbers: [] });
      return Response.json({ incoming_phone_numbers: [{ phone_number: q, sid: `PN_${q.slice(-4)}`, friendly_name: listedOther ? opts.listedName : account.get(q) }] });
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({});
  }) as unknown as typeof fetch;
  return {
    fetch: f, calls,
    buys: () => calls.filter((c) => c.startsWith('POST /IncomingPhoneNumbers')).length,
    deletes: () => calls.filter((c) => c.startsWith('DELETE ')),
  };
}

/** In-memory attempt store (the DB-backed one is exercised by the route tests below). */
function memStore(opts: { held?: string[]; reserved?: string[]; id?: string } = {}): NumberAttemptStore & { recorded: string[] } {
  const recorded: string[] = [];
  const reserved = new Set(opts.reserved ?? []);
  return {
    id: opts.id ?? 'attempt-1',
    recorded,
    isHeld: async (n) => (opts.held ?? []).includes(n),
    claim: async (n) => (reserved.has(n) ? false : (reserved.add(n), true)),
    record: async (n) => { recorded.push(n); },
    attempted: async (n) => recorded.includes(n),
    finish: async () => undefined,
  };
}
const noSleep = async () => undefined;

describe('provisionNumber (pure, injected fetch/env)', () => {
  const configured = { ...TWILIO_ENV, TWILIO_AUTH_TOKEN: 'tok', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv;

  test('explicit mock mode (no Twilio, not production) still issues a mock-pool number', async () => {
    const r = await provisionNumber('305', { env: { NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv });
    expect(r.ok && r.mock && isMockPoolNumber(r.phone)).toBe(true);
    expect(fakeNumberAllowed({ NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  test('production without Twilio is refused: no fake number', async () => {
    const r = await provisionNumber('305', { env: { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv });
    expect(r).toMatchObject({ ok: false, stage: 'not_configured' });
    expect(fakeNumberAllowed({ NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    // ...and a partially configured Twilio is not "explicit mock mode" in production either
    expect(fakeNumberAllowed({ NODE_ENV: 'production', TWILIO_ACCOUNT_SID: 'x' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  test('Twilio configured: every failure is a failure, never a fake number', async () => {
    for (const [opts, stage] of [
      [{ search: 'empty' }, 'search'], [{ search: 500 }, 'search'], [{ search: 'throw' }, 'search'],
      [{ buy: 400 }, 'purchase'], [{ buy: 500 }, 'purchase'], [{ buy: 'throw' }, 'purchase'],
    ] as const) {
      const t = fakeTwilio(opts);
      const r = await provisionNumber('305', { env: configured, fetchImpl: t.fetch });
      expect(r).toMatchObject({ ok: false, stage });
      expect(JSON.stringify(r)).not.toContain('555');
    }
  });

  test('a definite 4xx refusal is not reconciled; success returns the bought number', async () => {
    const refused = fakeTwilio({ buy: 400, existsAfter: true });
    expect((await provisionNumber('305', { env: configured, fetchImpl: refused.fetch })).ok).toBe(false);
    expect(refused.calls.some((c) => c.startsWith('GET /IncomingPhoneNumbers'))).toBe(false);
    const good = fakeTwilio();
    expect(await provisionNumber('305', { env: configured, fetchImpl: good.fetch })).toEqual({ ok: true, phone: BOUGHT, mock: false, bought: true });
  });

  test('an ambiguous purchase (timeout / 5xx) that went through is adopted ONLY with this attempt\'s proof, never bought twice', async () => {
    for (const buy of ['throw', 500] as const) {
      const t = fakeTwilio({ buy, existsAfter: true });
      const store = memStore();
      expect(await provisionNumber('305', { env: configured, fetchImpl: t.fetch, attempts: store, sleep: noSleep })).toEqual({ ok: true, phone: BOUGHT, mock: false, bought: true });
      expect(t.buys()).toBe(1);
      expect(store.recorded).toEqual([BOUGHT]); // recorded BEFORE the purchase
    }
  });

  test('F1: a listed number is NOT adopted when it is tagged by another attempt, held by a business, or there is no attempt store', async () => {
    // another tenant bought it (listing shows THEIR tag): hands off, nothing deleted
    const other = fakeTwilio({ buy: 500, existsAfter: true, listedName: attemptFriendlyName('somebody-else') });
    const r1 = await provisionNumber('305', { env: configured, fetchImpl: other.fetch, attempts: memStore(), sleep: noSleep });
    expect(r1.ok).toBe(false);
    expect(other.deletes()).toEqual([]);
    // the number became held by a business between purchase and reconcile
    let heldNow = false;
    const store = memStore();
    store.isHeld = async () => heldNow;
    const t2 = fakeTwilio({ buy: 500, existsAfter: true, onBuy: () => { heldNow = true; } });
    expect((await provisionNumber('305', { env: configured, fetchImpl: t2.fetch, attempts: store, sleep: noSleep })).ok).toBe(false);
    // no store at all: no proof, no adoption
    const t3 = fakeTwilio({ buy: 500, existsAfter: true });
    const r3 = await provisionNumber('305', { env: configured, fetchImpl: t3.fetch, sleep: noSleep });
    expect(r3).toMatchObject({ ok: false, stage: 'purchase', unsettled: BOUGHT });
    // the platform sender is never a candidate
    const t4 = fakeTwilio({ number: '+15005550006' });
    expect(await provisionNumber('305', { env: configured, fetchImpl: t4.fetch, attempts: memStore(), sleep: noSleep })).toMatchObject({ ok: false, stage: 'search' });
    expect(t4.buys()).toBe(0);
  });

  test('F1: candidates held by a business or reserved by another in-flight attempt are skipped; the next free one is bought', async () => {
    const t = fakeTwilio({ offered: ['+13057770001', '+13057770002', '+13057770003'] });
    const store = memStore({ held: ['+13057770001'], reserved: ['+13057770002'] });
    expect(await provisionNumber('305', { env: configured, fetchImpl: t.fetch, attempts: store })).toEqual({ ok: true, phone: '+13057770003', mock: false, bought: true });
    const none = fakeTwilio({ offered: ['+13057770001'] });
    const r = await provisionNumber('305', { env: configured, fetchImpl: none.fetch, attempts: memStore({ held: ['+13057770001'] }) });
    expect(r).toMatchObject({ ok: false, stage: 'search' });
    expect(none.buys()).toBe(0);
  });

  test('Twilio listing lag: the reconcile retries with backoff before giving up', async () => {
    const waits: number[] = [];
    const lagging = fakeTwilio({ buy: 'throw', existsAfter: true, listLag: 2 });
    const r = await provisionNumber('305', { env: configured, fetchImpl: lagging.fetch, attempts: memStore(), sleep: async (ms) => { waits.push(ms); } });
    expect(r).toMatchObject({ ok: true, phone: BOUGHT, bought: true });
    expect(waits.length).toBe(2);
    expect(waits[1]).toBeGreaterThan(waits[0]); // backoff grows
    expect(lagging.buys()).toBe(1);
    // never listed: gives up (bounded), reports the candidate as unsettled instead of adopting or re-buying
    const never = fakeTwilio({ buy: 'throw', existsAfter: false });
    const r2 = await provisionNumber('305', { env: configured, fetchImpl: never.fetch, attempts: memStore(), sleep: noSleep });
    expect(r2).toMatchObject({ ok: false, stage: 'purchase', unsettled: BOUGHT });
    expect(never.buys()).toBe(1);
  });
});

integration('provision route: failure is a failure (postgres)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: Awaited<ReturnType<typeof loadPrisma>>;
  let provision: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  let onboarding: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

  beforeAll(async () => {
    await loadDb();
    prisma = await loadPrisma();
    provision = (await import('@/app/api/businesses/[id]/provision/route')).POST as any;
    onboarding = (await import('@/app/api/businesses/[id]/onboarding-status/route')).GET as any;
  });
  afterAll(async () => {
    await cleanup();
  });
  const wipeAttempts = () => prisma.processedEvent.deleteMany({ where: { source: { in: ['number-candidate', 'number-attempt'] } } });
  beforeAll(async () => { await wipeAttempts(); });
  afterEach(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'businesses/provision' } } });
    await wipeAttempts(); // candidate reservations are 'done' for 30 days: tests reuse the same fake numbers
  });

  const headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://app.example.test', authorization: `Bearer ${SECRETS.adminToken}` };
  const post = (id: string, body: unknown = {}) => provision(
    new Request(`https://app.example.test/api/businesses/${id}/provision`, { method: 'POST', headers, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  const status = async (id: string) => ((await (await onboarding(
    new Request(`https://app.example.test/api/businesses/${id}/onboarding-status`, { headers }), { params: Promise.resolve({ id }) },
  )).json()) as any).data;
  /** A business with no number and no agent yet. */
  async function bare() {
    const b = await newBusiness({ agent_id: null });
    await prisma.business.update({ where: { id: b.id }, data: { phone: null, phoneKey: null, phoneE164: null, status: 'onboarding', billingStatus: 'active' } });
    return b;
  }
  const row = (id: string) => prisma.business.findUniqueOrThrow({ where: { id } });
  const events = (id: string) => prisma.auditEvent.findMany({ where: { businessId: id, action: { startsWith: 'provision.' } }, orderBy: { at: 'asc' } });
  const withFetch = async <T,>(f: typeof fetch, fn: () => Promise<T>) => {
    const prev = globalThis.fetch;
    globalThis.fetch = f;
    try { return await fn(); } finally { globalThis.fetch = prev; }
  };

  test('purchase failure with Twilio configured: 502, no fake number, status stays onboarding, audited; retry buys once and goes live', async () => {
    const biz = await bare();
    await withEnv({ ...TWILIO_ENV }, async () => {
      const failing = fakeTwilio({ buy: 400 });
      const res = await withFetch(failing.fetch, () => post(biz.id));
      expect(res.status).toBe(502);
      const body = (await res.json()) as any;
      expect(body).toMatchObject({ ok: false, code: 'number_purchase_failed', stage: 'number', retryable: true });
      expect(body.retry).toContain('Try again');
      expect(body.partial).toBeUndefined();
      const after = await row(biz.id);
      expect(after.phone).toBeNull();
      expect(after.status).toBe('onboarding');
      expect((await events(biz.id)).map((e) => e.action)).toEqual(['provision.number_failed']);
      const st = await status(biz.id);
      expect(st).toMatchObject({ provisioned: false, phone: null, provision_partial: null });
      expect(st.provision_last_error).toMatchObject({ stage: 'purchase' });

      // retry, Twilio healthy now: one purchase, live, real number
      const good = fakeTwilio({ number: BOUGHT });
      const ok = await withFetch(good.fetch, () => post(biz.id));
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).data).toMatchObject({ phone: BOUGHT, mock: false });
      expect(good.buys()).toBe(1);
      expect(await row(biz.id)).toMatchObject({ phone: BOUGHT, status: 'live' });

      // a third call is idempotent: no second purchase
      const again = fakeTwilio({ number: BOUGHT });
      expect((await withFetch(again.fetch, () => post(biz.id))).status).toBe(200);
      expect(again.buys()).toBe(0);
    });
  });

  test('partial failure: number bought, agent step fails -> 502 with the number kept, onboarding-status shows it, retry reuses it (no second purchase)', async () => {
    const biz = await bare();
    await withEnv({ ...TWILIO_ENV, ELEVENLABS_API_KEY: 'xi-test', ELEVENLABS_AGENT_ID: undefined }, async () => {
      const twilio = fakeTwilio({ number: BOUGHT_2 });
      let agentOk = false;
      const combined = (async (input: unknown, init?: { method?: string }) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes('api.twilio.com')) return twilio.fetch(input as any, init as any);
        if (url.endsWith('/convai/agents/create')) return agentOk ? Response.json({ agent_id: 'agent_partial' }) : new Response('unavailable', { status: 503 });
        if (url.endsWith('/workspace/webhooks') && (init?.method ?? 'GET') === 'GET') return Response.json({ webhooks: [] });
        return Response.json({});
      }) as unknown as typeof fetch;

      const res = await withFetch(combined, () => post(biz.id));
      expect(res.status).toBe(502);
      const body = (await res.json()) as any;
      expect(body).toMatchObject({ ok: false, code: 'agent_registration_failed', stage: 'agent', partial: { phone: BOUGHT_2, number_kept: true } });
      expect(body.retry).toContain('reuses it');
      const mid = await row(biz.id);
      expect(mid.phone).toBe(BOUGHT_2);
      expect(mid.status).toBe('onboarding'); // NOT live
      expect(twilio.buys()).toBe(1);
      expect((await events(biz.id)).map((e) => e.action)).toEqual(['provision.number_purchased', 'provision.partial']);
      const st = await status(biz.id);
      expect(st).toMatchObject({ provisioned: false, status: 'onboarding', phone: BOUGHT_2, current_step: 'provision' });
      expect(st.provision_partial).toMatchObject({ phone: BOUGHT_2, stage: 'agent' });

      // retry once the agent provider is back: reuses the number, goes live
      agentOk = true;
      const ok = await withFetch(combined, () => post(biz.id));
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).data).toMatchObject({ phone: BOUGHT_2, agent_id: 'agent_partial' });
      expect(twilio.buys()).toBe(1); // still ONE purchase
      expect(await row(biz.id)).toMatchObject({ phone: BOUGHT_2, status: 'live', agentId: 'agent_partial' });
      expect((await status(biz.id)).provision_partial).toBeNull();
      expect((await events(biz.id)).map((e) => e.action).at(-1)).toBe('provision.completed');
    });
  });

  test('F1: a number another business already holds is never bought, adopted, or released (stale search result)', async () => {
    const holder = await bare();
    const biz = await bare();
    const taken = '+13057770177';
    await prisma.business.update({ where: { id: holder.id }, data: { phone: taken, phoneKey: taken.slice(-10), phoneE164: taken, status: 'live' } });
    await withEnv({ ...TWILIO_ENV }, async () => {
      // the exact repro of docs/review/08 F1: search offers the holder's live number, the purchase answers 503, the account lists it
      const twilio = fakeTwilio({ number: taken, buy: 500, existsAfter: true, listedName: attemptFriendlyName('the-holders-attempt') });
      const res = await withFetch(twilio.fetch, () => post(biz.id));
      expect(res.status).toBe(502);
      expect(((await res.json()) as any).code).toBe('number_purchase_failed');
      expect(twilio.buys()).toBe(0); // skipped before any purchase
      expect(twilio.deletes()).toEqual([]); // and above all: NOTHING deleted at Twilio
    });
    expect(await row(holder.id)).toMatchObject({ phone: taken, status: 'live' });
    expect((await row(biz.id)).phone).toBeNull();
  });

  test('F1: another tenant wins the DB row between our purchase and our save: kept, 502 number_taken, never released', async () => {
    const holder = await bare();
    const biz = await bare();
    const raced = '+13057770178';
    await withEnv({ ...TWILIO_ENV }, async () => {
      const twilio = fakeTwilio({
        number: raced,
        onBuy: async () => { await prisma.business.update({ where: { id: holder.id }, data: { phone: raced, phoneKey: raced.slice(-10), phoneE164: raced } }); },
      });
      const res = await withFetch(twilio.fetch, () => post(biz.id));
      expect(res.status).toBe(502);
      expect(((await res.json()) as any).code).toBe('number_taken');
      expect(twilio.deletes()).toEqual([]);
    });
    expect((await row(holder.id)).phone).toBe(raced);
    expect((await events(biz.id)).map((e) => e.action)).toEqual(['provision.number_conflict']);
  });

  test('F1: two tenants provisioning at once in the same area code get DIFFERENT numbers, each bought once, nothing released', async () => {
    const a = await bare();
    const b = await bare();
    const N1 = '+13057770181';
    const N2 = '+13057770182';
    await withEnv({ ...TWILIO_ENV }, async () => {
      const account = new Map<string, string>();
      // both searches return the SAME first candidate (Twilio does that for simultaneous searches)
      const twilio = fakeTwilio({ offered: [N1, N2], account });
      const [ra, rb] = await withFetch(twilio.fetch, () => Promise.all([post(a.id), post(b.id)]));
      expect([ra.status, rb.status]).toEqual([200, 200]);
      const pa = (await row(a.id)).phone;
      const pb = (await row(b.id)).phone;
      expect(new Set([pa, pb])).toEqual(new Set([N1, N2]));
      expect(twilio.buys()).toBe(2);
      expect(twilio.deletes()).toEqual([]);
      expect([...account.keys()].sort()).toEqual([N1, N2]);
    });
  });

  test('F1: a purchase whose answer is lost is adopted with this attempt\'s tag (listing lag included), and retries do not buy again', async () => {
    const biz = await bare();
    const lost = '+13057770183';
    await withEnv({ ...TWILIO_ENV }, async () => {
      const twilio = fakeTwilio({ number: lost, buy: 500, existsAfter: true, listLag: 1 });
      const res = await withFetch(twilio.fetch, () => post(biz.id));
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).data).toMatchObject({ phone: lost, mock: false });
      expect(twilio.buys()).toBe(1);
    });
  });

  test('area code: the business owner phone\'s area code is used when valid, TWILIO_AREA_CODE otherwise', async () => {
    const withOwner = await bare();
    await prisma.business.update({ where: { id: withOwner.id }, data: { ownerPhone: '+17865550123', ownerPhoneE164: '+17865550123' } });
    const noOwner = await bare();
    await prisma.business.update({ where: { id: noOwner.id }, data: { ownerPhone: null, ownerPhoneE164: null, ownerPhoneVerifiedAt: null } });
    await withEnv({ ...TWILIO_ENV, TWILIO_AREA_CODE: '212' }, async () => {
      for (const [biz, expected, n] of [[withOwner, '786', '+17867770191'], [noOwner, '212', '+12127770192']] as const) {
        const twilio = fakeTwilio({ number: n });
        const res = await withFetch(twilio.fetch, () => post(biz.id));
        expect(res.status).toBe(200);
        expect(twilio.calls.find((c) => c.includes('AvailablePhoneNumbers'))).toContain(`AreaCode=${expected}`);
      }
    });
  });

  test('production without Twilio: 503, nothing stored, never live, no outbound call', async () => {
    const biz = await bare();
    await withEnv({ NODE_ENV: 'production', BILLING_ENFORCED: 'true' }, async () => {
      const calls = fakeTwilio();
      const res = await withFetch(calls.fetch, () => post(biz.id));
      expect(res.status).toBe(503);
      expect(((await res.json()) as any)).toMatchObject({ code: 'phone_provider_not_configured', retryable: true });
      expect(calls.calls).toEqual([]);
    });
    expect(await row(biz.id)).toMatchObject({ phone: null, status: 'onboarding' });
  });

  test('production with Twilio configured: a purchase failure is a 502, not a fake number', async () => {
    const biz = await bare();
    await withEnv({ ...TWILIO_ENV, NODE_ENV: 'production', BILLING_ENFORCED: 'true' }, async () => {
      const res = await withFetch(fakeTwilio({ search: 'empty' }).fetch, () => post(biz.id));
      expect(res.status).toBe(502);
    });
    expect(await row(biz.id)).toMatchObject({ phone: null, status: 'onboarding' });
  });

  test('explicit mock mode outside production still works (mock-pool number, live, flagged mock)', async () => {
    const biz = await bare();
    const res = await post(biz.id);
    expect(res.status).toBe(200);
    const data = ((await res.json()) as any).data;
    expect(data.mock).toBe(true);
    expect(isMockPoolNumber(data.phone)).toBe(true);
    expect(await row(biz.id)).toMatchObject({ status: 'live' });
    expect((await status(biz.id)).phone_mock).toBe(true);
  });
});
