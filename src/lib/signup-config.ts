/** Pure (no DB) signup availability rules: safe to import from instrumentation, pages and tests. */

import { configEnv } from '@/lib/config';
/** Both halves of the Turnstile pair (server secret + public site key) are configured. */
export const turnstileFullyConfigured = (env: NodeJS.ProcessEnv = configEnv()): boolean =>
  Boolean((env.TURNSTILE_SECRET_KEY ?? '').trim()) && Boolean((env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '').trim());

export type SignupAvailability =
  | { open: true; captcha: 'turnstile' | 'waived' | 'not_required' }
  | { open: false; reason: 'captcha_not_configured' };

/**
 * Is public self-signup allowed right now? In PRODUCTION open signup needs a captcha: both TURNSTILE_SECRET_KEY and
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY, or the explicit, loud opt-out SIGNUP_ALLOW_WITHOUT_CAPTCHA=true. Otherwise public signup
 * is refused (503 signup_disabled; /signup shows an invite-only notice). Invites are unaffected. Outside production signup stays open.
 */
export function signupAvailability(env: NodeJS.ProcessEnv = configEnv()): SignupAvailability {
  if (env.NODE_ENV !== 'production') return { open: true, captcha: 'not_required' };
  if (turnstileFullyConfigured(env)) return { open: true, captcha: 'turnstile' };
  if ((env.SIGNUP_ALLOW_WITHOUT_CAPTCHA ?? '').trim() === 'true') return { open: true, captcha: 'waived' };
  return { open: false, reason: 'captcha_not_configured' };
}

/** Operator-facing startup warning (null when nothing to say). */
export function signupConfigWarning(env: NodeJS.ProcessEnv = configEnv()): string | null {
  const a = signupAvailability(env);
  if (env.NODE_ENV !== 'production') return null;
  if (!a.open) return 'Public signup is DISABLED (invite-only): production needs TURNSTILE_SECRET_KEY + NEXT_PUBLIC_TURNSTILE_SITE_KEY, or SIGNUP_ALLOW_WITHOUT_CAPTCHA=true (not recommended).';
  if (a.captcha === 'waived') return '!!! SIGNUP_ALLOW_WITHOUT_CAPTCHA=true: open signup runs WITHOUT a captcha. Only rate limits and the platform cap protect it from bot farms. Configure Turnstile instead.';
  return null;
}
