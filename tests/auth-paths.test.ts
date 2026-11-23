import { describe, expect, test } from 'bun:test';
import { isPublicPath, normalizePath, clientKey } from '../src/lib/auth';

describe('isPublicPath', () => {
  test('known public paths', () => {
    for (const p of ['/', '/robots.txt', '/sitemap.xml', '/login', '/api/health', '/api/auth/login', '/api/voice/tools/create_booking', '/pay/bk_1', '/favicon.ico', '/_next/static/chunk.js', '/api/pay/mock-complete',
      '/signup', '/verify-email', '/verify-email-sent', '/forgot-password', '/reset-password', '/accept-invite', '/login/mfa',
      '/api/auth/signup', '/api/auth/verify-email', '/api/auth/resend-verification', '/api/auth/forgot-password', '/api/auth/reset-password',
      '/api/auth/accept-invite', '/api/auth/mfa', '/api/auth/logout']) {
      expect(isPublicPath(p)).toBe(true);
    }
  });
  test('agent-prompt and admin APIs are not public', () => {
    for (const p of ['/api/voice/agent-prompt', '/api/businesses', '/api/sms/send', '/dashboard', '/onboarding', '/audio/briefing-x-2026-01-01.mp3', '/api/admin/retention', '/api/admin/release-tenant',
      '/api/auth/2fa/enroll', '/api/auth/2fa/confirm', '/api/auth/2fa/disable', '/api/auth/sessions', '/api/auth/revoke-admin-sessions', '/api/auth/me',
      '/api/team', '/api/team/invite', '/api/team/users/x', '/api/team/audit', '/dashboard/team', '/dashboard/security', '/signup/x', '/verify-email/x']) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
  test('file extensions never make an API path public', () => {
    for (const p of ['/api/businesses/x.js', '/api/businesses/x.txt', '/api/businesses/x.css', '/api/businesses/x.map', '/dashboard/x.png']) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
  test('traversal, encoded and slash tricks do not widen the allowlist', () => {
    for (const p of ['/pay/../api/businesses', '/pay/%2e%2e/api/businesses', '/api/voice/tools/../../businesses', '/pay\\..\\api', '//api/businesses', '/api/voice/webhook-foo', '/%2e%2e/api/businesses', '/pay/%zz']) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
  test('trailing slash and repeated slashes normalise', () => {
    expect(isPublicPath('/login/')).toBe(true);
    expect(isPublicPath('/api//health')).toBe(true);
    expect(normalizePath('/a/./b/../c')).toBe('/a/c');
    expect(normalizePath('/a%00b')).toBeNull();
  });
});

describe('clientKey', () => {
  test('ignores spoofable forwarding headers unless TRUSTED_PROXY=true', () => {
    delete process.env.TRUSTED_PROXY;
    const req = new Request('http://x/', { headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' } });
    expect(clientKey(req)).toBe('untrusted');
    process.env.TRUSTED_PROXY = 'true';
    const req2 = new Request('http://x/', { headers: { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' } });
    expect(clientKey(req2)).toBe('1.2.3.4');
    // behind a CDN AND a proxy the client is the 2nd hop from the right, not the CDN's address
    const cdn = new Request('http://x/', { headers: { 'x-forwarded-for': 'spoofed, 203.0.113.7, 172.16.0.9' } });
    expect(clientKey(cdn)).toBe('172.16.0.9');
    process.env.TRUSTED_PROXY_HOPS = '2';
    expect(clientKey(cdn)).toBe('203.0.113.7');
    process.env.TRUSTED_PROXY_HOPS = '99';
    expect(clientKey(cdn)).toBe('spoofed'.slice(0, 7)); // clamped to 5 hops, then to the left-most entry
    delete process.env.TRUSTED_PROXY_HOPS;
    delete process.env.TRUSTED_PROXY;
  });
});
