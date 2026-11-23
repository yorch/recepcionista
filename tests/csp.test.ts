/** Content-Security-Policy: pure builder + what src/proxy.ts puts on page and API responses. */
import { afterEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { API_CSP, buildCsp, cspHeadersFor, newNonce } from '../src/lib/csp';
import { proxy } from '../src/proxy';

const env = process.env as Record<string, string | undefined>;
const saved = { ADMIN_TOKEN: env.ADMIN_TOKEN, CSP_REPORT_ONLY: env.CSP_REPORT_ONLY, CSP_REPORT_URI: env.CSP_REPORT_URI, NODE_ENV: env.NODE_ENV };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete env[k]; else env[k] = v; }
});

describe('buildCsp', () => {
  test('strict: nonce + strict-dynamic, no unsafe-inline for scripts, locked-down everything else', () => {
    const csp = buildCsp({ mode: 'strict', nonce: 'abc', isDev: false });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toContain('unsafe-eval');
    for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", 'upgrade-insecure-requests']) expect(csp).toContain(d);
  });
  test('dev adds unsafe-eval and websockets; moderate uses unsafe-inline without a nonce', () => {
    expect(buildCsp({ mode: 'strict', nonce: 'abc', isDev: true })).toContain("'unsafe-eval'");
    const mod = buildCsp({ mode: 'moderate', isDev: false });
    expect(mod).toContain("script-src 'self' 'unsafe-inline'");
    expect(mod).not.toContain('nonce-');
  });
  test('nonces are unique, 128 bit base64', () => {
    const a = newNonce(); const b = newNonce();
    expect(a).not.toBe(b);
    expect(atob(a).length).toBe(16);
  });
  test('CSP_REPORT_ONLY enforces moderate and reports strict; CSP_REPORT_URI is appended', () => {
    const on = cspHeadersFor('n1', { NODE_ENV: 'production', CSP_REPORT_ONLY: 'true', CSP_REPORT_URI: 'https://c.example/r' } as unknown as NodeJS.ProcessEnv);
    const h = Object.fromEntries(on.response);
    expect(h['Content-Security-Policy']).toContain("'unsafe-inline'");
    expect(h['Content-Security-Policy-Report-Only']).toContain("'nonce-n1'");
    expect(h['Content-Security-Policy-Report-Only']).toContain('report-uri https://c.example/r');
    expect(on.enforced).toContain("'nonce-n1'"); // the request carries the strict policy so Next stamps the nonce
    const off = Object.fromEntries(cspHeadersFor('n2', { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv).response);
    expect(off['Content-Security-Policy']).toContain("'nonce-n2'");
    expect(off['Content-Security-Policy-Report-Only']).toBeUndefined();
  });
});

describe('proxy CSP', () => {
  const get = (path: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
  test('public pages get a fresh nonce per request, forwarded to the renderer; a client-sent CSP is ignored', async () => {
    env.ADMIN_TOKEN = 'x'; delete env.CSP_REPORT_ONLY;
    const a = await get('/login', { 'content-security-policy': "script-src 'unsafe-inline'", 'x-nonce': 'attacker' });
    const b = await get('/signup');
    const ca = a.headers.get('content-security-policy')!;
    const cb = b.headers.get('content-security-policy')!;
    expect(ca).toMatch(/'nonce-[A-Za-z0-9+/=]{22,}'/);
    expect(ca).not.toContain('attacker');
    expect(ca.match(/nonce-([^']+)/)![1]).not.toBe(cb.match(/nonce-([^']+)/)![1]);
    // the policy rides on the forwarded request headers (x-middleware-request-*), which is how Next finds the nonce
    expect(a.headers.get('x-middleware-request-content-security-policy')).toBe(ca);
  });
  test('API responses get the no-load policy; robots/sitemap pass', async () => {
    env.ADMIN_TOKEN = 'x';
    expect((await get('/api/health')).headers.get('content-security-policy')).toBe(API_CSP);
    for (const p of ['/robots.txt', '/sitemap.xml']) expect((await get(p)).headers.get('x-middleware-next')).toBe('1');
  });
});
