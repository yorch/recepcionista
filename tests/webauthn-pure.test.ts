import { describe, expect, test } from 'bun:test';
import { isPublicPath } from '../src/lib/auth';
import { webauthnConfig } from '../src/lib/webauthn';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe('webauthnConfig (relying party)', () => {
  test('rpID and origin come from PUBLIC_BASE_URL, else APP_URL', () => {
    expect(webauthnConfig(env({ APP_URL: 'https://app.example.com' }))).toEqual({ rpID: 'app.example.com', origins: ['https://app.example.com'] });
    expect(webauthnConfig(env({ APP_URL: 'https://a.example.com', PUBLIC_BASE_URL: 'https://b.example.com/x' }))).toEqual({ rpID: 'b.example.com', origins: ['https://b.example.com'] });
  });
  test('production without a configured origin: not configured (never the request host)', () => {
    expect(webauthnConfig(env({ NODE_ENV: 'production' }), 'https://evil.example')).toBeNull();
    expect(webauthnConfig(env({ NODE_ENV: 'production', APP_URL: 'http://plain.example.com' }))).toBeNull(); // http only for localhost
  });
  test('outside production the request origin is the dev fallback, only when nothing is configured', () => {
    expect(webauthnConfig(env({}), 'http://localhost:3000')).toEqual({ rpID: 'localhost', origins: ['http://localhost:3000'] });
    expect(webauthnConfig(env({}), 'http://lan-host:3000')).toBeNull();
    expect(webauthnConfig(env({ APP_URL: 'https://app.example.com' }), 'http://localhost:3000')?.origins).toEqual(['https://app.example.com']);
  });
  test('WEBAUTHN_ORIGINS adds exact origins; WEBAUTHN_RP_ID widens to a parent domain; origins outside the rpID are dropped', () => {
    const c = webauthnConfig(env({ APP_URL: 'https://app.example.com', WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGINS: 'https://staging.example.com, https://evil.test, http://nope.example.com' }));
    expect(c?.rpID).toBe('example.com');
    expect(c?.origins).toEqual(['https://app.example.com', 'https://staging.example.com']);
    // an rpID that is not a suffix of the base origin leaves nothing valid
    expect(webauthnConfig(env({ APP_URL: 'https://app.example.com', WEBAUTHN_RP_ID: 'other.com' }))).toBeNull();
  });
});

describe('proxy allowlist', () => {
  test('only the two passkey LOGIN endpoints are public', () => {
    expect(isPublicPath('/api/auth/passkeys/login/options')).toBe(true);
    expect(isPublicPath('/api/auth/passkeys/login/verify')).toBe(true);
    for (const p of ['/api/auth/passkeys', '/api/auth/passkeys/register/options', '/api/auth/passkeys/register/verify', '/api/auth/passkeys/reauth/options',
      '/api/auth/passkeys/reauth/verify', '/api/auth/passkeys/abc', '/api/auth/switch-business', '/api/businesses/mine', '/api/auth/passkeys/login/verify/x']) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
});
