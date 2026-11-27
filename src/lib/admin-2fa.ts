/** Admin 2FA policy (pure: read by session.ts, pages and the startup banner). */

import { configEnv } from '@/lib/config';
import { isConsoleActive } from '@/lib/admin/console-state';
/**
 * Must DB admin users enrol in 2FA before they can use anything else? ALWAYS in production (REQUIRE_2FA_FOR_ADMINS=false is ignored
 * there; `admin2faOptOutIgnored` feeds the startup warning). Outside production it is opt-in: REQUIRE_2FA_FOR_ADMINS=true, and it is forced ON in every
 * process that runs the settings console loader (the console is the most valuable account in the system).
 * Never applies to the break-glass ADMIN_TOKEN (no mailbox or authenticator).
 */
export const require2faForAdmins = (env: NodeJS.ProcessEnv = configEnv()): boolean =>
  env.NODE_ENV === 'production' || (env.REQUIRE_2FA_FOR_ADMINS ?? '').trim().toLowerCase() === 'true'
  // Invariant (24e T1, D10): whenever the console can write settings, an admin without 2FA is a takeover vector; the environment may only force it ON.
  || isConsoleActive();

/** Production with REQUIRE_2FA_FOR_ADMINS=false: the opt-out is not honoured (startup warning). */
export const admin2faOptOutIgnored = (env: NodeJS.ProcessEnv = configEnv()): boolean =>
  env.NODE_ENV === 'production' && (env.REQUIRE_2FA_FOR_ADMINS ?? '').trim().toLowerCase() === 'false';
