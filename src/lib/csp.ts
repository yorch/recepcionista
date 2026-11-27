/**
 * Content-Security-Policy builder (pure and Edge safe: used by src/proxy.ts and unit tests).
 * Design and rationale: docs/security-headers.md.
 *
 *  - strict   : script-src 'self' 'nonce-<n>' 'strict-dynamic' (no 'unsafe-inline' for scripts). Needs a fresh nonce
 *               per request, so every page is rendered dynamically (root layout awaits connection()).
 *  - moderate : script-src 'self' 'unsafe-inline'. The fallback that works without a nonce. It is ENFORCED while the
 *               strict policy is merely reported when CSP_REPORT_ONLY=true (the rollout / rollback switch).
 *
 * style-src keeps 'unsafe-inline' in both: React `style=""` attributes and runtime-injected <style> (sonner) cannot carry
 * a nonce, and inline CSS cannot execute script. Dev adds 'unsafe-eval' (React debugging) and ws: (HMR).
 */

import { configuredBaseUrl } from '@/lib/base-url';

export type CspMode = 'strict' | 'moderate';

export interface CspOptions {
  nonce?: string;
  mode: CspMode;
  isDev?: boolean;
  /** Optional collector (CSP_REPORT_URI): adds `report-uri`. */
  reportUri?: string;
  /**
   * Cloudflare Turnstile is configured: allow its script (api.js), its challenge iframe and its network calls from
   * challenges.cloudflare.com (as Cloudflare documents). Nothing else is opened up.
   */
  turnstile?: boolean;
  /** Emit `upgrade-insecure-requests`. Default: on in production (see upgradeInsecureEnabled for the env switch). */
  upgradeInsecure?: boolean;
}

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** Is the Turnstile widget enabled for this deployment? (site key = public, build time; secret = server.) */
export function turnstileConfigured(env: Record<string, string | undefined> = process.env): boolean {
  // The literal process.env.NEXT_PUBLIC_* read lets Next inline the build-time value into the proxy bundle.
  return Boolean((env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || env.TURNSTILE_SECRET_KEY || '').trim());
}

/**
 * Should the policy carry `upgrade-insecure-requests`? It makes the browser rewrite every http:// subresource to https://,
 * which BREAKS a plain-HTTP deployment (a staging box on `http://host:3000` logs ERR_SSL_PROTOCOL_ERROR for every asset).
 * CSP_UPGRADE_INSECURE=true|false forces it; unset/auto = on only in production AND when the public origin
 * (src/lib/base-url.ts: APP_URL, else PUBLIC_BASE_URL) is https. Never in development.
 */
export function upgradeInsecureEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV !== 'production') return false;
  const v = (env.CSP_UPGRADE_INSECURE ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return configuredBaseUrl(env).toLowerCase().startsWith('https://');
}

export function buildCsp(o: CspOptions): string {
  const dev = o.isDev ?? process.env.NODE_ENV !== 'production';
  const ts = o.turnstile ? ` ${TURNSTILE_ORIGIN}` : '';
  // strict-dynamic makes browsers ignore the host source (the nonced loader may add api.js); it stays for browsers that do not.
  const scripts = o.mode === 'strict' && o.nonce
    ? `script-src 'self' 'nonce-${o.nonce}' 'strict-dynamic'${ts}${dev ? " 'unsafe-eval'" : ''}`
    : `script-src 'self' 'unsafe-inline'${ts}${dev ? " 'unsafe-eval'" : ''}`;
  const directives = [
    "default-src 'self'",
    scripts,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${ts}${dev ? ' ws: wss:' : ''}`,
    ...(o.turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...((o.upgradeInsecure ?? !dev) ? ['upgrade-insecure-requests'] : []),
    ...(o.reportUri ? [`report-uri ${o.reportUri}`] : []),
  ];
  return directives.join('; ');
}

/** CSP for JSON/API responses (nothing to load at all). */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

export interface CspHeaders {
  /** Header name/value pairs to put on the response. */
  response: Array<[string, string]>;
  /** The enforced policy: forwarded on the REQUEST so Next.js extracts the nonce from it while rendering. */
  enforced: string;
}

/** Headers for a page response. `reportOnly` (CSP_REPORT_ONLY=true): enforce `moderate`, report violations of `strict`. */
export function cspHeadersFor(nonce: string, env: NodeJS.ProcessEnv = process.env): CspHeaders {
  const reportUri = env.CSP_REPORT_URI?.trim() || undefined;
  const isDev = env.NODE_ENV !== 'production';
  const turnstile = turnstileConfigured(env);
  const upgradeInsecure = upgradeInsecureEnabled(env);
  const strict = buildCsp({ nonce, mode: 'strict', isDev, reportUri, turnstile, upgradeInsecure });
  if (env.CSP_REPORT_ONLY === 'true') {
    // The strict policy stays on the REQUEST (see `enforced`) so Next stamps the nonce on its scripts; the enforced
    // response header is the nonce-less moderate one ('unsafe-inline' would be ignored if a nonce were present).
    const moderate = buildCsp({ mode: 'moderate', isDev, reportUri, turnstile, upgradeInsecure });
    return { response: [['Content-Security-Policy', moderate], ['Content-Security-Policy-Report-Only', strict]], enforced: strict };
  }
  return { response: [['Content-Security-Policy', strict]], enforced: strict };
}

/** A fresh per-request nonce (128 bits, base64). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
