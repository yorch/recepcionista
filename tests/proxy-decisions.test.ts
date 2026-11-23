/**
 * Proxy / auth decision matrix for tricky paths. Complements tests/auth-paths.test.ts
 * (which covers the basics of isPublicPath): this file drives src/proxy.ts itself.
 * No database needed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { proxy } from '../src/proxy';
import { isPublicPath, SESSION_COOKIE } from '../src/lib/auth';

const TOKEN = 'proxy-matrix-admin-token';
const ENV_KEYS = ['ADMIN_TOKEN', 'ALLOW_INSECURE_DEV', 'NODE_ENV'] as const;
const env = process.env as Record<string, string | undefined>; // NODE_ENV is read-only in the typings
// Captured per test, not at load: other files set these variables at load time and we must not undo that.
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) {
    if (k in patch) env[k] = patch[k];
    else if (k !== 'NODE_ENV') delete env[k];
  }
}

const req = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, { headers });

/** 'next' = the request is let through; otherwise the status (401/503) or 'redirect:<location path>'. */
async function decide(path: string, headers: Record<string, string> = {}): Promise<string | number> {
  const res = await proxy(req(path, headers));
  if (res.headers.get('x-middleware-next') === '1') return 'next';
  if (res.status >= 300 && res.status < 400) {
    const loc = new URL(res.headers.get('location') ?? '', 'http://localhost:3000');
    return `redirect:${loc.pathname}${loc.search}`;
  }
  return res.status;
}

describe('proxy with ADMIN_TOKEN set', () => {
  test('public paths pass without credentials', async () => {
    setEnv({ ADMIN_TOKEN: TOKEN });
    for (const p of ['/', '/login', '/api/health', '/api/voice/post-call', '/api/voice/incoming', '/api/payments/webhook', '/api/voice/tools/create_booking', '/pay/abc', '/api/sms/gratitude-reply', '/signup', '/verify-email', '/verify-email-sent', '/forgot-password', '/reset-password', '/accept-invite', '/login/mfa', '/api/auth/signup', '/api/auth/mfa']) {
      expect([p, await decide(p)]).toEqual([p, 'next']);
    }
  });

  test('admin APIs answer 401 JSON, pages redirect to /login?next=', async () => {
    setEnv({ ADMIN_TOKEN: TOKEN });
    for (const p of ['/api/businesses', '/api/sms/send', '/api/voice/agent-prompt', '/api/demo/reset', '/api/payments/create-link', '/api/businesses/x/provision']) {
      expect([p, await decide(p)]).toEqual([p, 401]);
    }
    expect(await decide('/dashboard')).toBe('redirect:/login?next=%2Fdashboard');
    expect(await decide('/calls/123')).toBe('redirect:/login?next=%2Fcalls%2F123');
  });

  test('Bearer token and session cookie authenticate; near-misses do not', async () => {
    setEnv({ ADMIN_TOKEN: TOKEN });
    const cookie = `${SESSION_COOKIE}=${'c'.repeat(43)}`; // opaque session token: the proxy only checks its shape
    expect(await decide('/api/businesses', { authorization: `Bearer ${TOKEN}` })).toBe('next');
    expect(await decide('/api/businesses', { authorization: `bearer ${TOKEN}` })).toBe('next');
    expect(await decide('/api/businesses', { cookie })).toBe('next');
    expect(await decide('/dashboard', { cookie: `a=b; ${cookie}` })).toBe('next');

    expect(await decide('/api/businesses', { authorization: `Bearer ${TOKEN}x` })).toBe(401);
    expect(await decide('/api/businesses', { authorization: TOKEN })).toBe(401);
    expect(await decide('/api/businesses', { authorization: `Basic ${TOKEN}` })).toBe(401);
    expect(await decide('/api/businesses', { authorization: 'Bearer ' })).toBe(401);
    expect(await decide('/api/businesses', { cookie: `${SESSION_COOKIE}=short-token` })).toBe(401); // too short to be a session token
    expect(await decide('/api/businesses', { cookie: `${SESSION_COOKIE}=` })).toBe(401);
    expect(await decide('/api/businesses', { cookie: `x${SESSION_COOKIE}=${'c'.repeat(43)}` })).toBe(401);
  });

  test('tricky paths stay protected', async () => {
    setEnv({ ADMIN_TOKEN: TOKEN });
    const protectedPaths = [
      '/api/voice/tools/../../businesses',
      '/api/voice/tools/%2e%2e/%2e%2e/businesses',
      '/pay/../api/businesses',
      '/api//businesses',
      '/api/businesses/',
      '/api/health/../businesses',
      '/api/voice/webhook/../../businesses',
      '/api/voice/tools', // the prefix needs a tool name
      '/api/payments/webhook/../create-link',
      '/api/auth/login/../../businesses',
      '/pay', // only /pay/<id> is public
      '/API/businesses',
      '/api/businesses;/x',
      '/api/voice/post-call%00',
    ];
    for (const p of protectedPaths) {
      const d = await decide(p);
      expect([p, d === 'next']).toEqual([p, false]);
    }
  });

  test('encoded separators cannot make an admin route look public', () => {
    // The proxy decodes %2f and collapses ".."; the Next router does NOT, so a path such as
    // /api/businesses/..%2fvoice%2ftools%2fx is normalised to the public /api/voice/tools/x by
    // isPublicPath but is dispatched to /api/businesses/[id] (id="../voice/tools/x").
    // Admin handlers still call guardAdmin(), but the allowlist itself must not be confusable.
    for (const p of [
      '/api/businesses/..%2fvoice%2ftools%2fx',
      '/api/businesses/%2e%2e%2fvoice%2ftools%2fx',
      '/api/businesses/..%2Fhealth',
      '/dashboard/..%2f..%2flogin',
      '/dashboard%2f..%2flogin',
      '/api/businesses/x%5c..%5c..%5chealth',
    ]) {
      expect([p, isPublicPath(p)]).toEqual([p, false]);
    }
  });
});

describe('proxy misconfiguration and dev mode', () => {
  test('without ADMIN_TOKEN and without the dev opt-in everything non-public fails closed (503)', async () => {
    setEnv({});
    expect(await decide('/api/businesses')).toBe(503);
    expect(await decide('/api/businesses', { authorization: 'Bearer anything' })).toBe(503);
    expect(await decide('/dashboard')).toBe(503);
    expect(await decide('/api/health')).toBe('next');
  });

  test('ALLOW_INSECURE_DEV opens the admin surface outside production only', async () => {
    setEnv({ ALLOW_INSECURE_DEV: 'true', NODE_ENV: 'development' });
    expect(await decide('/api/businesses')).toBe('next');
    setEnv({ ALLOW_INSECURE_DEV: 'true', NODE_ENV: 'production' });
    expect(await decide('/api/businesses')).toBe(503);
    setEnv({ ALLOW_INSECURE_DEV: '1', NODE_ENV: 'development' });
    expect(await decide('/api/businesses')).toBe(503); // only the exact string "true" counts
  });

  test('an ADMIN_TOKEN that is only whitespace counts as unset', async () => {
    setEnv({ ADMIN_TOKEN: '   ' });
    expect(await decide('/api/businesses')).toBe(503);
  });
});
