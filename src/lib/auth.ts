/**
 * Shared-secret admin auth. Edge/Node safe (Web Crypto only) because it is
 * used from src/proxy.ts as well as route handlers.
 *
 * The raw ADMIN_TOKEN never lands in a cookie. Logging in with it creates a server-side
 * `admin_token` session (src/lib/db/users.ts createAdminSession, 12 h, revocable) whose random opaque
 * token is the cookie value; the proxy here only checks the cookie's SHAPE (the database validates it
 * in Node, src/lib/session.ts). There is no signed/derived admin cookie any more.
 */

/** Break-glass admin session cookie: a random opaque token (DB stores only its sha256). */
export const SESSION_COOKIE = 'rc_session';
export const SESSION_MAX_AGE_S = 60 * 60 * 12;
/** Per-user session cookie: holds the raw opaque token; the DB stores only its sha256. */
export const USER_SESSION_COOKIE = 'rc_user_session';
/** Admin-only UI preference (selected business). Not a credential; always re-checked server-side. */
export const BUSINESS_COOKIE = 'rc_business';

/** Paths reachable without admin auth (provider webhooks verify their own signatures). */
const PUBLIC_API_EXACT = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/logout',
  // Account lifecycle (each handler rate limits, validates and never reveals whether an email exists).
  '/api/auth/signup',
  '/api/auth/verify-email',
  '/api/auth/resend-verification',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/accept-invite',
  '/api/auth/mfa', // second login step: authenticates its own (MFA-pending) session cookie
  // Passwordless sign-in (WebAuthn): public by nature; each handler checks the origin, rate limits and verifies the signed assertion itself.
  '/api/auth/passkeys/login/options',
  '/api/auth/passkeys/login/verify',
  '/api/voice/webhook',
  '/api/voice/post-call',
  '/api/voice/incoming',
  '/api/voice/dial-status', // Twilio per-leg status callback of a forwarded call (meters minutes): verifies the Twilio signature itself
  '/api/voice/screen', // call-screening whisper on the owner's leg (Twilio-signed): verifies the Twilio signature itself
  '/api/voice/transcript-event', // a pushing line's live transcript lines: authenticated by the shared tool secret header
  '/api/voice/voicemail', // Twilio callback for paused/forwarded calls: verifies the Twilio signature itself
  '/api/voice/initiation', // ElevenLabs conversation-initiation webhook: authenticated by the shared tool secret header
  '/api/payments/webhook',
  '/api/billing/webhook',
  // Public checkout page's "Pay" button. The route itself 404s unless DEMO_MODE=true and reads the amount from the DB.
  '/api/pay/mock-complete',
  '/api/sms/gratitude-reply',
  '/api/sms/inbound',
  '/api/sms/status', // Twilio per-message delivery status callback: verifies the Twilio signature itself
  '/api/integrations/google/webhook', // Google Calendar push: authenticated by the channel id + resource id + HMAC channel token (constant time)
]);
const PUBLIC_API_PREFIX = ['/api/voice/tools/'];
const PUBLIC_PAGE_EXACT = new Set([
  '/robots.txt', '/sitemap.xml', '/', '/login', '/login/mfa', '/signup', '/refunds', '/verify-email', '/verify-email-sent', '/forgot-password', '/reset-password', '/accept-invite',
]);
const PUBLIC_PAGE_PREFIX = ['/pay/'];

/** Static assets that are really served from public/ or Next internals. */
const PUBLIC_STATIC_PREFIX = ['/_next/static/', '/_next/image']; // /audio/* is NOT public: it is served by an authenticated route
const PUBLIC_STATIC_EXACT = new Set(['/favicon.ico']);

/** Decode and normalise a path so `%2e%2e`, `//`, `\\` and trailing slashes cannot dodge the allowlists. Returns null if it looks hostile. */
export function normalizePath(pathname: string): string | null {
  // Encoded separators are never legitimate here and Next keeps them inside one segment, so decoding
  // them would let `/api/x/..%2fvoice%2ftools%2fy` look like a public path to the proxy.
  if (/%2f|%5c/i.test(pathname)) return null;
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

/** Compare two secrets without leaking content/length: compare HMAC digests. */
export async function tokensMatch(candidate: string, token: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmacHex(token, `cmp:${candidate}`), hmacHex(token, `cmp:${token}`)]);
  return timingSafeEqual(a, b);
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Cheap shape check for a session token (proxy gating only; the DB validates it in Node handlers). */
export function looksLikeUserSessionToken(v: string | null | undefined): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(v);
}

/** The user-session token from a request's Cookie header, if it has the right shape. */
export function userSessionTokenFrom(headers: Headers): string | null {
  const v = readCookie(headers.get('cookie'), USER_SESSION_COOKIE);
  return looksLikeUserSessionToken(v) ? v : null;
}

/** The break-glass admin-session token from a request's Cookie header, if it has the right shape. */
export function adminSessionTokenFrom(headers: Headers): string | null {
  const v = readCookie(headers.get('cookie'), SESSION_COOKIE);
  return looksLikeUserSessionToken(v) ? v : null;
}

/**
 * Cheap proxy check: the request carries the break-glass ADMIN_TOKEN (Bearer, verified) or a well-formed
 * admin-session cookie (shape only; the database validates it in Node). Edge safe.
 */
export async function hasAdminCredentials(headers: Headers): Promise<boolean> {
  const cfg = authConfig();
  if (cfg.mode !== 'enforce') return false;
  const authz = headers.get('authorization');
  if (authz && /^bearer /i.test(authz) && (await tokensMatch(authz.slice(7).trim(), cfg.token))) return true;
  return adminSessionTokenFrom(headers) !== null;
}

/** True when the request carries one of our session cookies (so cookie CSRF rules apply). */
export function hasSessionCookie(headers: Headers): boolean {
  const c = headers.get('cookie');
  return Boolean(c && (readCookie(c, SESSION_COOKIE) || readCookie(c, USER_SESSION_COOKIE)));
}

/** True when the request is authenticated by an Authorization header (not ambient cookies), so it is not CSRF-able. */
export function hasBearer(headers: Headers): boolean {
  const authz = headers.get('authorization');
  return Boolean(authz && /^bearer /i.test(authz));
}

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Same-origin check for state-changing requests that rely on ambient cookies.
 * Sec-Fetch-Site (sent by every current browser) must be `same-origin`; otherwise the Origin header
 * must match this host. With neither header the request is refused when `requirePresent` is set
 * (non-browser clients must use the Bearer token).
 */
export function checkSameOrigin(headers: Headers, opts: { requirePresent?: boolean } = {}): boolean {
  const site = headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = headers.get('origin');
  if (!origin) return !opts.requirePresent;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = new Set<string>();
  const host = headers.get('host');
  if (host) hosts.add(host.toLowerCase());
  if (process.env.TRUSTED_PROXY === 'true') {
    const fwd = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    if (fwd) hosts.add(fwd.toLowerCase());
  }
  for (const v of [process.env.APP_URL, process.env.PUBLIC_BASE_URL]) {
    try {
      if (v) hosts.add(new URL(v).host.toLowerCase());
    } catch { /* ignore malformed config */ }
  }
  return hosts.has(originHost.toLowerCase());
}

/** Headers for server-to-server calls to this app's own protected /api routes. */
export function internalAuthHeaders(): Record<string, string> {
  const token = process.env.ADMIN_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Demo-only routes (reset/simulate/mock-complete) are 404 unless DEMO_MODE=true, and NEVER in production (a leaked flag is inert). */
export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';
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
    // TRUSTED_PROXY_HOPS = how many proxies append to X-Forwarded-For in front of the app (default 1, e.g. Traefik).
    // Behind a CDN + Traefik set 2, so the client address (not the CDN's) is the key.
    const n = Math.max(1, Math.min(5, Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10) || 1));
    const ip = hops.length ? hops[Math.max(0, hops.length - n)] : real;
    if (ip) return ip.slice(0, 64);
  }
  return 'untrusted';
}
