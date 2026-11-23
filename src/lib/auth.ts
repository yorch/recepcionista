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
  '/api/payments/webhook',
  // Public checkout page's "Pay" button. The route itself 404s unless DEMO_MODE=true and reads the amount from the DB.
  '/api/pay/mock-complete',
  '/api/sms/gratitude-reply',
]);
const PUBLIC_API_PREFIX = ['/api/voice/tools/'];
const PUBLIC_PAGE_EXACT = new Set(['/', '/login']);
const PUBLIC_PAGE_PREFIX = ['/pay/'];

/** Static assets that are really served from public/ or Next internals. */
const PUBLIC_STATIC_PREFIX = ['/_next/static/', '/_next/image', '/audio/'];
const PUBLIC_STATIC_EXACT = new Set(['/favicon.ico']);

/** Decode and normalise a path so `%2e%2e`, `//`, `\\` and trailing slashes cannot dodge the allowlists. Returns null if it looks hostile. */
export function normalizePath(pathname: string): string | null {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  if (p.includes('\\') || p.includes('\0') || !p.startsWith('/')) return null;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

export function isPublicPath(pathname: string): boolean {
  const p = normalizePath(pathname);
  if (p === null) return false;
  if (PUBLIC_API_EXACT.has(p) || PUBLIC_PAGE_EXACT.has(p) || PUBLIC_STATIC_EXACT.has(p)) return true;
  return [...PUBLIC_API_PREFIX, ...PUBLIC_PAGE_PREFIX, ...PUBLIC_STATIC_PREFIX].some((x) => p.startsWith(x));
}

/**
 * Explicit opt-in for local development only. Skips admin auth, webhook
 * signature checks and tool-secret checks when the matching secret is unset.
 * Never honoured when NODE_ENV=production. NODE_ENV alone is NOT enough: a
 * `next dev` instance behind a tunnel must not silently run open.
 */
export function insecureDevAllowed(): boolean {
  return process.env.ALLOW_INSECURE_DEV === 'true' && process.env.NODE_ENV !== 'production';
}

let warned = false;

export type AuthConfig =
  | { mode: 'enforce'; token: string }
  | { mode: 'open' }      // ALLOW_INSECURE_DEV=true (non-production), ADMIN_TOKEN unset
  | { mode: 'misconfigured' }; // ADMIN_TOKEN unset without the dev opt-in -> fail closed

export function authConfig(): AuthConfig {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (token) return { mode: 'enforce', token };
  if (!insecureDevAllowed()) return { mode: 'misconfigured' };
  if (!warned) {
    warned = true;
    console.warn('[auth] ADMIN_TOKEN is not set and ALLOW_INSECURE_DEV=true: admin auth is DISABLED (local development only).');
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

/**
 * Client key for rate limiting. X-Forwarded-For / X-Real-IP are client
 * controlled unless a trusted proxy overwrites them, so they are only used
 * when TRUSTED_PROXY=true (then the right-most hop, appended by the proxy).
 * Otherwise every caller shares one bucket; callers should also apply a
 * global per-route cap (see limitRequest).
 */
export function clientKey(req: Request): string {
  if (process.env.TRUSTED_PROXY === 'true') {
    const real = req.headers.get('x-real-ip')?.trim();
    const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
    const ip = hops.length ? hops[hops.length - 1] : real;
    if (ip) return ip.slice(0, 64);
  }
  return 'untrusted';
}
