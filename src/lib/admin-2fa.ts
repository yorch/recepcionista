/** Admin 2FA policy (pure: read by session.ts, pages and the startup banner). */

/**
 * Must DB admin users enrol in 2FA before they can use anything else? ALWAYS in production (REQUIRE_2FA_FOR_ADMINS=false is ignored
 * there; `admin2faOptOutIgnored` feeds the startup warning). Outside production it is opt-in: REQUIRE_2FA_FOR_ADMINS=true.
 * Never applies to the break-glass ADMIN_TOKEN (no mailbox or authenticator).
 */
export const require2faForAdmins = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.NODE_ENV === 'production' || (env.REQUIRE_2FA_FOR_ADMINS ?? '').trim().toLowerCase() === 'true';

/** Production with REQUIRE_2FA_FOR_ADMINS=false: the opt-out is not honoured (startup warning). */
export const admin2faOptOutIgnored = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.NODE_ENV === 'production' && (env.REQUIRE_2FA_FOR_ADMINS ?? '').trim().toLowerCase() === 'false';
