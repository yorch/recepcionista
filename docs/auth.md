# Authentication and authorization

Recepcionista has real per-tenant users on top of a break-glass admin token.

## Principals

| Principal | How it authenticates | Scope |
|---|---|---|
| **admin (break-glass)** | `Authorization: Bearer $ADMIN_TOKEN`, or the `rc_session` cookie from the "Use admin token" login (a server-side `admin_token` session, 12 h) | every business |
| **admin user** | a `users` row with role `admin` (no business), cookie `rc_user_session` | every business |
| **owner** | `users` row + an **owner membership** (`memberships`) in a business | the businesses it has an enabled membership in, one **active** at a time |
| **staff** | `users` row + a **staff membership** in a business | same, read-mostly in that business |

**Roles come from memberships, not from the account.** One account (one email, one password, one set of passkeys) can belong to several businesses with a different role in each: owner in the Miami location, staff in the Tampa one. `memberships (user_id, business_id, role, disabled_at)` is the source of truth; `users.business_id` / `users.role` are only the legacy *primary* business (kept in step by a database trigger and by `setMembershipRole` / `removeMembership`) and are never used for authorization. A session works in exactly one business at a time: `user_sessions.active_business_id`, validated on **every request** against the account's enabled memberships (`resolvePrincipal` -> `pickActiveMembership`: the active business while its membership is enabled, else the primary, else the oldest enabled one). The principal carries `business_id` (active), `role` (the membership's role there) and `memberships` (all enabled ones). An account with no enabled membership (disabled everywhere) cannot sign in and resolves to nothing.

### Switching businesses

`POST /api/auth/switch-business {business_id}` (cookie session, CSRF-checked, 60 per 10 min) points **this session** at another business. The membership is verified inside the very `UPDATE` that stores the choice (`setSessionActiveBusiness`): a business the account does not belong to, a disabled membership and a nonexistent id are the same `404` and nothing changes. Only the caller's own session row changes (their other devices stay where they were), and a new login never inherits an old session's active business. The change is audited (`auth.business_switched`). The business switcher in the dashboard sidebar (accounts with 2+ memberships; admins keep the admin switcher) calls it and re-renders. A business the account also belongs to but is **not active in is a 404 on every business-scoped route** until it switches: `requireBusinessAccess` / `scopeBusinessId` compare with the active business only, so the role a route checked (the role in the active business) can never be applied to another business. An owner of A and staff of B who sends `?business_id=B` while active in A gets 404, not staff access and not owner access.

Every principal carries `email_verified`. It is always true for the break-glass paths; for a user it is `users.email_verified_at IS NOT NULL`. Routes that provision paid resources or touch billing must call `authenticate(req, { role, verifiedEmail: true })` or `requireVerifiedEmail(principal)` (src/lib/session.ts): they answer `403 email_not_verified`. Unverified users **can** sign in, see the dashboard and fix their address on `/dashboard/security`.

`ALLOW_INSECURE_DEV=true` (never honoured in production) with `ADMIN_TOKEN` unset makes every request an admin, except that a valid user cookie still resolves to that user. With neither, the app fails closed: every protected route answers 503. `ADMIN_TOKEN` is therefore required in production even if you only use per-user logins.

## Roles and permissions

Tenant users (owner/staff) only ever see their **active** business (the roles below are the membership's role in it). A request for another business returns **404** (not 403), so existence is not leaked, even for a business the same account belongs to.

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
| Own security page: passkeys, 2FA, active sessions, email confirmation (`/dashboard/security`) | yes | yes | yes |
| Business switcher (own memberships), `POST /api/auth/switch-business` | yes (2+ memberships) | yes | n/a (admins use the admin switcher) |
| Add another location (`POST /api/businesses/mine`) | no | yes, **verified email**; must own at least one business | no |
| Revoke all break-glass admin sessions (`POST /api/auth/revoke-admin-sessions`) | no | no | yes |
| Provisioning / billing routes that call `requireVerifiedEmail` | no | verified email only | yes |
| Demo console, `/api/demo/*` (also needs `DEMO_MODE=true`) | no | no | yes |
| Admin business switcher (`rc_business` cookie) | no | no | yes |

### Route by route

Public (no session; each verifies its own secret/signature or is rate limited and enumeration-safe): `/api/health`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/signup`, `/api/auth/verify-email`, `/api/auth/resend-verification`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/accept-invite`, `/api/auth/mfa` (needs its own MFA-pending cookie), `/api/auth/passkeys/login/options` and `/api/auth/passkeys/login/verify` (passwordless sign-in: origin check, per-client limits and the signed assertion are the authentication), `/api/voice/webhook|post-call|incoming|tools/*`, `/api/payments/webhook`, `/api/sms/inbound`, `/api/sms/gratitude-reply`, `/api/pay/mock-complete` (404 unless `DEMO_MODE`), `/pay/*`, `/`, `/login`, `/login/mfa`, `/signup`, `/verify-email`, `/verify-email-sent`, `/forgot-password`, `/reset-password`, `/accept-invite`.

| Route | Min role | Tenant scoping |
|---|---|---|
| `GET /api/businesses` | staff | users get the businesses of their enabled memberships (the active one is `business_id` of `/api/auth/me`) |
| `POST /api/businesses/mine` | staff session whose account **owns** a business; **verified email** | creates an extra business for the caller (owner membership, billing `none`, session moves to it); per-account cap `MAX_BUSINESSES_PER_USER` (default 10, `409 limit_reached`); 5 per hour per account; staff-only accounts 403 `not_owner`; admins 403 |
| `POST /api/auth/switch-business` | staff (user session) | membership verified in the same UPDATE; others 404; admins/Bearer 403 |
| `GET /api/auth/passkeys` | staff (personal account) | own passkeys only |
| `POST /api/auth/passkeys/register/options`, `/register/verify` | staff (personal account); options needs a **recent** auth | own account; challenge bound to the account; max 20 |
| `POST /api/auth/passkeys/reauth/options`, `/reauth/verify` | staff (personal account) | the credential must belong to the caller |
| `PATCH /api/auth/passkeys/:id`, `DELETE /api/auth/passkeys/:id` | staff (personal account); delete needs a **recent** auth | own passkeys only (another account's id = 404) |
| `POST /api/businesses` | admin | n/a |
| `GET /api/businesses/:id` | staff | `requireBusinessAccess` |
| `PATCH /api/businesses/:id` | owner | `requireBusinessAccess` |
| `PUT /api/businesses/:id/knowledge` | owner | `requireBusinessAccess` |
| `POST /api/businesses/:id/provision` | admin | n/a |
| `GET /api/businesses/:id/settings` | staff | `requireBusinessAccess` |
| `PATCH /api/businesses/:id/settings` | owner | `requireBusinessAccess` |
| `GET /api/briefings` | staff | `business_id` forced to the active business |
| `POST /api/briefings/generate` | owner | `business_id` forced to the active business |
| `POST /api/extract` | admin | n/a |
| `POST /api/gratitude/run` | owner | owner pinned to own business; only admin may omit `business_id` (= all) |
| `POST /api/payments/create-link` | owner | `business_id` forced to own; booking must belong to it |
| `POST /api/sms/send` | owner | own business; recipient must be a known contact; `kind`/`consent_basis` are rejected (kind is `manual`) |
| `POST /api/sms/payment-link` | owner | own business; `booking_id` required, texts only that booking's number (no `to`/`description`) |
| `POST /api/admin/retention` | admin | retention purge now (`dry_run` defaults to true) |
| `POST /api/admin/release-tenant` | admin | release ONE canceled/unpaid tenant's Twilio number + ElevenLabs agent (`dry_run` defaults to true; docs/billing.md) |
| `POST /api/sms/confirmation`, `/api/sms/gratitude` | staff | booking's business checked |
| `GET /api/voice/agent-prompt` | owner | own business (admin: `?business_id=` or first) |
| `GET/POST /api/privacy/export`, `/erase` | owner | `business_id` forced to own |
| `POST /api/demo/reset`, `/api/demo/simulate-call`, `GET simulate-call` | admin | n/a |
| `POST /api/admin/users` | admin | n/a |
| `POST /api/admin/repair-numbers` | admin (Bearer or admin session); rate limited 6/min | idempotent repair of the Twilio SMS/Voice webhooks of tenant numbers; `dry_run` defaults to true; audited `admin.repair_numbers` (docs/runbook.md section 1 step 5) |
| `POST /api/admin/resync-agents` | admin (Bearer or admin session); rate limited 6/min | all businesses that have an agent; `dry_run` defaults to true; audited `admin.resync_agents` (docs/runbook.md section 11) |
| `POST /api/integrations/google/mock-event` | owner; 404 unless `GOOGLE_OAUTH_MOCK=true` outside production | the caller's own business only (admins pass `?business_id=`); local / e2e only |
| `POST /api/sms/inbound` (bare `C` reply) | Twilio signature (no session) | the business that OWNS the number texted; only the sender's own bookings (E.164 match); STOP-class keywords first |
| `GET /api/auth/me`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/sessions/revoke-others` | staff | own sessions only (another user's session id is 404) |
| `POST /api/auth/2fa/enroll`, `/confirm`, `/disable`, `/recovery-codes` | staff (a personal account) | own account; enroll and disable re-check the password |
| `POST /api/auth/revoke-admin-sessions` | admin | all `admin_token` sessions |
| `GET /api/team` | owner (in the active business) | owner: the active business (another id = 404); admin: `?business_id=` required |
| `POST /api/team/invite` | owner, **verified email** | same scoping; body `business_id` for admins |
| `POST /api/team/invites/:id/resend` (verified email), `DELETE /api/team/invites/:id` | owner | invitation must belong to the resolved business, else 404 |
| `PATCH /api/team/users/:id` (`role`, `disabled`), `DELETE /api/team/users/:id`, `POST /api/team/users/:id/revoke-sessions` | owner | target must have a membership in the caller's active business (another business or an admin account = 404); all three act on **that membership only** (the account and its other businesses survive; `DELETE` deletes the account only when it was the last membership); last active owner protected; no self-disable/remove. `revoke-sessions` by an owner signs the person out of THIS business only: the sessions working in it are deleted, and every other session of theirs gets this business added to its `user_sessions.revoked_business_ids` list (one UPDATE, idempotent), so it can neither act in nor switch back to it: `resolvePrincipal` drops revoked businesses from the session's memberships and `setSessionActiveBusiness` refuses them (404), even if the membership is enabled. The same list is written when a membership is **disabled** or **removed** (re-enabling it does not revive sessions that already lost it), and cleared again only by a fresh grant (an invitation accepted: `addMembership`) or by signing in again (a new session starts empty). A platform admin signs the whole account out everywhere. Admins name `?business_id=` when the user is in several businesses (else 422) |
| `GET /api/team/audit` | owner | owner: own business; admin: any business or all; cursor `before`, `limit` 1-100 |

### Routes added by the features work (authorization at a glance)

All `Min role` rows use the same `authenticate(req, { role })` gate as above (cookie requests are also CSRF-checked); "step-up" = `requireRecentAuth` (403 `reauth_required`, then password / TOTP / passkey at `/api/auth/reauth`). Tenant scope = the caller's active business (admins pass `business_id`); another business's id is 404.

| Route | Min role | Notes |
|---|---|---|
| `GET /api/bookings`, `GET /api/bookings/:id` | staff | calendar range / agenda; own business |
| `PATCH /api/bookings/:id`, `POST /api/bookings/:id/{reschedule,notify,resend-confirmation}`, `GET /api/bookings/:id/slots` | owner | own business; reschedule re-validates hours, closed dates, overlap and Google busy time under the booking lock |
| `POST /api/bookings/:id/refund` | owner + step-up | amount <= the paid deposit; an out-of-policy refund needs `override:true` and is audited |
| `GET/PUT /api/businesses/:id/refund-policy`, `GET/PUT /api/businesses/:id/voice`, `GET .../voice/preview` | GET staff, PUT owner | voice list from the operator allowlist / provider; audited |
| `GET/PATCH /api/businesses/:id/call-mode`, `PUT/DELETE .../forward-number`, `POST .../forward-number/verify/{start,confirm}` | owner (GET staff) + step-up for changes | email + text notice on change |
| `POST .../owner-phone/verify/{start,confirm}` | owner, verified email | per-account / per-business / global SMS limits |
| `GET /api/businesses/:id/kb-changes`, `POST .../kb-changes/:changeId` | owner | apply / reject / undo of owner call-in proposals; hours, closed dates and service area are real fields |
| `GET /api/businesses/:id/onboarding-status`, `PUT .../onboarding-status/knowledge` | owner | readiness gate for non-admins |
| `GET /api/calls`, `GET /api/calls/:id/{transcript,live,audio,voicemail}` | staff | tenant scoped; owner-line calls never listed; transcript / audio only for `consent_status = 'disclosed'`; SSE limited per user and business |
| `GET /api/integrations/google/{status,busy}` | staff | times only, never titles |
| `POST /api/integrations/google/connect`, `PATCH .../calendar`, `GET .../calendars`, `DELETE .../disconnect`, `GET .../callback` | owner | callback verifies a signed, expiring, session-bound state; `block_on_busy` is `calendar_connections.block_on_busy` |
| `POST /api/integrations/google/webhook` | none (Google) | `X-Goog-Channel-Token` HMAC + channel id match; the body is ignored, it only triggers a sync |
| `POST /api/integrations/google/mock-event` | owner | 404 unless `GOOGLE_OAUTH_MOCK=true` outside production |
| `POST /api/admin/resync-agents`, `POST /api/admin/jobs/run`, `GET /api/admin/jobs`, `POST /api/admin/billing` | admin | dry-run defaults; audited |
| `GET /api/billing/status`, `POST /api/billing/{checkout,portal}` | staff / owner | status exposes `usage_warnings` (80% / 100% cap warnings), `billing_interval`, `annual_available` |
| `POST /api/billing/webhook`, `POST /api/payments/webhook` | Stripe signature | replay-protected by `claimEvent` |
| `POST /api/voice/{initiation,tools/:tool,transcript-event}` | shared tool secret (`x-recepcionista-tool-secret`) | tenant re-derived from agent id / call keys; owner tools only on `kind = 'owner'` calls |
| `POST /api/voice/post-call` | ElevenLabs HMAC signature | idempotent per conversation |
| `POST /api/voice/{incoming,screen,dial-status,voicemail}`, `POST /api/sms/inbound` | Twilio signature | business resolved from the number texted / called |

Pages: `/dashboard/team`, `/dashboard/team/audit` are owner+ (staff get 404); `/dashboard/security` is for everyone. `/dashboard/*` use `getDashboardContext()` (validates the session in Node, resolves the business). `/dashboard/demo` is admin-only, `/dashboard/settings` owner+. `/onboarding` is admin-only unless the account is an owner finishing setup of its active business (layout redirects others to `/dashboard`). Admins pick the business with the sidebar switcher, which sets the `rc_business` cookie (a UI preference: the server checks it against the real business list on every render and falls back to the first business).

## Where checks happen

- `src/proxy.ts` is only a **cheap gate**: it cannot reach Postgres. It lets a request through if it carries a valid admin Bearer or a *well-formed* (shape only) `rc_session` / `rc_user_session` cookie, and it refuses cross-site state-changing cookie requests. A forged but well-formed cookie passes the proxy and is rejected by the handler. It also forwards the request path to server components as `x-rc-pathname` (always overwritten, never trusted from the client).
- **Real validation is Node-side** (`src/lib/session.ts`): `authenticate(req, { role, verifiedEmail?, allowEnrollment? })` for route handlers (validates the credential against the database, enforces the minimum role, runs the CSRF check) and `getServerPrincipal()` / `getServerResolution()` / `getDashboardContext()` for server components. Every non-public handler calls one of these first; `guardAdmin(req)` is the admin-only shorthand. Nothing relies on the proxy alone.
- `requireBusinessAccess(principal, businessId)` throws a 404 for cross-tenant access; `scopeBusinessId(principal, requested?)` pins users to their **active** business and passes admins through. Team routes use `authenticateTeam` (src/lib/team.ts): owners are pinned, admins must name the business.
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
- **Logout** (`POST /api/auth/logout`) deletes the server-side session(s) and clears both cookies. Disabling a user (`setUserDisabled`), removing them, changing/resetting a password (`changePassword`), **changing their role** (the caller's own session survives a self-service change) and **turning 2FA off** (`disableTotp`, in the same transaction; only the caller's already-verified session survives) delete the user's sessions **including MFA-pending ones**, so a pending session can never turn into a full session because the second factor went away.
- **Passwordless login** (`POST /api/auth/passkeys/login/verify`, below) creates a session exactly like a password login (previous session replaced, per-client caps and failure backoff), already `mfa_verified_at` set.
- **Security page / sessions API**: list your active sessions (device, IP, last use), sign out one (only your own: others' ids are 404) or all others.
- **Break-glass login** (`{token}`): the raw `ADMIN_TOKEN` is checked in constant time, then a random opaque token is issued and stored as an `admin_token` session (12 h). There is **no derived or signed admin cookie any more**, so rotating `ADMIN_TOKEN` no longer kills admin cookies by itself: call `POST /api/auth/revoke-admin-sessions` (Bearer `ADMIN_TOKEN`, an admin user, or the button on `/dashboard/security`) afterwards. `Authorization: Bearer ADMIN_TOKEN` keeps working for scripts and is CSRF-exempt. A bad Bearer never falls back to a cookie. Signing in as one kind clears the other kind's cookie and deletes its session.
- `REQUIRE_2FA_FOR_ADMINS=true` (default off): a DB admin user without 2FA gets 403 `2fa_enrollment_required` from every API except the 2FA/session endpoints, and pages redirect to `/dashboard/security?enroll=required`. They cannot disable 2FA again. It does not apply to the break-glass token (which has no mailbox or authenticator).

### Recent authentication ("sudo") for sensitive changes

Changing how the business line is answered is the one action that can redirect every customer call, so a stolen cookie must not be enough. `user_sessions.sudo_at` (migration `20261129120000_review5_session_sudo`) is set when a session is created (login, second factor, invite, reset: all fresh proofs) and by `POST /api/auth/reauth {password}` (or `{code}` for an account with 2FA; replay-guarded TOTP, no recovery codes), which stamps the CALLER'S OWN session only. `requireRecentAuth` (src/lib/session.ts) answers `403 {code:'reauth_required'}` unless `sudo_at` is within 5 minutes. It is required to switch INTO paused or forward, to change "forward during business hours" (round 6 L2: any change of the flag, even with the mode re-sent), to start or confirm a forwarding-number verification and to adopt the owner phone; not to switch back to AI or to remove the number. Reauth is limited to 8 attempts per user per 15 minutes (fails closed), audited (`auth.reauth`, `auth.reauth_failed`) and the dashboard asks inline and retries. What proves it (round 6): a user or DB admin **without 2FA** sends `{password}`; an account **with 2FA must send `{code}`** (the TOTP code, replay-guarded, no recovery codes; the password alone is refused with 422 `totp_required`, so a stolen cookie plus a reused password is not enough; the code alone is enough); the **break-glass admin cookie session** (`rc_session`, 12 h, ambient like any cookie) sends `{admin_token}` (L1: it is no longer exempt), rate limited per session and audited with actor kind `admin_token`. Only credentials that are not ambient skip the step-up: `Authorization: Bearer ADMIN_TOKEN` (sent on purpose with every request; its changes are audited as `admin_token` with `actor_role`/`actor_via` in meta) and `ALLOW_INSECURE_DEV` (impossible in production). Audit actor (L4): a DB admin user is `actor_kind: 'user'` with the user id and `actor_role: 'admin'`, `actor_via: 'user'` in meta, never `admin_token`. Note: a wrong code sent to reauth counts towards the account's 2FA lock (`mfa.ts`), as at login, so whoever holds a stolen session can lock the real owner's 2FA login; that is accepted (the lock protects the second factor) and the owner recovers through the normal 2FA recovery. Every change is then announced by email to all owners and by text to the verified owner phone (docs/runbook.md section 8).

## Account lifecycle

All tokens (`email_tokens`) are random 256-bit values, stored only as sha256, **single use** (one atomic `UPDATE ... RETURNING`), and a newer token of the same kind supersedes older ones.

| Flow | Pages / endpoints | Token | Notes |
|---|---|---|---|
| Self-signup | `/signup`, `POST /api/auth/signup` `{email, password, business_name}` | `verify`, 24 h | Creates the business (`billing_status 'none'`, `status 'onboarding'`, nothing paid: no number, no agent, no Stripe) and an `owner` with `email_verified_at NULL`, mails the link, issues **no session**, then `/verify-email-sent`. Always the same `200`, whether or not the address has an account; an existing address gets a "someone tried to sign up" notice (at most 1 per hour). Strict validation (`src/lib/user-policy.ts`: 12-256 char password, no trivially guessable ones, not the email; business name 2-120 chars). |
| Email verification | `/verify-email?token=`, `POST /api/auth/verify-email` | `verify` | **GET only renders**; the button POSTs, so mail scanners that open links cannot burn the token. Does not sign anyone in (a link must not bypass a password/2FA); the page sends the user on to `/onboarding` (the login page if there is no session). |
| Resend verification | `POST /api/auth/resend-verification` | `verify` | Public with `{email}` (generic 200, per-IP and per-address limits, verified/unknown/disabled accounts get nothing); signed in without a body (shows `503 email_not_configured` if mail is broken). |
| Password reset | `/forgot-password`, `/reset-password?token=`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` | `reset`, **1 h** | Forgot: always the same 200 (disabled/unknown/throttled), mail sent after the response. Reset: password validated **before** the token is consumed (a typo does not burn it); `changePassword` revokes **every** session, other reset links are invalidated, the mailbox owner gets a "password changed" notice, audit `auth.password_reset`. Disabled users cannot reset. 2FA is not bypassed. |
| Invitations | `POST /api/team/invite`, `/accept-invite?token=`, `POST /api/auth/accept-invite` | `invite`, 7 d | The token is bound to **one business, one role and one email** (set by the inviter, never by the invitee). The inviter must be an owner of that business (or an admin) with a verified email. **New address:** accepting creates the account (email already verified, the link proved the mailbox) with that membership and signs it in. **Address that already has an account:** it is invited **into the other business with the same account** (no `ACCOUNT_EXISTS` refusal). The page asks a logged-out person to sign in first (`/login?next=/accept-invite?token=...`); a signed-in account whose email equals the invited address accepts with one click (`POST /api/auth/accept-invite {token}`, cookie session, CSRF-checked): the token is consumed together with the membership in one transaction (`acceptInviteForExistingUser`), the invited role is applied, the link proves the mailbox (`markEmailVerified`), and the session switches to the new business. A different signed-in account gets `403 wrong_account`, an anonymous caller `401 login_required` (also when a password is sent: nobody can take over an existing account's invitation with a password) and **nothing is consumed**; replays, expired and revoked links are `400`; an account that already has an enabled membership there gets `409 already_member` without consuming the link (a stale link can never change a role). Inviting a current, enabled member is a 409; a person whose membership was disabled can be re-invited. Accepting as a new account is atomic: consuming the token and creating the user are ONE transaction, so an account created for that address in the race window rolls the consumption back (`409 account_exists`, link still valid). Invited admin accounts cannot accept (admins have no memberships). |
| 2FA | `/dashboard/security`, `/api/auth/2fa/*` | n/a | See below. |

**Email delivery** (`src/lib/email`, `EMAIL_PROVIDER=resend|smtp|log`): `log` prints the link in development only and is refused in production. Public endpoints never reveal provider problems (generic answer; the failure is logged), except signup, which checks `emailConfigured()` **before creating anything** and answers a generic 503 (identical for every address). Admin-facing actions (invite, resend invite, resend verification when signed in) answer `503 email_not_configured` / `503 email_send_failed`, and a failed invitation leaves no live link behind.

### Abuse controls on signup

**Captcha is mandatory in production.** When `NODE_ENV=production`, public signup is only open if `TURNSTILE_SECRET_KEY` **and** `NEXT_PUBLIC_TURNSTILE_SITE_KEY` are both set, or the operator opted out explicitly with `SIGNUP_ALLOW_WITHOUT_CAPTCHA=true` (startup logs `signup.without_captcha` as a warning; deploy.sh prints a banner). Otherwise `POST /api/auth/signup` answers `503 {"ok":false,"error":"signup_disabled"}`, `/signup` hides the form and says sign-up is invite-only, startup logs `signup.disabled`, and `deploy.sh` refuses to deploy. Invitations (`/accept-invite`) are unaffected. Outside production signup is always open (`src/lib/signup-config.ts`).

Per-IP limit (5 attempts / hour, ×20 without `TRUSTED_PROXY` where all clients share one key), per-address limit (3 / hour), a **honeypot** field (`company_website`: filled = fake success, nothing created), optional **Cloudflare Turnstile** (`TURNSTILE_SECRET_KEY` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY`; server-side siteverify with a 5 s timeout, **fails closed**; the CSP opens exactly `https://challenges.cloudflare.com` for script, frame and connect when it is configured, docs/security-headers.md), and a graceful platform-wide capacity `SIGNUP_MAX_PER_HOUR` (default 60) designed so one client cannot switch signup off for everybody:

1. only accounts actually **created** consume capacity (existing-address, honeypot and failed-captcha requests do not);
2. each client (IP; the shared `untrusted` key without a trusted proxy) may create at most 20% of the cap per hour (50% for the shared key), so an attacker hits its own limit first (`429 too many attempts`);
3. past **70%** of the cap signup is *degraded*: a client that already created an account this hour gets no second one, Turnstile (when configured) is required on every signup, and `signup.degraded` is logged;
4. only at **100%** is signup refused for everyone (`429 signups are temporarily unavailable`, `signup.global_cap_reached` logged at error level once per 10 minutes: alert on it and raise the cap if the demand is real).

All counters live in `rate_limit_buckets` (shared by all instances; the store failing closes the route). **Pre-account squatting:** nobody can plant a second factor on an unverified account (`2fa/enroll` and `/confirm` answer `403 email_not_verified`); a password reset (which proves control of the mailbox) disables and wipes 2FA that was enrolled while the address was unverified or before it was verified, audits it (`auth.2fa_cleared_on_reset`) and emails the owner, and deletes the passkeys registered while the address was unverified or before it was verified (a passkey sign-in is a full MFA session; audit `auth.passkeys_cleared_on_reset`, one "passkey removed" email each; passkeys registered after verification are kept); and a stale (>24 h) UNVERIFIED self-signup no longer holds its address: a new signup for it replaces the squatter's pristine business and user (never a verified account, one with a number/agent/plan, or one with a second member).

### Two-factor authentication (TOTP)

- Enrol on `/dashboard/security`: the user re-enters their password (`POST /api/auth/2fa/enroll`), the server generates a secret, stores it **encrypted** (AES-256-GCM, `APP_SECRET_KEY`, bound to the user id) and returns the otpauth URI and a **server-rendered SVG QR code** (`qrcode`). A code from the app (`/confirm`) turns it on and returns **10 recovery codes shown once** (only hashes are stored). Turning it on signs out all other sessions.
- Disable (`/disable`) needs the password **and** a valid code or recovery code; regenerating recovery codes (`/recovery-codes`) needs an app code and voids the old set. Each change is audited and mailed to the user.
- **Per-account lockout (independent of the client IP):** wrong second-factor codes on one account (login step, disable, regenerate) are counted per account with exponential backoff (3 free failures, then 429 with `retry-after`, doubling); while locked even a correct code is not checked. From the 4th failure the user gets an email (`Someone is guessing your two-factor codes`, at most once an hour) and the lock is audited (`auth.mfa_account_locked`). The per-(account, IP) and per-session limits still apply.
- Recovery codes are `xxxxx-xxxxx`, case/format tolerant, single use; using one is audited with the remaining count.
- Losing `APP_SECRET_KEY` makes every authenticator unusable (recovery codes still work through the second step, which only needs the hashes).

### Team management and audit

Owners (their active business) and admins (any business, via the sidebar switcher which maps to `business_id`) can invite, resend, revoke, change role, disable/enable, remove and sign out members. Team data is **per business** (`listBusinessMembers`, `setMembershipRole`, `disableMembership`, `removeMembership` in `src/lib/db/memberships.ts`): changing a role or disabling someone affects that business only. **A business always keeps one active owner**: demoting, disabling or removing the last active owner (an owner membership that is enabled, whose account is enabled) is refused with `409 last_owner`, enforced under row locks on the business's owner memberships so two owners cannot demote each other concurrently (`tests/db/multi-business.test.ts` races them). Disabling or removing a membership clears `active_business_id` of the sessions that worked there (they fall back to another business); a role change ends the member's sessions in that business; when the person had no other business every session ends, and removing their last membership deletes the account (as removing a team member always did). You cannot disable or remove yourself. Admin accounts are not team members (404). Every mutation writes an audit row.

**Per-business isolation.** Billing (`billing_status`, Stripe ids, plan), provisioning (number, agent), usage counters, calls, bookings, briefings, knowledge base, audit trail and team are all rows of one business; an account in several businesses has separate ones, and each business subscribes, provisions and pays on its own. Deleting a business never deletes an account that belongs to another one (the legacy primary business is re-pointed).

### Add another location

`POST /api/businesses/mine {name}` (dashboard sidebar: "+ Add another location") lets an owner of at least one business create an additional one: business + **owner membership** are one transaction, billing starts at `none` and nothing is provisioned (onboarding for the new business starts at `/onboarding`; the session moves to it). It needs a verified email, is limited to 5 attempts per hour per account (and per client IP), and the per-account cap `MAX_BUSINESSES_PER_USER` (default 10, counts all of the account's owner memberships) is enforced under a row lock on the user, so parallel requests cannot overshoot it (`409 limit_reached`). Staff-only accounts and admins cannot.

### Passkeys (WebAuthn)

Implemented with `@simplewebauthn/server` (`src/lib/webauthn.ts`, routes under `/api/auth/passkeys/**`, state in `passkey_credentials` and `webauthn_challenges`, helpers in `src/lib/db/passkeys.ts`). A passkey is a **phishing-resistant sign-in and step-up factor**, never a replacement for the password: every account keeps its password, so removing every passkey cannot lock anyone out.

| Ceremony | Endpoints | Rules |
|---|---|---|
| Register | `POST register/options`, `POST register/verify {response, name?}` | Needs a signed-in personal account (tenant user or DB admin) with a **verified email address** (`403 email_not_verified`: a squatter on an unverified account must not plant a credential that outlives the real owner's reset) and a **recent** authentication (`sudo_at` < 5 min, else `403 reauth_required`): a stolen cookie must not plant a persistent credential. `excludeCredentials` = the account's existing passkeys, `residentKey: 'preferred'` (discoverable), `userVerification: 'required'`, attestation `none`. Max **20 per account** (`409 passkey_limit`). Stores the public key, counter, transports, device type, backed-up flag and a name; audit `auth.passkey_added`; the account gets an email notice. |
| Login | `POST login/options`, `POST login/verify {response}` (public) | **Usernameless**: no email in, no `allowCredentials` out, so the options are identical for every caller and nothing about which addresses exist is revealed. The assertion must carry **user verification**; it therefore counts as both factors: the session is created with `mfa_verified_at` set even for an account with an authenticator app. Unchanged from password login: a previous session in the browser is replaced (no fixation), disabled accounts and accounts without an enabled membership get the same generic `401 passkey sign-in failed`, an unverified email still signs in (banner), per-client attempt cap and per-credential failure backoff apply, audit `auth.login` with `method: passkey`. |
| Step-up | `POST reauth/options`, `POST reauth/verify {response}` | `allowCredentials` = the caller's own passkeys; the credential must belong to the caller. Success stamps `sudo_at` exactly like a password re-entry (so it satisfies `requireRecentAuth`); wrong attempts share the 8-per-15-min budget of `/api/auth/reauth`. The dashboard's re-authentication panel offers "Use a passkey instead". |
| Manage | `GET /api/auth/passkeys`, `PATCH /:id {name}`, `DELETE /:id` | Own passkeys only (another account's id is 404). Rename is audited; **delete needs a recent authentication** (a passkey step-up counts), is audited and mailed. |

Verification rules: the relying party comes from configuration, never from the request in production. `rpID` = host of `PUBLIC_BASE_URL` (else `APP_URL`); `WEBAUTHN_RP_ID` overrides it with a registrable parent domain, `WEBAUTHN_ORIGINS` adds exact extra origins (staging). Origins must be `https` (or `http` on localhost), and the browser-reported origin must equal one of them exactly (scheme, host, port) and sit under the rpID; production without a configured origin answers `503 passkeys_not_configured` (outside production an unconfigured server falls back to the request origin, for `next dev`). **Challenges** are 32 random bytes, stored only as sha256, **single use** (one atomic `UPDATE ... RETURNING`), valid 5 minutes, **bound to a purpose** (`register` / `login` / `reauth`) and, for register/reauth, to the account; they are consumed *before* the signature is checked, so a replayed or failed response needs a new challenge. rpID hash, `webauthn.create`/`webauthn.get` type, user presence and **user verification** are enforced by the library; a credential's `userHandle`, when sent, must match the credential's owner.

**Clone detection.** The library's own counter check is bypassed (counter 0 is passed) and replaced by `recordPasskeyUse`, one atomic `UPDATE ... WHERE counter < new` (authenticators that always report 0 are allowed). A counter that does not advance means a copied authenticator or a replayed assertion race: the sign-in is refused with the same generic 401, **every session of that account is revoked**, `auth.passkey_clone_suspected` is audited and the user is emailed. Two concurrent assertions with the same counter cannot both succeed.

Browser side: the login page has "Sign in with a passkey" (modal ceremony) and, where `PublicKeyCredential.isConditionalMediationAvailable()` is true, **conditional UI**: the email field is `autocomplete="username webauthn"` and the browser offers the site's passkeys in its autofill list. `@simplewebauthn/browser` is bundled with the app (no third-party script, no inline script), so the strict nonce CSP is unaffected. The security page lists, adds, renames and removes passkeys (labelled controls, live status region, 44px targets).

Audited actions (`audit_events`, never containing secrets or tokens; secret-looking meta keys are redacted): `auth.signup`, `auth.login`, `auth.login_password_ok`, `auth.login_failed` (known accounts), `auth.mfa_failed`, `auth.recovery_code_used`, `auth.logout`, `auth.email_verified`, `auth.password_reset_requested`, `auth.password_reset`, `auth.2fa_enroll_started`, `auth.2fa_enabled`, `auth.2fa_disabled`, `auth.recovery_codes_regenerated`, `auth.session_revoked`, `auth.sessions_revoked_others`, `auth.admin_login`, `auth.admin_sessions_revoked`, `user.create`, `user.invite`, `user.invite_resent`, `user.invite_revoked`, `user.invite_accepted`, `user.role_changed`, `user.disabled`, `user.enabled`, `user.removed`, `user.sessions_revoked`, `auth.business_switched`, `business.created_additional`, `auth.passkey_added`, `auth.passkey_register_failed`, `auth.passkey_renamed`, `auth.passkey_removed`, `auth.passkey_clone_suspected`, `auth.reauth` / `auth.reauth_failed` (with `method: password | totp | passkey`). Owners read their business's trail on `/dashboard/team/audit` (cursor pagination); admins read one business or all.

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

- **Cross-tenant access**: every business-scoped handler resolves the business from the principal, not from the request. Cross-tenant ids return 404.
- **Cross-tenant via the active business (multi-business accounts)**: the active business is server-side session state, set only by `setSessionActiveBusiness` (membership checked inside the UPDATE) or by a flow that just proved the membership (accepting an invitation, creating a location); it is re-validated against the enabled memberships on every request, so a disabled or removed membership stops working immediately (the principal falls back to another business or to nothing). The role always comes from the membership of the *active* business, and business-scoped routes accept only the active business, so an owner-in-A / staff-in-B account can never use its owner role on B (or its staff role on A) by naming the other id. There is no cookie or query parameter that selects the business for users (the admin-only `rc_business` cookie is a UI preference that is re-checked against the real list).
- **Session fixation**: login (password, passkey, second step) always replaces the session the browser held and issues a fresh random token; the MFA step swaps the pending session for a new one. A new session starts with no active business (it never inherits another session's). Switching business keeps the token (identity did not change) and touches only the caller's own session row.
- **Passkey threats**: phishing and replay are covered by origin/rpID binding, single-use purpose-bound challenges and user verification; cloning by the atomic counter check (sessions revoked, user mailed); a stolen session cookie cannot add or remove passkeys without a recent authentication; passkey login answers are generic (no oracle for disabled or unknown accounts) and the usernameless options reveal nothing. Residual: a synced passkey (iCloud/Google/1Password) is only as safe as that provider account; the notice emails and the Security page are how an owner notices an unexpected one. `REQUIRE_2FA_FOR_ADMINS` still asks a DB admin for an authenticator app (a passkey does not satisfy that enrolment rule). `tests/auth-db.test.ts` and `tests/db/auth-team.test.ts` cover owner/staff/admin isolation against Postgres.
- **User enumeration**: login, signup, forgot-password and resend-verification answer identically (body and, as far as practical, timing: password hashing happens in both branches and mail is sent after the response) for known/unknown/disabled addresses. Residual leaks: the admin-only create-user route (`409 email already registered`); team invites tell an owner "already on the team" for their **own** business only; the accept-invite page tells the holder of an invitation link whether the invited address already has an account (it needs that to ask them to sign in). Signup for an existing address stays indistinguishable from a new one. Signup/forgot throttling returns the same status for every address. Timing is equalised, not constant: DB writes on the new-account path are a few ms against ~100 ms of scrypt.
- **Login throttling** (`src/lib/login-throttle.ts`), with no bucket shared by all tenants: (1) a per-client-IP attempt cap (60 / 5 min, checked before any password hashing); (2) a per-(account, client-IP) failure backoff (3 free failures, then 15s, 30s, 1m ... capped at 15 min; failures only, a success clears it; the break-glass `ADMIN_TOKEN` has its own pair key; the second step and password re-entry for 2FA changes use their own/shared keys the same way); (3) a per-account failure counter across all addresses that only **logs** (`distributed_guessing`) and never blocks, because blocking on it would let anyone lock a real user out from a different IP. A distributed guesser is slowed per address, not stopped: use strong passwords and turn on 2FA. Per-IP keys need `TRUSTED_PROXY=true` (and `TRUSTED_PROXY_HOPS` behind a CDN); otherwise all clients share the `untrusted` key and the pair backoff uses a 20-failure allowance and a 60 s cap so it cannot become a long lockout.
- **2FA brute force**: 6-digit codes are guarded by the pair backoff, the 5-failures-per-pending-session cap and the 10-minute pending lifetime; each guess burns one password login first.
- **Email as a root of trust**: whoever controls the mailbox can reset the password (2FA still applies at login). Verification links never log anyone in. Link tokens appear in URLs: the pages set `Referrer-Policy: no-referrer` and `noindex`, and tokens are never logged or audited (the `log` provider prints links in development only).
- **Signup abuse**: see above. An attacker can still make us send one verification mail per allowed attempt to a victim's address (bounded by the per-address and per-IP limits and the hourly cap); an existing address receives at most one notice per hour.
- **XSS**: the session cookies are `HttpOnly`, so script cannot read them, but script running in the page can still make same-origin requests. The QR code SVG is generated server-side from our own URI and inserted as markup (it contains no attacker-controlled text beyond the account email, which is URL-encoded inside the QR payload, not in the SVG).
- **Unrevokable until expiry**: nothing signed is trusted any more. The only credentials that cannot be revoked server-side are the Bearer `ADMIN_TOKEN` (rotate it) and a browser's cached copy of a page already rendered.
- The public home page `/` renders no tenant data.
- Voice-tool and webhook routes are not user-authenticated (they use tool/webhook secrets); the agent-to-tenant binding is covered in `docs/review/05-adversarial-review.md` (H2).
