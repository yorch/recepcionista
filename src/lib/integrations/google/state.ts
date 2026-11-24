/**
 * OAuth `state` (signed, short-lived, bound to user + business + session) and PKCE.
 * state = base64url(JSON{u,b,s,n,exp}) + '.' + HMAC. The PKCE verifier never travels in the URL: it is kept in an HttpOnly
 * cookie, encrypted and bound to the state nonce (aad), so a stolen state alone is useless.
 */
import crypto from 'node:crypto';
import { decryptSecret, encryptSecret } from '@/lib/totp';
import { hmac, safeEqualHex } from './config';

export const PKCE_COOKIE = 'rc_gcal_pkce';
export const STATE_TTL_MS = 10 * 60_000;

export interface StatePayload { u: string | null; b: string; s: string | null; n: string; exp: number }

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

export function signState(p: Omit<StatePayload, 'n' | 'exp'>, now: number = Date.now()): { state: string; nonce: string } {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...p, n: nonce, exp: now + STATE_TTL_MS })).toString('base64url');
  return { state: `${body}.${hmac('state', body)}`, nonce };
}

export function verifyState(state: string | null | undefined, now: number = Date.now()): StatePayload | null {
  const [body, sig, extra] = String(state ?? '').split('.');
  if (!body || !sig || extra !== undefined || !safeEqualHex(hmac('state', body), sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
    if (typeof p.b !== 'string' || typeof p.n !== 'string' || typeof p.exp !== 'number' || p.exp < now) return null;
    return p;
  } catch { return null; }
}

export const sealVerifier = (verifier: string, nonce: string): string => encryptSecret(verifier, `pkce:${nonce}`);
export function openVerifier(sealed: string | null | undefined, nonce: string): string | null {
  if (!sealed) return null;
  try { return decryptSecret(sealed, `pkce:${nonce}`); } catch { return null; }
}
