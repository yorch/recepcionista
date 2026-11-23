# Authentication and authorization

Recepcionista has real per-tenant users on top of a break-glass admin token.

## Principals

| Principal | How it authenticates | Scope |
|---|---|---|
| **admin (break-glass)** | `Authorization: Bearer $ADMIN_TOKEN`, or the `rc_session` cookie from the "Use admin token" login (a server-side `admin_token` session, 12 h) | every business |
| **admin user** | a `users` row with role `admin` (no business), cookie `rc_user_session` | every business |
| **owner** | `users` row, role `owner`, tied to one `business_id` | their business only |
| **staff** | `users` row, role `staff`, tied to one `business_id` | their business only, read-mostly |

Every principal carries `email_verified`. It is always true for the break-glass paths; for a user it is `users.email_verified_at IS NOT NULL`. Routes that provision paid resources or touch billing must call `authenticate(req, { role, verifiedEmail: true })` or `requireVerifiedEmail(principal)` (src/lib/session.ts): they answer `403 email_not_verified`. Unverified users **can** sign in, see the dashboard and fix their address on `/dashboard/security`.

`ALLOW_INSECURE_DEV=true` (never honoured in production) with `ADMIN_TOKEN` unset makes every request an admin, except that a valid user cookie still resolves to that user. With neither, the app fails closed: every protected route answers 503. `ADMIN_TOKEN` is therefore required in production even if you only use per-user logins.

## Roles and permissions

Tenant users (owner/staff) only ever see their own business. A request for another business returns **404** (not 403), so existence is not leaked.

| Capability | staff | owner | admin |
|---|---|---|---|
| View dashboard, calls, bookings, briefings, knowledge base (read), settings values | yes | yes | all businesses |
| Mark/confirm things: send booking confirmation or gratitude text (`/api/sms/confirmation`, `/api/sms/gratitude`) | yes | yes | yes |
| Edit business details (`PATCH /api/businesses/:id`) | no | yes | yes |
| Edit knowledge base / agent prompt (`PUT .../knowledge`) | no | yes | yes |
| Privacy settings (`PATCH .../settings`), customer export / erase (`/api/privacy/*`) | no | yes | yes |
| Generate briefing, run gratitude sweep, create payment link, free-text SMS, payment-link SMS | no | yes | yes |
| View agent prompt (`/api/voice/agent-prompt`) | no | yes | yes |
| Dashboard "Settings" page | hidden/404 | yes | yes |
| Create business, provision (buys number, creates agent), website extraction, onboarding | no | no | yes (self-signup creates an owner + an empty business with `billing_status 'none'`; nothing is provisioned) |
| Create users with a password (`POST /api/admin/users`, `scripts/create-user.ts`; created already email-verified) | no | no | yes |
| Team page, invite / resend / revoke invitations, change role, disable / enable, remove, sign a member out (`/dashboard/team`, `/api/team/**`) | no | own business (invites need a **verified** email) | any business (`business_id`) |
| Activity log (`/dashboard/team/audit`, `GET /api/team/audit`) | no | own business | all, or one business |
| Own security page: 2FA, active sessions, email confirmation (`/dashboard/security`) | yes | yes | yes |
| Revoke all break-glass admin sessions (`POST /api/auth/revoke-admin-sessions`) | no | no | yes |
| Provisioning / billing routes that call `requireVerifiedEmail` | no | verified email only | yes |
| Demo console, `/api/demo/*` (also needs `DEMO_MODE=true`) | no | no | yes |
| Business switcher | no | no | yes |

### Route by route

Public (no session; each verifies its own secret/signature or is rate limited and enumeration-safe): `/api/health`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/signup`, `/api/auth/verify-email`, `/api/auth/resend-verification`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/accept-invite`, `/api/auth/mfa` (needs its own MFA-pending cookie), `/api/voice/webhook|post-call|incoming|tools/*`, `/api/payments/webhook`, `/api/sms/inbound`, `/api/sms/gratitude-reply`, `/api/pay/mock-complete` (404 unless `DEMO_MODE`), `/pay/*`, `/`, `/login`, `/login/mfa`, `/signup`, `/verify-email`, `/verify-email-sent`, `/forgot-password`, `/reset-password`, `/accept-invite`.

| Route | Min role | Tenant scoping |
|---|---|---|
| `GET /api/businesses` | staff | users get a list of only their own |
| `POST /api/businesses` | admin | n/a |
| `GET /api/businesses/:id` | staff | `requireBusinessAccess` |
| `PATCH /api/businesses/:id` | owner | `requireBusinessAccess` |
| `PUT /api/businesses/:id/knowledge` | owner | `requireBusinessAccess` |
| `POST /api/businesses/:id/provision` | admin | n/a |
| `GET /api/businesses/:id/settings` | staff | `requireBusinessAccess` |
| `PATCH /api/businesses/:id/settings` | owner | `requireBusinessAccess` |
| `GET /api/briefings` | staff | `business_id` forced to own |
| `POST /api/briefings/generate` | owner | `business_id` forced to own |
| `POST /api/extract` | admin | n/a |
| `POST /api/gratitude/run` | owner | owner pinned to own business; only admin may omit `business_id` (= all) |
| `POST /api/payments/create-link` | owner | `business_id` forced to own; booking must belong to it |
| `POST /api/sms/send` | owner | own business; recipient must be a known contact; `kind`/`consent_basis` are rejected (kind is `manual`) |
| `POST /api/sms/payment-link` | owner | own business; `booking_id` required, texts only that booking's number (no `to`/`description`) |
| `POST /api/admin/retention` | admin | retention purge now (`dry_run` defaults to true) |
| `POST /api/sms/confirmation`, `/api/sms/gratitude` | staff | booking's business checked |
| `GET /api/voice/agent-prompt` | owner | own business (admin: `?business_id=` or first) |
| `GET/POST /api/privacy/export`, `/erase` | owner | `business_id` forced to own |
| `POST /api/demo/reset`, `/api/demo/simulate-call`, `GET simulate-call` | admin | n/a |
| `POST /api/admin/users` | admin | n/a |
| `GET /api/auth/me`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/sessions/revoke-others` | staff | own sessions only (another user's session id is 404) |
| `POST /api/auth/2fa/enroll`, `/confirm`, `/disable`, `/recovery-codes` | staff (a personal account) | own account; enroll and disable re-check the password |
| `POST /api/auth/revoke-admin-sessions` | admin | all `admin_token` sessions |
| `GET /api/team` | owner | owner: own business (another id = 404); admin: `?business_id=` required |
| `POST /api/team/invite` | owner, **verified email** | same scoping; body `business_id` for admins |
| `POST /api/team/invites/:id/resend` (verified email), `DELETE /api/team/invites/:id` | owner | invitation must belong to the resolved business, else 404 |
| `PATCH /api/team/users/:id` (`role`, `disabled`), `DELETE /api/team/users/:id`, `POST /api/team/users/:id/revoke-sessions` | owner | target must be an owner/staff of the caller's business (other business or an admin account = 404); last active owner protected; no self-disable/remove |
| `GET /api/team/audit` | owner | owner: own business; admin: any business or all; cursor `before`, `limit` 1-100 |

Pages: `/dashboard/team`, `/dashboard/team/audit` are owner+ (staff get 404); `/dashboard/security` is for everyone. `/dashboard/*` use `getDashboardContext()` (validates the session in Node, resolves the business). `/dashboard/demo` is admin-only, `/dashboard/settings` owner+. `/onboarding` is admin-only (layout redirects tenants to `/dashboard`). Admins pick the business with the sidebar switcher, which sets the `rc_business` cookie (a UI preference: the server checks it against the real business list on every render and falls back to the first business).

## Where checks happen

- `src/proxy.ts` is only a **cheap gate**: it cannot reach Postgres. It lets a request through if it carries a valid admin Bearer or a *well-formed* (shape only) `rc_session` / `rc_user_session` cookie, and it refuses cross-site state-changing cookie requests. A forged but well-formed cookie passes the proxy and is rejected by the handler. It also forwards the request path to server components as `x-rc-pathname` (always overwritten, never trusted from the client).
- **Real validation is Node-side** (`src/lib/session.ts`): `authenticate(req, { role, verifiedEmail?, allowEnrollment? })` for route handlers (validates the credential against the database, enforces the minimum role, runs the CSRF check) and `getServerPrincipal()` / `getServerResolution()` / `getDashboardContext()` for server components. Every non-public handler calls one of these first; `guardAdmin(req)` is the admin-only shorthand. Nothing relies on the proxy alone.
- `requireBusinessAccess(principal, businessId)` throws a 404 for cross-tenant access; `scopeBusinessId(principal, requested?)` pins users to their business and passes admins through. Team routes use `authenticateTeam` (src/lib/team.ts): owners are pinned, admins must name the business.
- **MFA-pending sessions resolve to nothing** in `resolvePrincipal` (401 `mfa_required`): only `/api/auth/mfa`, `/login/mfa` and `POST /api/auth/logout` look at them.

## Sessions

All sessions are rows in `user_sessions`; the cookie holds a random 256-bit token and Postgres stores only its sha256 (a database leak yields no usable session). Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in production.

| Kind | Cookie | Lifetime | Notes |
|---|---|---|---|
| user | `rc_user_session` | 7 days (`last_used_at` refreshed at most every 5 min) | `mfa_verified_at` set once the second factor passed |
| user, MFA-pending | `rc_user_session` | **10 minutes** | password accepted, 2FA outstanding; confined (below) |
| `admin_token` (break-glass) | `rc_session` | **12 hours** | no user; listed, revoked and audited like the others |

- **Login** (`POST /api/auth/login`, `{email, password}`): per-IP limiter (60 / 5 min, fails closed with 503 if the limiter store is down) plus the per-(account, IP) backoff (see Threat notes). Unknown email, wrong password and disabled account all return the same `401 invalid credentials` after the same scrypt work (`verifyPasswordOrDummy`). A successful login replaces any session the browser still held, and calls `upgradePasswordHash` when the stored scrypt parameters are weaker than today's (sessions are **not** revoked by a rehash). Only known accounts get an `auth.login_failed` audit row, written after the response.
- **Second step** (`POST /api/auth/mfa`, `{code}` or `{recovery_code}`): accepts only an MFA-pending cookie. A TOTP code is checked with ±1 step drift and its 30 s step is claimed atomically (`claimTotpStep`): a code works once, even from another session. A recovery code is burnt atomically (`consumeRecoveryCode`). Failures use the same backoff machinery under separate keys (`auth/mfa:pair:...`), and **5 wrong codes destroy the pending session** (sign in again). Success deletes the pending session and issues a **new** session with `mfa_verified_at` set (no fixation).
- **Confinement**: a pending session gets 401 `mfa_required` from every API and redirects pages to `/login`; the only things it can do are `/api/auth/mfa`, `/login/mfa` and logout. Enabling 2FA signs out every other session of the user (an old non-2FA session can never skip the step), and any session that exists for a 2FA user without `mfa_verified_at` is treated as pending.
- **Logout** (`POST /api/auth/logout`) deletes the server-side session(s) and clears both cookies. Disabling a user (`setUserDisabled`), removing them, or changing/resetting a password (`changePassword`) deletes all of that user's sessions.
- **Security page / sessions API**: list your active sessions (device, IP, last use), sign out one (only your own: others' ids are 404) or all others.
- **Break-glass login** (`{token}`): the raw `ADMIN_TOKEN` is checked in constant time, then a random opaque token is issued and stored as an `admin_token` session (12 h). There is **no derived or signed admin cookie any more**, so rotating `ADMIN_TOKEN` no longer kills admin cookies by itself: call `POST /api/auth/revoke-admin-sessions` (Bearer `ADMIN_TOKEN`, an admin user, or the button on `/dashboard/security`) afterwards. `Authorization: Bearer ADMIN_TOKEN` keeps working for scripts and is CSRF-exempt. A bad Bearer never falls back to a cookie. Signing in as one kind clears the other kind's cookie and deletes its session.
- `REQUIRE_2FA_FOR_ADMINS=true` (default off): a DB admin user without 2FA gets 403 `2fa_enrollment_required` from every API except the 2FA/session endpoints, and pages redirect to `/dashboard/security?enroll=required`. They cannot disable 2FA again. It does not apply to the break-glass token (which has no mailbox or authenticator).

## Account lifecycle

All tokens (`email_tokens`) are random 256-bit values, stored only as sha256, **single use** (one atomic `UPDATE ... RETURNING`), and a newer token of the same kind supersedes older ones.

| Flow | Pages / endpoints | Token | Notes |
|---|---|---|---|
| Self-signup | `/signup`, `POST /api/auth/signup` `{email, password, business_name}` | `verify`, 24 h | Creates the business (`billing_status 'none'`, `status 'onboarding'`, nothing paid: no number, no agent, no Stripe) and an `owner` with `email_verified_at NULL`, mails the link, issues **no session**, then `/verify-email-sent`. Always the same `200`, whether or not the address has an account; an existing address gets a "someone tried to sign up" notice (at most 1 per hour). Strict validation (`src/lib/user-policy.ts`: 12-256 char password, no trivially guessable ones, not the email; business name 2-120 chars). |
| Email verification | `/verify-email?token=`, `POST /api/auth/verify-email` | `verify` | **GET only renders**; the button POSTs, so mail scanners that open links cannot burn the token. Does not sign anyone in (a link must not bypass a password/2FA); the page sends the user on to `/onboarding` (the login page if there is no session). |
| Resend verification | `POST /api/auth/resend-verification` | `verify` | Public with `{email}` (generic 200, per-IP and per-address limits, verified/unknown/disabled accounts get nothing); signed in without a body (shows `503 email_not_configured` if mail is broken). |
| Password reset | `/forgot-password`, `/reset-password?token=`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` | `reset`, **1 h** | Forgot: always the same 200 (disabled/unknown/throttled), mail sent after the response. Reset: password validated **before** the token is consumed (a typo does not burn it); `changePassword` revokes **every** session, other reset links are invalidated, the mailbox owner gets a "password changed" notice, audit `auth.password_reset`. Disabled users cannot reset. 2FA is not bypassed. |
| Invitations | `POST /api/team/invite`, `/accept-invite?token=`, `POST /api/auth/accept-invite` | `invite`, 7 d | The token is bound to **one business and role** (set by the inviter, never by the invitee). The inviter must be an owner of that business (or an admin) with a verified email. Accepting creates the user with the email already verified and signs them in. If the address **already has an account** (one account = one business) the page and API answer `409 account_exists` with a clear message and the invitation is **not** consumed. Inviting someone already on the team is a 409. |
| 2FA | `/dashboard/security`, `/api/auth/2fa/*` | n/a | See below. |

**Email delivery** (`src/lib/email`, `EMAIL_PROVIDER=resend|smtp|log`): `log` prints the link in development only and is refused in production. Public endpoints never reveal provider problems (generic answer; the failure is logged), except signup, which checks `emailConfigured()` **before creating anything** and answers a generic 503 (identical for every address). Admin-facing actions (invite, resend invite, resend verification when signed in) answer `503 email_not_configured` / `503 email_send_failed`, and a failed invitation leaves no live link behind.

### Abuse controls on signup

Per-IP limit (5 attempts / hour, ×20 without `TRUSTED_PROXY` where all clients share one key), per-address limit (3 / hour), a **honeypot** field (`company_website`: filled = fake success, nothing created), optional **Cloudflare Turnstile** (`TURNSTILE_SECRET_KEY` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY`; server-side siteverify with a 5 s timeout, **fails closed**), and a platform-wide cap `SIGNUP_MAX_PER_HOUR` (default 30, counted per attempt that passed the cheaper gates) so a botnet cannot mass-create businesses. All counters live in `rate_limit_buckets` (shared by all instances; the store failing closes the route).

### Two-factor authentication (TOTP)

- Enrol on `/dashboard/security`: the user re-enters their password (`POST /api/auth/2fa/enroll`), the server generates a secret, stores it **encrypted** (AES-256-GCM, `APP_SECRET_KEY`, bound to the user id) and returns the otpauth URI and a **server-rendered SVG QR code** (`qrcode`). A code from the app (`/confirm`) turns it on and returns **10 recovery codes shown once** (only hashes are stored). Turning it on signs out all other sessions.
- Disable (`/disable`) needs the password **and** a valid code or recovery code; regenerating recovery codes (`/recovery-codes`) needs an app code and voids the old set. Each change is audited and mailed to the user.
- Recovery codes are `xxxxx-xxxxx`, case/format tolerant, single use; using one is audited with the remaining count.
- Losing `APP_SECRET_KEY` makes every authenticator unusable (recovery codes still work through the second step, which only needs the hashes).

### Team management and audit

Owners (own business) and admins (any business, via the sidebar switcher which maps to `business_id`) can invite, resend, revoke, change role, disable/enable, remove and sign out members. **A business always keeps one active owner**: demoting, disabling or removing the last active owner is refused with `409 last_owner`, enforced under row locks so two owners cannot demote each other concurrently. You cannot disable or remove yourself. Admin accounts are not team members (404). Every mutation writes an audit row.

Audited actions (`audit_events`, never containing secrets or tokens; secret-looking meta keys are redacted): `auth.signup`, `auth.login`, `auth.login_password_ok`, `auth.login_failed` (known accounts), `auth.mfa_failed`, `auth.recovery_code_used`, `auth.logout`, `auth.email_verified`, `auth.password_reset_requested`, `auth.password_reset`, `auth.2fa_enroll_started`, `auth.2fa_enabled`, `auth.2fa_disabled`, `auth.recovery_codes_regenerated`, `auth.session_revoked`, `auth.sessions_revoked_others`, `auth.admin_login`, `auth.admin_sessions_revoked`, `user.create`, `user.invite`, `user.invite_resent`, `user.invite_revoked`, `user.invite_accepted`, `user.role_changed`, `user.disabled`, `user.enabled`, `user.removed`, `user.sessions_revoked`. Owners read their business's trail on `/dashboard/team/audit` (cursor pagination); admins read one business or all.

## CSRF

Cookie-authenticated `POST/PATCH/PUT/DELETE` requests must be same-origin: `Sec-Fetch-Site: same-origin`, or (older browsers) an `Origin` whose host equals `Host` (`X-Forwarded-Host` only with `TRUSTED_PROXY=true`; `APP_URL`/`PUBLIC_BASE_URL` hosts are also accepted). Requests with neither header are refused: scripts must use the Bearer token, which is exempt (it is not ambient). The check is enforced in the proxy and again in `authenticate()`. The public auth endpoints (login, signup, reset, MFA ...) run the same check themselves (header-less non-browser clients are allowed there: they carry no ambient credential). A bad Bearer never falls back to a cookie.

## First owner / first admin

```bash
# an owner for an existing business (password prompt, hidden, asked twice)
bun scripts/create-user.ts --email owner@acme.com --role owner --business biz_xxx

# non-interactive: password from the environment or stdin, NEVER from argv
CREATE_USER_PASSWORD='...' bun scripts/create-user.ts --email root@acme.com --role admin
printf '%s' "$PW" | bun scripts/create-user.ts --email staff@acme.com --role staff --business biz_xxx
```

Passwords must be 12-256 characters. Users created by the script or by `POST /api/admin/users` are created **email-verified** (the operator vouches for the address). In a deployed container run the script the same way as `db:seed` (the `tools` image). Normal customers sign up themselves at `/signup`; owners invite their staff from `/dashboard/team`.

## Break-glass admin token

`ADMIN_TOKEN` stays the superadmin credential: `Authorization: Bearer ...` for scripts and the "Use admin token" link on `/login` (which now creates a revocable 12 h server-side session). Keep it out of daily use. If it leaks: rotate it **and** call `POST /api/auth/revoke-admin-sessions` (existing admin sessions survive a rotation). Anyone holding it can act on every tenant.

## Threat notes and limits

- **Cross-tenant access**: every business-scoped handler resolves the business from the principal, not from the request. Cross-tenant ids return 404. `tests/auth-db.test.ts` and `tests/db/auth-team.test.ts` cover owner/staff/admin isolation against Postgres.
- **User enumeration**: login, signup, forgot-password and resend-verification answer identically (body and, as far as practical, timing: password hashing happens in both branches and mail is sent after the response) for known/unknown/disabled addresses. Residual leaks: the admin-only create-user route (`409 email already registered`); team invites tell an owner "already on the team" for their **own** business only; accepting an invitation for an address that has an account elsewhere says so to the holder of the invitation link. Signup/forgot throttling returns the same status for every address. Timing is equalised, not constant: DB writes on the new-account path are a few ms against ~100 ms of scrypt.
- **Login throttling** (`src/lib/login-throttle.ts`), with no bucket shared by all tenants: (1) a per-client-IP attempt cap (60 / 5 min, checked before any password hashing); (2) a per-(account, client-IP) failure backoff (3 free failures, then 15s, 30s, 1m ... capped at 15 min; failures only, a success clears it; the break-glass `ADMIN_TOKEN` has its own pair key; the second step and password re-entry for 2FA changes use their own/shared keys the same way); (3) a per-account failure counter across all addresses that only **logs** (`distributed_guessing`) and never blocks, because blocking on it would let anyone lock a real user out from a different IP. A distributed guesser is slowed per address, not stopped: use strong passwords and turn on 2FA. Per-IP keys need `TRUSTED_PROXY=true` (and `TRUSTED_PROXY_HOPS` behind a CDN); otherwise all clients share the `untrusted` key and the pair backoff uses a 20-failure allowance and a 60 s cap so it cannot become a long lockout.
- **2FA brute force**: 6-digit codes are guarded by the pair backoff, the 5-failures-per-pending-session cap and the 10-minute pending lifetime; each guess burns one password login first.
- **Email as a root of trust**: whoever controls the mailbox can reset the password (2FA still applies at login). Verification links never log anyone in. Link tokens appear in URLs: the pages set `Referrer-Policy: no-referrer` and `noindex`, and tokens are never logged or audited (the `log` provider prints links in development only).
- **Signup abuse**: see above. An attacker can still make us send one verification mail per allowed attempt to a victim's address (bounded by the per-address and per-IP limits and the hourly cap); an existing address receives at most one notice per hour.
- **XSS**: the session cookies are `HttpOnly`, so script cannot read them, but script running in the page can still make same-origin requests. The QR code SVG is generated server-side from our own URI and inserted as markup (it contains no attacker-controlled text beyond the account email, which is URL-encoded inside the QR payload, not in the SVG).
- **Unrevokable until expiry**: nothing signed is trusted any more. The only credentials that cannot be revoked server-side are the Bearer `ADMIN_TOKEN` (rotate it) and a browser's cached copy of a page already rendered.
- The public home page `/` renders no tenant data.
- Voice-tool and webhook routes are not user-authenticated (they use tool/webhook secrets); the agent-to-tenant binding is covered in `docs/review/05-adversarial-review.md` (H2).
