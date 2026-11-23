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

export type CspMode = 'strict' | 'moderate';

export interface CspOptions {
  nonce?: string;
  mode: CspMode;
  isDev?: boolean;
  /** Optional collector (CSP_REPORT_URI): adds `report-uri`. */
  reportUri?: string;
}

export function buildCsp(o: CspOptions): string {
  const dev = o.isDev ?? process.env.NODE_ENV !== 'production';
  const scripts = o.mode === 'strict' && o.nonce
    ? `script-src 'self' 'nonce-${o.nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`
    : `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`;
  const directives = [
    "default-src 'self'",
    scripts,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
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
  const strict = buildCsp({ nonce, mode: 'strict', isDev, reportUri });
  if (env.CSP_REPORT_ONLY === 'true') {
    // The strict policy stays on the REQUEST (see `enforced`) so Next stamps the nonce on its scripts; the enforced
    // response header is the nonce-less moderate one ('unsafe-inline' would be ignored if a nonce were present).
    const moderate = buildCsp({ mode: 'moderate', isDev, reportUri });
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
