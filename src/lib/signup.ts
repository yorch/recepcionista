/**
 * Self-service signup helpers: body parsing/validation (pure), optional Cloudflare Turnstile
 * verification, the global hourly cap, and account creation. Node runtime only.
 */
import { EmailTakenError, createBusiness, createUser, getUserByEmail, normalizeEmail, prisma } from '@/lib/db';
import { peekRateLimit, rateLimit } from '@/lib/ratelimit';
import { logger } from '@/lib/log';
import { validateBusinessName, validatePublicEmail, validateStrongPassword } from '@/lib/user-policy';
import type { User } from '@/lib/types';
export { signupAvailability, signupConfigWarning, turnstileFullyConfigured } from '@/lib/signup-config';
import { turnstileFullyConfigured } from '@/lib/signup-config';
export type { SignupAvailability } from '@/lib/signup-config';

const log = logger('signup');

/** Name of the bait field: a human never sees or fills it. */
export const HONEYPOT_FIELD = 'company_website';
export const TURNSTILE_FIELD = 'turnstile_token';
export const DEFAULT_SIGNUP_MAX_PER_HOUR = 60;
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

/** The Turnstile secret key is configured (the server COULD verify tokens). Whether it MUST is `captchaRequired`. */
export const turnstileEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean((env.TURNSTILE_SECRET_KEY ?? '').trim());

/**
 * Must this signup carry a verified Turnstile token? Only when BOTH halves are configured (secret + public site key): without the
 * site key the page shows no widget, so no client can produce a token and demanding one would fail every signup (e.g.
 * SIGNUP_ALLOW_WITHOUT_CAPTCHA=true next to a leftover secret). In production this is exactly `signupAvailability().captcha === 'turnstile'`.
 */
export const captchaRequired = (env: NodeJS.ProcessEnv = process.env): boolean => turnstileFullyConfigured(env);

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

/** SIGNUP_MAX_PER_HOUR: accounts the whole platform will create per hour (default 60, minimum 1). */
export function signupMaxPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.SIGNUP_MAX_PER_HOUR ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100_000) : DEFAULT_SIGNUP_MAX_PER_HOUR;
}

/** Fraction of the global cap after which signup degrades (tighter per-client limit; Turnstile is mandatory when configured). */
export const SIGNUP_SOFT_FRACTION = 0.7;
/** One client may account for at most this share of the global cap (reserved capacity for everybody else). */
export const SIGNUP_CLIENT_SHARE = 0.2;
/** Without a trusted proxy every client shares the 'untrusted' key; it is capped at this share instead. */
export const SIGNUP_UNTRUSTED_SHARE = 0.5;

const GLOBAL_CREATED_KEY = 'auth/signup:created:global';
const clientCreatedKey = (client: string) => `auth/signup:created:client:${client}`;

export type SignupGate =
  | { ok: true; level: 'normal' | 'degraded' }
  | { ok: false; reason: 'client_limit' | 'global_cap'; retryAfterS: number };

/**
 * Graceful degradation of the platform-wide signup cap (an attacker must not be able to switch signup off for everyone):
 *  - Only requests that CREATE an account are counted (`recordSignupCreated`, after success). Existing-address and
 *    honeypot requests never consume capacity.
 *  - A single client (its IP; the shared 'untrusted' key counts as one client) can create at most 20% of the cap per hour
 *    (50% for the shared key), so it is stopped by ITS OWN limit long before it can reach the global one.
 *  - Past 70% of the cap the platform is "degraded": a client that already created an account this hour gets no second one, and
 *    an alert is logged. Turnstile (when configured) is required on every signup, so a bot farm needs a solved challenge per account.
 *  - Only at 100% is signup refused for everyone (with a loud log line), until the sliding hour decays.
 */
export async function checkSignupCapacity(client: string, env: NodeJS.ProcessEnv = process.env): Promise<SignupGate> {
  const cap = signupMaxPerHour(env);
  const clientCap = Math.max(1, Math.floor(cap * (client === 'untrusted' ? SIGNUP_UNTRUSTED_SHARE : SIGNUP_CLIENT_SHARE)));
  const [global, mine] = await Promise.all([peekRateLimit(GLOBAL_CREATED_KEY, 60 * 60_000), peekRateLimit(clientCreatedKey(client), 60 * 60_000)]);
  if (mine >= clientCap) return { ok: false, reason: 'client_limit', retryAfterS: 600 };
  if (global >= cap) {
    if ((await rateLimit('auth/signup:alert:cap', 1, 10 * 60_000)).allowed) {
      log.error('signup.global_cap_reached', { cap, created_last_hour: Math.round(global), note: 'signups are refused for everyone until the hour decays; raise SIGNUP_MAX_PER_HOUR if this is real demand' });
    }
    return { ok: false, reason: 'global_cap', retryAfterS: 600 };
  }
  if (global >= cap * SIGNUP_SOFT_FRACTION) {
    if ((await rateLimit('auth/signup:alert:soft', 1, 10 * 60_000)).allowed) {
      log.warn('signup.degraded', { cap, created_last_hour: Math.round(global), turnstile: turnstileEnabled(env) });
    }
    if (mine >= 1) return { ok: false, reason: 'client_limit', retryAfterS: 600 };
    return { ok: true, level: 'degraded' };
  }
  return { ok: true, level: 'normal' };
}

/** Count one CREATED account against the global and per-client capacity. Never throws. */
export async function recordSignupCreated(client: string): Promise<void> {
  await rateLimit(GLOBAL_CREATED_KEY, 1_000_000, 60 * 60_000);
  await rateLimit(clientCreatedKey(client), 1_000_000, 60 * 60_000);
}

/** An unverified self-signup account older than this no longer reserves its email address (M4: no indefinite squatting). */
export const UNVERIFIED_ACCOUNT_TTL_MS = 24 * 60 * 60_000;

export interface CreatedSignup { user: User; businessId: string; replacedStale: boolean }

/**
 * If `email` belongs to a STALE, UNVERIFIED, pristine self-signup (an owner whose address nobody ever proved, older than
 * UNVERIFIED_ACCOUNT_TTL_MS, alone in a business that never bought or paid for anything), return that business id so it can
 * be replaced. A verified account, an invited/admin-created one, a disabled one or one with any provisioned resource is
 * never replaced.
 */
async function staleUnverifiedBusiness(email: string, now: Date): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { email: normalizeEmail(email) }, select: { role: true, emailVerifiedAt: true, disabledAt: true, createdAt: true, businessId: true } });
  if (!u || u.emailVerifiedAt || u.disabledAt || u.role !== 'owner' || !u.businessId) return null;
  if (now.getTime() - u.createdAt.getTime() < UNVERIFIED_ACCOUNT_TTL_MS) return null;
  const b = await prisma.business.findUnique({
    where: { id: u.businessId },
    select: { phone: true, agentId: true, stripeCustomerId: true, stripeSubscriptionId: true, billingStatus: true, _count: { select: { users: true } } },
  });
  if (!b || b._count.users !== 1 || b.phone || b.agentId || b.stripeCustomerId || b.stripeSubscriptionId || (b.billingStatus ?? 'none') !== 'none') return null;
  return u.businessId;
}

/**
 * Create the business (minimal fields, billing_status 'none', status 'onboarding') and its owner
 * (email unverified) in ONE transaction: a crash or a lost race for the address rolls the business back too,
 * so no orphan business can exist. Returns null when the email already has an account, EXCEPT that a stale
 * unverified self-signup holding the address is replaced (the real owner of the mailbox must not be locked out by a
 * squatter who never proved it); verified accounts are never replaced.
 * Nothing paid is provisioned here: that waits for a verified email and the billing flow.
 */
export async function createSignupAccount(
  input: { email: string; passwordHash: string; businessName: string; locale?: 'en' | 'es' }, now: Date = new Date(),
): Promise<CreatedSignup | null> {
  let replaceBusinessId: string | null = null;
  if (await getUserByEmail(input.email)) {
    replaceBusinessId = await staleUnverifiedBusiness(input.email, now);
    if (!replaceBusinessId) return null;
  }
  try {
    return await prisma.$transaction(async (tx) => {
      if (replaceBusinessId) {
        // Cascades to the squatter's user, sessions, tokens and TOTP state.
        const del = await tx.business.deleteMany({ where: { id: replaceBusinessId } });
        if (del.count !== 1) throw new EmailTakenError();
      }
      const business = await createBusiness({ name: input.businessName, ...(input.locale ? { locale_default: input.locale } : {}) }, tx);
      const user = await createUser({ email: input.email, password_hash: input.passwordHash, role: 'owner', business_id: business.id, email_verified: false, ...(input.locale ? { locale: input.locale } : {}) }, tx);
      return { user, businessId: business.id, replacedStale: replaceBusinessId !== null };
    });
  } catch (err) {
    if (err instanceof EmailTakenError) return null; // lost the race for the address: the transaction rolled back
    throw err;
  }
}
