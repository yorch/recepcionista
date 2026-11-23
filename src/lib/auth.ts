/**
 * Shared-secret admin auth. Edge/Node safe (Web Crypto only) because it is
 * used from src/proxy.ts as well as route handlers.
 *
 * The raw ADMIN_TOKEN never lands in a cookie: the session cookie holds an
 * HMAC-SHA256 derived from it, so a leaked cookie cannot be replayed as the
 * Bearer token and rotating ADMIN_TOKEN invalidates every session.
 */

export const SESSION_COOKIE = 'rc_session';
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 7;

const SESSION_CONTEXT = 'recepcionista-admin-session-v1';

/** Paths reachable without admin auth (provider webhooks verify their own signatures). */
const PUBLIC_API_EXACT = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/voice/webhook',
  '/api/voice/post-call',
  '/api/voice/incoming',
  '/api/voice/agent-prompt',
  '/api/payments/webhook',
  '/api/sms/gratitude-reply',
]);
const PUBLIC_API_PREFIX = ['/api/voice/tools/'];
const PUBLIC_PAGE_EXACT = new Set(['/', '/login']);
const PUBLIC_PAGE_PREFIX = ['/pay/'];

export function isPublicPath(pathname: string): boolean {
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (PUBLIC_API_EXACT.has(p) || PUBLIC_PAGE_EXACT.has(p)) return true;
  return [...PUBLIC_API_PREFIX, ...PUBLIC_PAGE_PREFIX].some((x) => p.startsWith(x));
}

let warned = false;

export type AuthConfig =
  | { mode: 'enforce'; token: string }
  | { mode: 'open' }      // dev, ADMIN_TOKEN unset
  | { mode: 'misconfigured' }; // prod, ADMIN_TOKEN unset -> fail closed

export function authConfig(): AuthConfig {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (token) return { mode: 'enforce', token };
  if (process.env.NODE_ENV === 'production') return { mode: 'misconfigured' };
  if (!warned) {
    warned = true;
    console.warn('[auth] ADMIN_TOKEN is not set: admin auth is DISABLED (development only).');
  }
  return { mode: 'open' };
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

/** Constant-time string comparison (length is not secret: callers compare fixed-size digests). */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Value stored in the session cookie. */
export async function sessionValue(token: string): Promise<string> {
  return hmacHex(token, SESSION_CONTEXT);
}

/** Compare two secrets without leaking content/length: compare HMAC digests. */
export async function tokensMatch(candidate: string, token: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmacHex(token, `cmp:${candidate}`), hmacHex(token, `cmp:${token}`)]);
  return timingSafeEqual(a, b);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** True when the request carries a valid session cookie or Bearer token. */
export async function isAuthenticated(req: Request): Promise<boolean> {
  const cfg = authConfig();
  if (cfg.mode === 'open') return true;
  if (cfg.mode === 'misconfigured') return false;

  const authz = req.headers.get('authorization');
  if (authz && /^bearer /i.test(authz)) {
    if (await tokensMatch(authz.slice(7).trim(), cfg.token)) return true;
  }
  const cookie = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
  if (cookie) {
    return timingSafeEqual(cookie, await sessionValue(cfg.token));
  }
  return false;
}

/**
 * Defense in depth for route handlers (the proxy already gates /api/**).
 * Returns a Response to send when unauthenticated, otherwise null.
 */
export async function requireAdmin(req: Request): Promise<Response | null> {
  if (await isAuthenticated(req)) return null;
  const misconfigured = authConfig().mode === 'misconfigured';
  return Response.json(
    { ok: false, error: misconfigured ? 'server auth not configured' : 'unauthorized' },
    { status: misconfigured ? 503 : 401 },
  );
}

/** Headers for server-to-server calls to this app's own protected /api routes. */
export function internalAuthHeaders(): Record<string, string> {
  const token = process.env.ADMIN_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Demo-only routes (reset/simulate) are 404 unless DEMO_MODE=true. */
export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === 'true';
}

/** Best-effort client key for rate limiting. */
export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  const ip = fwd?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
  const authz = req.headers.get('authorization');
  return authz ? `tok:${authz.length}:${ip}` : ip;
}
