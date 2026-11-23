/**
 * Self-service signup helpers: body parsing/validation (pure), optional Cloudflare Turnstile
 * verification, the global hourly cap, and account creation. Node runtime only.
 */
import { EmailTakenError, createBusiness, createUser, getUserByEmail, normalizeEmail, prisma } from '@/lib/db';
import { rateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/log';
import { validateBusinessName, validatePublicEmail, validateStrongPassword } from '@/lib/user-policy';
import type { User } from '@/lib/types';

const log = logger('signup');

/** Name of the bait field: a human never sees or fills it. */
export const HONEYPOT_FIELD = 'company_website';
export const TURNSTILE_FIELD = 'turnstile_token';
export const DEFAULT_SIGNUP_MAX_PER_HOUR = 30;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 5000;

export type SignupInput =
  | { ok: true; email: string; password: string; businessName: string; honeypot: boolean; turnstileToken: string | null }
  | { ok: false; error: string };

/** Pure: validate the JSON body of POST /api/auth/signup. Unknown keys are ignored. */
export function parseSignupBody(body: unknown): SignupInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const honeypot = typeof b[HONEYPOT_FIELD] === 'string' ? (b[HONEYPOT_FIELD] as string).trim() !== '' : b[HONEYPOT_FIELD] != null && b[HONEYPOT_FIELD] !== false;
  const turnstileToken = typeof b[TURNSTILE_FIELD] === 'string' && b[TURNSTILE_FIELD] ? (b[TURNSTILE_FIELD] as string).slice(0, 4096) : null;
  // A bot that filled the bait gets the generic success response without any validation feedback.
  if (honeypot) return { ok: true, email: '', password: '', businessName: '', honeypot: true, turnstileToken };
  const emailErr = validatePublicEmail(b.email);
  if (emailErr) return { ok: false, error: emailErr };
  const email = normalizeEmail(b.email as string);
  const name = validateBusinessName(b.business_name);
  if (!name.ok) return { ok: false, error: name.error };
  const pwErr = validateStrongPassword(b.password, email);
  if (pwErr) return { ok: false, error: pwErr };
  return { ok: true, email, password: b.password as string, businessName: name.value, honeypot: false, turnstileToken };
}

/** Cloudflare Turnstile is on when its secret key is configured. */
export const turnstileEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean((env.TURNSTILE_SECRET_KEY ?? '').trim());

/**
 * Server-side Turnstile check. Only called when enabled; FAILS CLOSED (missing token, network error,
 * timeout, non-success answer all return false).
 */
export async function verifyTurnstile(
  token: string | null,
  ip: string | null,
  deps: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  const secret = (env.TURNSTILE_SECRET_KEY ?? '').trim();
  if (!secret || !token) return false;
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set('remoteip', ip);
    const res = await (deps.fetchImpl ?? fetch)(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const json = (await res.json().catch(() => null)) as { success?: unknown } | null;
    return json?.success === true;
  } catch (err) {
    log.warn('turnstile_failed', { error: err instanceof Error ? err.name : 'unknown' });
    return false;
  }
}

/** SIGNUP_MAX_PER_HOUR (default 30, minimum 1). */
export function signupMaxPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.SIGNUP_MAX_PER_HOUR ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100_000) : DEFAULT_SIGNUP_MAX_PER_HOUR;
}

/** One slot of the platform-wide hourly signup cap. False = cap reached (or the limiter store is down: fail closed). */
export async function takeGlobalSignupSlot(): Promise<boolean> {
  const r = await rateLimit('auth/signup:global', signupMaxPerHour(), 60 * 60_000, { failClosed: true });
  return r.allowed;
}

/**
 * Create the business (minimal fields, billing_status 'none', status 'onboarding') and its owner
 * (email unverified) in ONE transaction: a crash or a lost race for the address rolls the business back too,
 * so no orphan business can exist. Returns null when the email already has an account.
 * Nothing paid is provisioned here: that waits for a verified email and the billing flow.
 */
export async function createSignupAccount(input: { email: string; passwordHash: string; businessName: string }): Promise<{ user: User; businessId: string } | null> {
  if (await getUserByEmail(input.email)) return null;
  try {
    return await prisma.$transaction(async (tx) => {
      const business = await createBusiness({ name: input.businessName }, tx);
      const user = await createUser({ email: input.email, password_hash: input.passwordHash, role: 'owner', business_id: business.id, email_verified: false }, tx);
      return { user, businessId: business.id };
    });
  } catch (err) {
    if (err instanceof EmailTakenError) return null; // lost the race for the address: the transaction rolled the business back
    throw err;
  }
}
