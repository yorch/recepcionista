/**
 * THE public origin of this deployment: one resolver for every consumer (Twilio signature URL and webhook addresses, ElevenLabs tool /
 * initiation / post-call URLs, Stripe return URLs and payment links, email links, Google OAuth redirect, sitemap / robots, the CSRF
 * same-origin allowlist, the WebAuthn default relying party, the CSP `upgrade-insecure-requests` decision).
 *
 * Precedence (documented in docs/env-vars.md): `APP_URL`, else `PUBLIC_BASE_URL`. `NEXT_PUBLIC_APP_URL` is NOT a source any more
 * (it was a third fallback in some readers and absent in others, so two origins could be in use at once); `baseUrlWarnings` flags a
 * deployment that still sets it, or sets the two real variables to different origins.
 *
 * Pure (no I/O, no imports): safe in the proxy bundle. Always pass `env` explicitly in tests.
 */

import { configEnv } from '@/lib/config';
export const DEFAULT_DEV_BASE_URL = 'http://localhost:3000';

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined): string => (v ?? '').trim().replace(/\/+$/, '');

/** The configured public base URL (`APP_URL || PUBLIC_BASE_URL`), trimmed, without trailing slashes; '' when neither is set. */
export function configuredBaseUrl(env: Env = configEnv()): string {
  return clean(env.APP_URL) || clean(env.PUBLIC_BASE_URL);
}

/** The configured base URL, else `http://localhost:3000` (for callers that must always produce something, e.g. dev links). */
export function baseUrlOrDev(env: Env = configEnv()): string {
  return configuredBaseUrl(env) || DEFAULT_DEV_BASE_URL;
}

/** The configured base URL when it is an http(s) URL, else null (webhook registration needs an absolute address). */
export function absoluteBaseUrl(env: Env = configEnv()): string | null {
  const base = configuredBaseUrl(env);
  return /^https?:\/\//i.test(base) ? base : null;
}

/** The origin (scheme + host + port) of the configured base URL, or null when unset / malformed. */
export function baseUrlOrigin(env: Env = configEnv()): string | null {
  const base = configuredBaseUrl(env);
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

/** The `host[:port]` of the configured base URL (lower case), or null. Used by the CSRF same-origin allowlist. */
export function baseUrlHost(env: Env = configEnv()): string | null {
  const base = configuredBaseUrl(env);
  if (!base) return null;
  try {
    return new URL(base).host.toLowerCase();
  } catch {
    return null;
  }
}

function originOf(v: string | undefined): string | null {
  const c = clean(v);
  if (!c) return null;
  try {
    return new URL(c).origin;
  } catch {
    return c;
  }
}

/** Configuration smells about the public origin (empty when fine). Shown once in the startup banner. */
export function baseUrlWarnings(env: Env = configEnv()): string[] {
  const out: string[] = [];
  const app = originOf(env.APP_URL);
  const pub = originOf(env.PUBLIC_BASE_URL);
  if (app && pub && app !== pub) {
    out.push(`APP_URL (${app}) and PUBLIC_BASE_URL (${pub}) differ: APP_URL wins everywhere (webhook URLs, signatures, CSRF, emails). Set both to the same origin or unset PUBLIC_BASE_URL.`);
  }
  const legacy = originOf(env.NEXT_PUBLIC_APP_URL);
  if (legacy) {
    const effective = baseUrlOrigin(env);
    out.push(
      effective && legacy !== effective
        ? `NEXT_PUBLIC_APP_URL (${legacy}) is IGNORED and differs from the effective public origin (${effective}); remove it.`
        : 'NEXT_PUBLIC_APP_URL is no longer read; use APP_URL (remove NEXT_PUBLIC_APP_URL).',
    );
  }
  return out;
}
