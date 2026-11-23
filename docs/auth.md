# Authentication and authorization

Recepcionista has real per-tenant users on top of a break-glass admin token.

## Principals

| Principal | How it authenticates | Scope |
|---|---|---|
| **admin (break-glass)** | `Authorization: Bearer $ADMIN_TOKEN`, or the `rc_session` cookie from the "Use admin token" login | every business |
| **admin user** | a `users` row with role `admin` (no business), cookie `rc_user_session` | every business |
| **owner** | `users` row, role `owner`, tied to one `business_id` | their business only |
| **staff** | `users` row, role `staff`, tied to one `business_id` | their business only, read-mostly |

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
| Create business, provision (buys number, creates agent), website extraction, onboarding | no | no | yes |
| Create users (`POST /api/admin/users`, `scripts/create-user.ts`) | no | no | yes |
| Demo console, `/api/demo/*` (also needs `DEMO_MODE=true`) | no | no | yes |
| Business switcher | no | no | yes |

### Route by route

Public (no session; each verifies its own secret/signature): `/api/health`, `/api/auth/login`, `/api/auth/logout`, `/api/voice/webhook|post-call|incoming|tools/*`, `/api/payments/webhook`, `/api/sms/inbound`, `/api/sms/gratitude-reply`, `/api/pay/mock-complete` (404 unless `DEMO_MODE`), `/pay/*`, `/`, `/login`.

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
| `POST /api/sms/send` | owner | own business; recipient must be a known contact |
| `POST /api/sms/payment-link` | owner | own business; booking must belong to it |
| `POST /api/sms/confirmation`, `/api/sms/gratitude` | staff | booking's business checked |
| `GET /api/voice/agent-prompt` | owner | own business (admin: `?business_id=` or first) |
| `GET/POST /api/privacy/export`, `/erase` | owner | `business_id` forced to own |
| `POST /api/demo/reset`, `/api/demo/simulate-call`, `GET simulate-call` | admin | n/a |
| `POST /api/admin/users` | admin | n/a |

Pages: `/dashboard/*` use `getDashboardContext()` (validates the session in Node, resolves the business). `/dashboard/demo` is admin-only, `/dashboard/settings` owner+. `/onboarding` is admin-only (layout redirects tenants to `/dashboard`). Admins pick the business with the sidebar switcher, which sets the `rc_business` cookie (a UI preference: the server checks it against the real business list on every render and falls back to the first business).

## Where checks happen

- `src/proxy.ts` is only a **cheap gate**: it cannot reach Postgres. It lets a request through if it carries a valid admin Bearer/cookie or a *well-formed* `rc_user_session` cookie, and it refuses cross-site state-changing cookie requests. A forged but well-formed cookie passes the proxy and is rejected by the handler.
- **Real validation is Node-side** (`src/lib/session.ts`): `authenticate(req, { role })` for route handlers (validates the credential against the database, enforces the minimum role, runs the CSRF check) and `getServerPrincipal()` / `getDashboardContext()` for server components. Every non-public handler calls one of these first; `guardAdmin(req)` is the admin-only shorthand. Nothing relies on the proxy alone.
- `requireBusinessAccess(principal, businessId)` throws a 404 for cross-tenant access; `scopeBusinessId(principal, requested?)` pins users to their business and passes admins through.

## Sessions

- Login (`POST /api/auth/login`, `{email, password}`): per-IP limiter (10 / 5 min, fails closed with 503 if the limiter store is down) plus a per-account limiter (10 / 15 min). Unknown email, wrong password and disabled account all return the same `401 invalid credentials` after the same scrypt work (`verifyPasswordOrDummy`).
- The cookie `rc_user_session` holds a random 256-bit token (`HttpOnly`, `SameSite=Lax`, `Secure` in production, 7 days). Postgres stores only its sha256, so a database leak does not yield usable sessions. Sessions expire after 7 days (`SESSION_TTL_MS`), `last_used_at` is refreshed at most every 5 minutes.
- Logout (`POST /api/auth/logout`) deletes the session row server-side and clears both cookies. Disabling a user (`setUserDisabled`) or changing a password (`setUserPasswordHash`) deletes all of that user's sessions.
- The admin-token path (`{token}`) sets `rc_session`, an HMAC derived from `ADMIN_TOKEN` (the raw token never goes into a cookie). Rotating `ADMIN_TOKEN` invalidates all admin cookies. Signing in as one kind clears the other kind's cookie (the admin cookie outranks a user session).

## CSRF

Cookie-authenticated `POST/PATCH/PUT/DELETE` requests must be same-origin: `Sec-Fetch-Site: same-origin`, or (older browsers) an `Origin` whose host equals `Host` (`X-Forwarded-Host` only with `TRUSTED_PROXY=true`; `APP_URL`/`PUBLIC_BASE_URL` hosts are also accepted). Requests with neither header are refused: scripts must use the Bearer token, which is exempt (it is not ambient). The check is enforced in the proxy and again in `authenticate()`. A bad Bearer never falls back to a cookie.

## First owner / first admin

```bash
# an owner for an existing business (password prompt, hidden, asked twice)
bun scripts/create-user.ts --email owner@acme.com --role owner --business biz_xxx

# non-interactive: password from the environment or stdin, NEVER from argv
CREATE_USER_PASSWORD='...' bun scripts/create-user.ts --email root@acme.com --role admin
printf '%s' "$PW" | bun scripts/create-user.ts --email staff@acme.com --role staff --business biz_xxx
```

Passwords must be 12-256 characters. In a deployed container run the script the same way as `db:seed` (the `tools` image). Admins can also create owner/staff over HTTP: `POST /api/admin/users` with `{email, password, role: "owner"|"staff", business_id}` (Bearer token or an admin session).

## Break-glass admin token

`ADMIN_TOKEN` stays the superadmin credential: `Authorization: Bearer ...` for scripts and the "Use admin token" link on `/login`. Keep it out of daily use, rotate it if it leaks (this also kills all admin cookies). Anyone holding it can act on every tenant.

## Threat notes and limits

- **Cross-tenant access**: every business-scoped handler resolves the business from the principal, not from the request. Cross-tenant ids return 404. `tests/auth-db.test.ts` covers owner/staff/admin isolation against Postgres.
- **User enumeration**: login responses and timing are uniform; the admin-only create-user route does reveal `409 email already registered`.
- **Lockout**: the per-account limiter can be used to temporarily lock one account out of password login (the admin token path and the other accounts are unaffected). Per-IP limiting only works behind a trusted proxy (`TRUSTED_PROXY=true`); otherwise all clients share one bucket.
- **No self-signup, no password reset, no 2FA** yet: an admin sets and rotates passwords (change the hash with `setUserPasswordHash`, which revokes sessions). Weaker scrypt hashes are not auto-upgraded at login.
- **XSS**: the session cookie is `HttpOnly`, so script cannot read it, but script running in the page can still make same-origin requests.
- The public home page `/` still renders the first business's aggregate numbers; it is not part of this auth model.
- Voice-tool and webhook routes are not user-authenticated (they use tool/webhook secrets); the agent-to-tenant binding is covered in `docs/review/05-adversarial-review.md` (H2).
