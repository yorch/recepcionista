/**
 * Provisioning never hands out a fake number outside explicit mock mode, never goes 'live' on a failed step, and a retry
 * after a partial failure reuses the number it already bought (no double purchase). Fake fetch only: nothing leaves the machine.
 */
import { integration, SECRETS, withEnv } from '../helpers/env';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { cleanup, loadDb, loadPrisma, newBusiness } from '../helpers/fixtures';
import { fakeNumberAllowed, isMockPoolNumber, provisionNumber } from '../../src/lib/providers/twilio';

const TWILIO_ENV = { TWILIO_ACCOUNT_SID: 'ACtest0000000000000000000000000000', TWILIO_PHONE_NUMBER: '+15005550006' };
const BOUGHT = '+13057770199';
const BOUGHT_2 = '+13057770198';

interface FakeTwilio {
  fetch: typeof fetch;
  calls: string[];
  buys: () => number;
}

/** A scriptable Twilio: search result, purchase outcome, and what the account lists afterwards. */
function fakeTwilio(opts: {
  search?: 'ok' | 'empty' | 500 | 'throw';
  buy?: 'ok' | 400 | 500 | 'throw';
  /** Does the number exist on the account after an ambiguous purchase answer? */
  existsAfter?: boolean;
  /** The number on offer (phone numbers are unique per business, so each route test uses its own). */
  number?: string;
} = {}): FakeTwilio {
  const num = opts.number ?? BOUGHT;
  const calls: string[] = [];
  const f = (async (input: unknown, init?: { method?: string }) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace(/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/[^/]+/, '')}`);
    if (url.includes('/AvailablePhoneNumbers/')) {
      const s = opts.search ?? 'ok';
      if (s === 'throw') throw new Error('network down');
      if (s === 500) return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
      return Response.json({ available_phone_numbers: s === 'empty' ? [] : [{ phone_number: num }] });
    }
    if (url.includes('/IncomingPhoneNumbers.json') && method === 'POST') {
      const b = opts.buy ?? 'ok';
      if (b === 'throw') throw new Error('timeout');
      if (b === 400) return new Response(JSON.stringify({ message: 'number unavailable' }), { status: 400 });
      if (b === 500) return new Response(JSON.stringify({ message: 'oops' }), { status: 500 });
      return Response.json({ phone_number: num, sid: 'PN1' }, { status: 201 });
    }
    if (url.includes('/IncomingPhoneNumbers.json') && method === 'GET') {
      return Response.json({ incoming_phone_numbers: opts.existsAfter ? [{ phone_number: num, sid: 'PN1' }] : [] });
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({});
  }) as unknown as typeof fetch;
  return { fetch: f, calls, buys: () => calls.filter((c) => c.startsWith('POST /IncomingPhoneNumbers')).length };
}

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
    expect(await provisionNumber('305', { env: configured, fetchImpl: good.fetch })).toEqual({ ok: true, phone: BOUGHT, mock: false });
  });

  test('an ambiguous purchase (timeout / 5xx) that actually went through is adopted, not bought twice', async () => {
    for (const buy of ['throw', 500] as const) {
      const t = fakeTwilio({ buy, existsAfter: true });
      expect(await provisionNumber('305', { env: configured, fetchImpl: t.fetch })).toEqual({ ok: true, phone: BOUGHT, mock: false });
      expect(t.buys()).toBe(1);
    }
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
  afterEach(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: 'businesses/provision' } } });
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

  test('a bought number that cannot be saved is released, not orphaned', async () => {
    const holder = await bare();
    const biz = await bare();
    const taken = '+13057770177';
    // already used by another business: the unique constraint makes saving it fail
    await prisma.business.update({ where: { id: holder.id }, data: { phone: taken, phoneKey: taken.slice(-10), phoneE164: taken } });
    await withEnv({ ...TWILIO_ENV }, async () => {
      const twilio = fakeTwilio({ number: taken, existsAfter: true });
      const res = await withFetch(twilio.fetch, () => post(biz.id));
      expect(res.status).toBe(502);
      expect(((await res.json()) as any).code).toBe('number_record_failed');
      expect(twilio.calls.some((c) => c.startsWith('DELETE /IncomingPhoneNumbers/PN1'))).toBe(true); // released
    });
    expect((await row(biz.id)).phone).toBeNull();
    expect((await events(biz.id)).map((e) => e.action)).toEqual(['provision.number_record_failed']);
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
