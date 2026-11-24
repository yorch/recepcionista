/**
 * Round-3 review fixes that need no database: billing fail-closed defaults (B1), owner-phone grandfather guard (B1),
 * the post-call webhook secret rules (H1), the fixed verification text and canonical challenge (H2/M1), the CSP for
 * Turnstile (M3, see csp.test.ts), email/trial normalisation (L1) and tenant text in invite mail (L2).
 */
import { describe, expect, test } from 'bun:test';
import { billingEnforced, isProvisioningAllowed } from '../src/lib/db/usage';
import { ownerAlertStatus, ownerPhoneGrandfathered, ownerPhoneGrandfatherProblem } from '../src/lib/messaging/owner';
import { challengeId, createOwnerPhoneChallenge, ownerVerificationText, parseOwnerPhoneChallenge, verifyOwnerPhoneChallenge } from '../src/lib/messaging/owner-verify';
import { ensurePostCallWebhook } from '../src/lib/voice/postcall';
import { inviteTemplate, safeDisplayName } from '../src/lib/email/templates';
import { emailFingerprint, normalizeEmailForTrial } from '../src/lib/billing/trial';
import { outOfServiceOverride, OUT_OF_SERVICE_MAX_SECONDS } from '../src/lib/voice/capacity';
import { initiationAgentOverrides } from '../src/lib/voice/initiation-config';

const env = (o: Record<string, string | undefined>) => o as unknown as NodeJS.ProcessEnv;
const none = { billing_status: 'none' as const, past_due_since: null };
const active = { billing_status: 'active' as const, past_due_since: null };

describe('B1: billing fails closed in production', () => {
  test('production enforces unless BILLING_ENFORCED is exactly "false"; dev/test only with "true"', () => {
    expect(billingEnforced(env({ NODE_ENV: 'production' }))).toBe(true);
    expect(billingEnforced(env({ NODE_ENV: 'production', BILLING_ENFORCED: '' }))).toBe(true);
    expect(billingEnforced(env({ NODE_ENV: 'production', BILLING_ENFORCED: 'true' }))).toBe(true);
    expect(billingEnforced(env({ NODE_ENV: 'production', BILLING_ENFORCED: 'flase' }))).toBe(true); // a typo still enforces
    expect(billingEnforced(env({ NODE_ENV: 'production', BILLING_ENFORCED: 'false' }))).toBe(false);
    expect(billingEnforced(env({ NODE_ENV: 'development' }))).toBe(false);
    expect(billingEnforced(env({ NODE_ENV: 'test' }))).toBe(false);
    expect(billingEnforced(env({ NODE_ENV: 'test', BILLING_ENFORCED: 'true' }))).toBe(true);
    expect(billingEnforced(env({}))).toBe(false);
  });
  test('non-admin provisioning ALWAYS needs a plan in production, even with BILLING_ENFORCED=false', () => {
    const prodOff = env({ NODE_ENV: 'production', BILLING_ENFORCED: 'false' });
    expect(isProvisioningAllowed(none, new Date(), prodOff)).toBe(false);
    expect(isProvisioningAllowed(active, new Date(), prodOff)).toBe(true);
    expect(isProvisioningAllowed(none, new Date(), env({ NODE_ENV: 'production' }))).toBe(false);
    expect(isProvisioningAllowed(none, new Date(), env({ NODE_ENV: 'development' }))).toBe(true); // dev stays open
  });
});

describe('B1: OWNER_PHONE_GRANDFATHER is acknowledged, time-boxed and cut off', () => {
  const b = { owner_phone: '+13055550111', owner_phone_verified_at: null, created_at: '2026-11-01T00:00:00.000Z' };
  test('ignored in production without the acknowledgement; honoured with it', () => {
    const prod = { NODE_ENV: 'production', OWNER_PHONE_GRANDFATHER: 'true' };
    expect(ownerAlertStatus(b, prod)).toBe('unverified');
    expect(ownerAlertStatus(b, { ...prod, OWNER_PHONE_GRANDFATHER_ACK: 'yes' })).toBe('unverified');
    expect(ownerAlertStatus(b, { ...prod, OWNER_PHONE_GRANDFATHER_ACK: 'i-understand' })).toBe('ok');
    expect(ownerAlertStatus(b, { NODE_ENV: 'test', OWNER_PHONE_GRANDFATHER: 'true' })).toBe('ok');
  });
  test('UNTIL expires it (unparseable fails closed); BEFORE only covers businesses created earlier', () => {
    const base = { OWNER_PHONE_GRANDFATHER: 'true', NODE_ENV: 'test' };
    const now = Date.parse('2026-12-01T00:00:00Z');
    expect(ownerPhoneGrandfathered({ ...base, OWNER_PHONE_GRANDFATHER_UNTIL: '2026-12-31T00:00:00Z' }, b, now)).toBe(true);
    expect(ownerPhoneGrandfathered({ ...base, OWNER_PHONE_GRANDFATHER_UNTIL: '2026-11-30T00:00:00Z' }, b, now)).toBe(false);
    expect(ownerPhoneGrandfathered({ ...base, OWNER_PHONE_GRANDFATHER_UNTIL: 'soon' }, b, now)).toBe(false);
    expect(ownerPhoneGrandfathered({ ...base, OWNER_PHONE_GRANDFATHER_BEFORE: '2026-11-15T00:00:00Z' }, b, now)).toBe(true);
    expect(ownerPhoneGrandfathered({ ...base, OWNER_PHONE_GRANDFATHER_BEFORE: '2026-11-15T00:00:00Z' }, { created_at: '2026-11-20T00:00:00.000Z' }, now)).toBe(false);
    expect(ownerPhoneGrandfathered({ ...base, OWNER_PHONE_GRANDFATHER_BEFORE: '2026-11-15T00:00:00Z' }, {}, now)).toBe(false);
  });
  test('startup diagnostics: nothing when off, an "ignored" warning without the ack, a loud warning with it', () => {
    expect(ownerPhoneGrandfatherProblem({})).toBeNull();
    expect(ownerPhoneGrandfatherProblem({ NODE_ENV: 'production', OWNER_PHONE_GRANDFATHER: 'true' })).toContain('IGNORED');
    expect(ownerPhoneGrandfatherProblem({ NODE_ENV: 'production', OWNER_PHONE_GRANDFATHER: 'true', OWNER_PHONE_GRANDFATHER_ACK: 'i-understand' })).toContain('is ON');
  });
});

describe('H1: ensurePostCallWebhook never leaks or duplicates the platform webhook', () => {
  const URL_ = 'https://app.example.test/api/voice/post-call';
  function stub(handlers: { list: () => Response; create?: () => Response }) {
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.replace('https://api.elevenlabs.io/v1', '')}`);
      if (method === 'GET') return handlers.list();
      if (!handlers.create) throw new Error('create must not be called');
      return handlers.create();
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const withKey = async <T>(fn: () => Promise<T>) => {
    const saved = { k: process.env.ELEVENLABS_API_KEY, u: process.env.PUBLIC_BASE_URL, a: process.env.APP_URL };
    process.env.ELEVENLABS_API_KEY = 'xi-test'; process.env.APP_URL = 'https://app.example.test';
    try { return await fn(); } finally {
      for (const [k, v] of [['ELEVENLABS_API_KEY', saved.k], ['PUBLIC_BASE_URL', saved.u], ['APP_URL', saved.a]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
  test('a failing list (429) is retried and then fails SAFELY: nothing is created, even for an admin', () => withKey(async () => {
    const s = stub({ list: () => new Response('rate limited', { status: 429 }) });
    const r = await ensurePostCallWebhook({ allowCreate: true, listAttempts: 3, retryDelayMs: 0, fetchImpl: s.fetchImpl });
    expect(r.webhook_id).toBeNull();
    expect(r.webhook_secret).toBeUndefined();
    expect(r.error).toContain('not creating one');
    expect(s.calls).toEqual(['GET /workspace/webhooks', 'GET /workspace/webhooks', 'GET /workspace/webhooks']);
  }));
  test('a transient list error is retried and then finds the existing webhook (no create, no secret)', () => withKey(async () => {
    let n = 0;
    const s = stub({ list: () => (++n < 2 ? new Response('x', { status: 503 }) : Response.json({ webhooks: [{ webhook_id: 'wh_1', webhook_url: URL_ }] })) });
    const r = await ensurePostCallWebhook({ allowCreate: true, retryDelayMs: 0, fetchImpl: s.fetchImpl });
    expect(r).toEqual({ webhook_id: 'wh_1', mock: false });
  }));
  test('without allowCreate (a tenant call) a missing webhook is an error, never a creation', () => withKey(async () => {
    const s = stub({ list: () => Response.json({ webhooks: [] }) });
    const r = await ensurePostCallWebhook({ retryDelayMs: 0, fetchImpl: s.fetchImpl });
    expect(r.webhook_id).toBeNull();
    expect(r.webhook_secret).toBeUndefined();
    expect(s.calls).toEqual(['GET /workspace/webhooks']);
  }));
  test('an admin call creates it once and receives the one-time secret', () => withKey(async () => {
    const s = stub({ list: () => Response.json({ webhooks: [] }), create: () => Response.json({ webhook_id: 'wh_new', webhook_secret: 'wsec_x' }) });
    const r = await ensurePostCallWebhook({ allowCreate: true, retryDelayMs: 0, fetchImpl: s.fetchImpl });
    expect(r).toEqual({ webhook_id: 'wh_new', mock: false, webhook_secret: 'wsec_x' });
    expect(s.calls).toEqual(['GET /workspace/webhooks', 'POST /workspace/webhooks']);
  }));
});

describe('H2 / M1: the verification text is fixed and the challenge is canonical', () => {
  test('the SMS body contains only the template and the code (no tenant text)', () => {
    const t = ownerVerificationText('123456');
    expect(t).toBe('Recepcionista verification code: 123456. It expires in 10 minutes. If you did not request it, ignore this message.');
    expect(t).not.toMatch(/https?:|www\./i);
  });
  test('whitespace / padding / re-encoded variants of a challenge are rejected and share no limiter key', () => {
    const { code, challenge } = createOwnerPhoneChallenge('b1', '+13055550123');
    const ok = verifyOwnerPhoneChallenge(challenge, 'b1', '+13055550123', code);
    expect(ok).toEqual({ ok: true });
    for (const variant of [`${challenge} `, ` ${challenge}`, `${challenge}\n`, `${challenge}=`, `${challenge}==`, `${challenge}\t\t`, `${challenge.slice(0, -1)}\n${challenge.slice(-1)}`]) {
      expect(verifyOwnerPhoneChallenge(variant, 'b1', '+13055550123', code).ok).toBe(false);
      expect(parseOwnerPhoneChallenge(variant)).toBeNull();
      expect(challengeId(variant)).toBeNull(); // no id of its own: it can never mint a fresh attempt bucket
    }
    // signature re-spelled with a different (but decoder-equivalent) padding: rejected too
    const [payload, sig] = challenge.split('.');
    expect(parseOwnerPhoneChallenge(`${payload}.${sig}=`)).toBeNull();
    expect(challengeId(challenge)).toBe(challengeId(challenge));
    expect(challengeId(challenge)).toMatch(/^[0-9a-f]{32}$/);
    expect(challengeId(createOwnerPhoneChallenge('b1', '+13055550123').challenge)).not.toBe(challengeId(challenge));
  });
});

describe('L1: trial fingerprints', () => {
  test('email normalisation: case, +tag and Gmail dots', () => {
    expect(normalizeEmailForTrial('A.B.C+promo@Gmail.com')).toBe('abc@gmail.com');
    expect(normalizeEmailForTrial('abc@googlemail.com')).toBe('abc@gmail.com');
    expect(normalizeEmailForTrial('Owner+x@Example.com')).toBe('owner@example.com');
    expect(normalizeEmailForTrial('a.b@example.com')).toBe('a.b@example.com'); // dots matter outside Gmail
    expect(emailFingerprint('A.B+1@gmail.com')).toBe(emailFingerprint('ab@gmail.com'));
    expect(emailFingerprint('ab@gmail.com')).not.toBe(emailFingerprint('ac@gmail.com'));
    expect(emailFingerprint('ab@gmail.com')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('L2: tenant text in platform email', () => {
  test('URLs, e-mail addresses and phone numbers are stripped from the business name, which is quoted', () => {
    expect(safeDisplayName('Chase Fraud Alert call 1-888-555-0100 or visit https://chase-verify.example/now')).toBe('Chase Fraud Alert call or visit');
    expect(safeDisplayName('Totally Real LLC bank-login.com')).toBe('Totally Real LLC');
    expect(safeDisplayName('http://evil.example')).toBe('a Recepcionista account');
    const mail = inviteTemplate({ link: 'https://app.example.test/accept?token=t', businessName: 'Pay now at https://evil.example +1 305 555 0100', role: 'staff', inviterEmail: 'o@x.test' });
    expect(mail.subject).toBe('You are invited to join a Recepcionista account');
    expect(mail.text).not.toContain('evil.example');
    expect(mail.text).not.toContain('555 0100');
    expect(mail.text).toContain('an account named “Pay now at”');
    expect(mail.html).not.toContain('evil.example');
  });
});

describe('M6: out-of-service calls are cut short', () => {
  test('the initiation override carries a short max duration, and the agent is allowed to take it', () => {
    const o = outOfServiceOverride({ id: 'b', name: 'Biz' } as never);
    expect(o.conversation.max_duration_seconds).toBe(OUT_OF_SERVICE_MAX_SECONDS);
    expect(o.agent.first_message.length).toBeGreaterThan(20);
    expect(JSON.stringify(initiationAgentOverrides())).toContain('max_duration_seconds');
  });
});
