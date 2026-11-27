# 24b. Platform-admin surface TODAY (read-only inventory)

Scope: what a platform admin (`role=admin` DB user, or break-glass `ADMIN_TOKEN`) can do today, how it is authorized/audited, and the gaps against what a multi-tenant SaaS operator needs. All claims verified by reading code (file:line). No repo files were edited.

## 0. Headline

The admin surface is **API-and-CLI first**. There is exactly **one** admin-only dashboard page (`/dashboard/demo`, which does not exist in production), **one** admin-flavoured view of a tenant page (audit log with `?all=1`), and a **business dropdown** (the de-facto "impersonation"). Everything else an admin does (comp a tenant, set caps, create a tenant user, run jobs, repair numbers, release a tenant, resync agents) is a raw JSON `POST` with `Authorization: Bearer ADMIN_TOKEN` or a cookie session, or a `bun scripts/*.ts` CLI. There is **no settings/config table** in the Prisma schema (models list: `prisma/schema.prisma` lines 14-908; none is a platform-settings model), so nothing platform-wide can be configured except by environment variable. All job switches, caps defaults, provider health "status" and feature toggles are env.

## 1. Authn/authz primitives

| Item | Where | Notes |
|---|---|---|
| Admin credentials | `src/lib/session.ts:6-16` | (1) `Bearer ADMIN_TOKEN` (CSRF-exempt, no step-up); (2) admin cookie session via DB user `role='admin'`; (3) break-glass `admin_token` cookie session (12 h, server side, `src/lib/db/users.ts:13,209`); (4) `ALLOW_INSECURE_DEV` open mode (non-production). Fail-closed 503 when `ADMIN_TOKEN` unset (`src/lib/auth.ts:104-113`). |
| Route guard | `authenticate(req,{role:'admin'})` in every `/api/admin/*` route; `guardAdmin` (`src/lib/admin-guard.ts:13`) only for `/api/demo/reset` | |
| Step-up (re-auth <=5 min) | `requireRecentAuth` `src/lib/session.ts:~290-305`, `RECENT_AUTH_MS` = 5 min | Used ONLY by tenant-facing routes: `businesses/[id]` PATCH (vertical change), `call-mode`, `line`, `forward-number*`, `privacy/export|erase`, `bookings/[id]/refund*`, `deposit/*`, passkeys, reauth. **No `/api/admin/*` route calls it** (verified by grep: no file under `src/app/api/admin/` in the `requireRecentAuth` list). A stolen admin cookie can comp tenants, release tenants (deletes Twilio numbers/agents) or run retention purge without re-entering a password. Bearer ADMIN_TOKEN is exempt by design (`session.ts` doc: "not ambient"). |
| 2FA for admins | `REQUIRE_2FA_FOR_ADMINS` env, `src/lib/session.ts:141,195`; `/api/auth/2fa/disable` refuses for admin when required (`2fa/disable/route.ts:20`) | env-only toggle. |
| Rate limits | per-route `limitRequest` | present on admin/billing (30), users (20), release-tenant (20), repair-numbers (6), resync-agents (6). **Absent** on `admin/jobs` GET, `admin/jobs/run`, `admin/retention`. |
| Revoke all break-glass sessions | `POST /api/auth/revoke-admin-sessions` (`allowEnrollment:true`), UI button in Security page `src/components/auth/security-panel.tsx:281` (`AdminSessions`) | The only admin credential-management UI. |

## 2. Inventory: `src/app/api/admin/**` (8 route files, 628 lines total incl. demo page)

| Route | Method | What it does | Audit | Step-up | Rate limit | UI? |
|---|---|---|---|---|---|---|
| `admin/billing/route.ts:33` | POST | Comp/adjust a tenant: `billing_status`, `plan` (free string <=60), `trial_ends_at`, `current_period_end`, `sms_cap_override`, `call_minutes_cap_override`, `note`. `null` clears. Does not touch Stripe ids; later Stripe event may overwrite (`:27-31`) | yes `billing.admin_override` with from/to status+plan (`:71-81`); **cap values and dates are not in the audit meta** (only `changed` keys) | no | 30 | **none** |
| `admin/jobs/route.ts:15` | GET | Runner state, per-job enabled/last_run/last_result/next_due, voice-line diagnostics, recording-deletion queue, tenant-release last reports | read | no | none | **none** |
| `admin/jobs/run/route.ts:16` | POST | Run one job by hand (`daily_briefing, gratitude_sweep, cleanup, retention, recording_deletions, reconcile, usage_warnings, google_calendar, tenant_release, grandfather`); `dry_run` default true; optional `business_id`, `before` (grandfather) | only non-dry runs (`:32-39`) | no | none (`maxDuration 300`) | **none** |
| `admin/retention/route.ts:12` | POST | Manual PII purge (dry-run default; `dry_run:false` really deletes across all tenants, even when `RETENTION_JOB` off) | **no audit row from the route** (the job path audits separately; this route calls `runRetentionNow` directly, `:19`) | no | none | **none** |
| `admin/users/route.ts:14` | POST | Create an owner/staff login for a business with a chosen password, `email_verified:true` (`:32`) | yes `user.create` (role only) | no | 20 | **none** |
| `admin/release-tenant/route.ts:20` | POST | Release ONE canceled/unpaid tenant's Twilio number + ElevenLabs agent (dry-run default; `skip_notice` override) | yes (`billing.release_notice`, `billing.tenant_released` in `billing/release.ts`) | no | 20 | **none** |
| `admin/repair-numbers/route.ts:51` | POST | Idempotent Twilio webhook repair, import/bind to ElevenLabs, messaging-service pool, `refresh_credentials` after Twilio token rotation; batched with `next_cursor` | yes `admin.repair_numbers` (counts + ids, `:103`) | no | 6 | **none** |
| `admin/resync-agents/route.ts:35` | POST | Re-sync every tenant's ElevenLabs agent/prompt/tools (batched) | yes (`:101`) | no | 6 | **none** |

Admin-or-owner endpoints that give admins extra reach (all authorize by `requireBusinessAccess`, admin passes for any business):
- `POST /api/businesses` (`businesses/route.ts:31-32`): **admin only**, create tenant. `GET /api/businesses` (`:16`) lists ALL tenants for admin (JSON, no pagination/search/filter; `listBusinesses()`).
- `GET/PATCH /api/businesses/[id]` (`[id]/route.ts:53,78`): admin can read detail + stats and edit any tenant's settings.
- `POST /api/businesses/[id]/provision` (`provision/route.ts:85,175,233,386-445`): admin bypasses billing gate (`billing/gate.ts:31`), may pass `force` (rebuild KB + re-register agent), and is the ONLY caller who receives the freshly created ElevenLabs post-call webhook secret (shown once in the response, `:445`).
- `POST /api/billing/checkout` admin may start checkout for a tenant (`checkout/route.ts:15`).
- `GET /api/team/audit` (`team/audit/route.ts:19-37`): admin can read one business or ALL events (`business_id` omitted). Filters in the API: `before`, `limit` only.
- `POST /api/team/users/[id]/revoke-sessions` (`:22-23`): admin signs a user out everywhere; owners only from their business.
- `PATCH/DELETE /api/team/users/[id]`: owner/admin, can disable user per business (`team/users/[id]/route.ts:42-65`).
- `POST /api/businesses/[id]/privacy/export|erase` + `/api/privacy/export|erase`: owner or admin (per customer phone, not per tenant). Erase/export require step-up (`businesses/[id]/privacy/erase/route.ts:25`).
- `POST /api/demo/reset`, `/api/demo/simulate-call`: admin + `DEMO_MODE=true` + non-production only (`src/lib/auth.ts:234-236`).
- `GET /api/auth/sessions` (admin also sees break-glass sessions, `sessions/route.ts:21`).

## 3. Admin pages/components in the dashboard

| Page | Gate | Content |
|---|---|---|
| `src/app/dashboard/demo/page.tsx` | `notFound()` unless `demoModeEnabled()` (non-prod) (`:23`), then `requireRolePage(ctx,'admin')` (`:26`) | Demo console: simulate call, reset data, "integrations live/mock" badges (Twilio/ElevenLabs/Stripe/LLM, read from `process.env` presence, `:74-85`). **Not available in production**, so the only provider-status UI never reaches a real operator. Nav entry `shell.tsx:33` (`gate:'admin', demoOnly:true`). |
| `src/app/dashboard/team/audit/page.tsx` | `requireRolePage(ctx,'owner')`; admin gets `?all=1` toggle (`:24,37`) | Cursor-paginated table (when / action / target / ip), 50 per page. **No filter by action, actor, business, date or text; no export; `meta` JSON is not displayed; business id column absent** so in `?all=1` mode you cannot tell which tenant a row belongs to (`listAuditEvents` supports `actor_user_id` and `action` filters, `db/audit.ts:87-94`, but the page and the API route do not expose them). |
| Business switcher (`shell.tsx:217-228`) | `isAdmin && businesses.length>1` | A plain `<select>` of all tenant names; sets cookie `rc_business` client side (`:210`); `getDashboardContext` honors it for admins (`dashboard-context.ts:47-57`). This is the only "tenants directory": no search, no status, no pagination (loads `listBusinesses()` fully on every dashboard render). |
| `/dashboard/security` admin parts | `isAdmin` | Break-glass session count + "revoke all" (`security-panel.tsx:268,281`), forced 2FA enrollment redirect (`session.ts` `getServerResolution`). |
| Settings / Billing / Team / Calls pages | `owner` role, admin passes | Admin sees these **as the selected tenant, with full owner write powers** (no read-only mode). Nothing in `billing/page.tsx` or `settings/page.tsx` exposes admin controls (no override form: grep for `admin` finds none). |
| Onboarding | admin can create tenants / resume (`onboarding/page.tsx:30`, `step-info.tsx:146`, `step-plan.tsx:118`) | admin bypasses plan step. |

There is **no `/dashboard/admin/**` or `/admin` route tree** at all. `find src/app/dashboard` shows only tenant pages.

## 4. `scripts/` CLIs

| Script | Purpose | Safety | Equivalent API/UI |
|---|---|---|---|
| `create-user.ts` | Create owner/staff/**admin** login; password via env/stdin/prompt, never argv | none beyond DB access | `POST /api/admin/users` for owner/staff only. **Global admins can only be created by CLI** (`create-user.ts:5,61-62`). |
| `release-canceled-tenants.ts` | Batch release of canceled/unpaid tenants, dry-run default, `--apply` | `assertSafeDatabase` + `--force-i-know` for prod | API `admin/release-tenant` (one tenant) and job `tenant_release` (needs `TENANT_RELEASE_JOB=on`) |
| `grandfather-existing.ts` | Comp pre-cutoff vetted tenants, dry-run default | same | `jobs/run {job:'grandfather'}` (real run also needs `TENANT_RELEASE_JOB=on`, `jobs/run/route.ts:30`) |
| `db-reset.ts` / `seed.ts` | Dev only; seed refuses `NODE_ENV=production` (`seed.ts`) | `_safe-db.ts` name guard | n/a |
| `verify-deploy.ts` | Post-deploy smoke of webhooks with secrets passed via env | read-only | none (CLI only) |
| `smoke.ts`, `ws1..5-test.ts`, `gen-audio.ts`, `check-elevenlabs-key.sh` | test/dev utilities | | |

## 5. Background jobs control (`src/lib/jobs/**`)

- 10 jobs (`schedule.ts:17`): `daily_briefing, gratitude_sweep, cleanup, retention, recording_deletions, reconcile, usage_warnings, google_calendar, tenant_release, grandfather`.
- **Enable/disable is env only**: `JOBS` (`schedule.ts:28-33`, default ON only when `NODE_ENV=production`), `JOBS_TICK_SECONDS` (`:36`), `RETENTION_JOB`, `TENANT_RELEASE_JOB` (off|report|on). The runner starts once per process at boot (`jobs/index.ts:602-626`); changing a switch requires redeploy/restart. There is **no per-job pause, no per-tenant exclusion, no schedule editor** (briefing hour is a constant `BRIEFING_HOUR = 18`, `schedule.ts:10`).
- Run-now: API only (`jobs/run`), dry-run default, `force` bypasses only the time-of-day gate (`jobs/index.ts:130`).
- Status/history: `GET /api/admin/jobs` returns last_run_at (a `processed_events` 'job-state' row, `jobs/index.ts:141-157`), the newest audit row as `last_result`, `next_due_at`. **History is only the last result per job**; zero-work and dry runs are not audited (`auditRun`, `jobs/index.ts:159-167`), errors with `processed===0 && errors===0` are invisible. No run log table, no per-run duration, no failure alert surfaced besides `recording_deletions` stuck count.
- Dry-run reports for tenant release/grandfather are stored as audit rows `jobs.tenant_release_report` / `jobs.grandfather_report` and shown only through the raw JSON of `GET /api/admin/jobs`.

## 6. Billing overrides / comp accounts

- Schema: `business.billing_status`, `plan` (free-form), `sms_cap_override`, `call_minutes_cap_override` (nullable ints; "NULL = use env `PLAN_SMS_CAP` / `PLAN_CALL_MINUTES_CAP`", `prisma/schema.prisma` ~55-57), defaults and trial caps from env (`db/usage.ts:9,57-68`; `TRIAL_CALL_MINUTES_CAP`).
- Set via `POST /api/admin/billing` (only path) or grandfather script/job. No "comp" boolean: "comped" is inferred (plan set, no Stripe subscription, status active). Release code treats admin-comped specially (`release-tenant` doc `:16`). Copy: the route itself warns a later Stripe event for a linked customer can overwrite a comp (`billing/route.ts:30-31`).
- No UI, no list of comped tenants, no expiry for a comp (only `current_period_end` if set), no reason enum (free `note` is truncated to 300 chars and stored only in audit meta).
- `billingSummary` returns the effective caps/usage per tenant (`billing/summary.ts`), visible to admin only by selecting that tenant in the switcher and opening `/dashboard/billing`.

## 7. Feature toggles per tenant

None as a platform concept. Per-tenant knobs are owner-controlled (call mode ai/paused/forward `api/businesses/[id]/call-mode`, vertical, scheduling, deposit/refund policy, etc.). `BusinessStatus` includes `'paused'` (`src/lib/types.ts:6`) but nothing sets it (grep for `'paused'` hits only call-mode, voice routes and the shell; no admin route changes `business.status`). Platform-level toggles are all env: `DEMO_MODE`, `JOBS`, `RETENTION_JOB`, `TENANT_RELEASE_JOB`, `REQUIRE_2FA_FOR_ADMINS`, `VOICE_LINE_KIND`, `SMS_ALLOWED_COUNTRY_CODES`, `TWILIO_MESSAGING_SERVICE_SID`, `OWNER_PHONE_GRANDFATHER`, `PLAN_*`, `TRIAL_*`, etc. (62 distinct `process.env.X` names under `src/`, by grep).

## 8. Other admin-relevant findings

- Health: `GET /api/health` (`health/route.ts:41`) is unauthenticated, returns 503 when `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` missing, and warns on missing Messaging Service. It is a container probe, not provider health: no Twilio/ElevenLabs/Stripe/Google/Resend connectivity or quota check anywhere.
- Delivery failures: `POST /api/sms/status` records failed/undelivered texts as audit `sms.delivery_failed` (`sms/status/route.ts:11,44`); there is no view of them and no retry (doc comment: "Nothing is retried").
- Webhook/event log: `processed_events` table is a dedup claim store cleaned after 30 days (`jobs/index.ts:148`), not a delivery log; nothing displays it.
- No "last login" / user directory; global admin accounts can be listed only via SQL. Admin users have no memberships (`db/memberships.ts:68`).
- Audit actors for admin actions are consistent: `actor_kind 'user'|'admin_token'`, but the Bearer token is not distinguishable between operators (single shared secret), so there is no individual accountability for token callers.

## 9. Capability matrix vs. operator needs

Legend: Present = usable end to end by an operator without a shell; Partial = exists but API/CLI only, or missing pieces; Missing = nothing.

| # | Capability | Exists today? (API / UI / CLI / none) | Authz (step-up? audit?) | Status |
|---|---|---|---|---|
| 1 | Tenants directory & search | API only: `GET /api/businesses` (all, no q/paging); UI: name-only `<select>` (`shell.tsx:217`) | admin; no audit (read) | **Partial** (no search, status, plan, usage columns, pagination) |
| 2 | Tenant detail (plan, usage, caps, status, provider ids) | Data exists (`GET /api/businesses/[id]`, `billingSummary`); UI = select tenant, then browse tenant pages. Provider ids (`agent_id`, Twilio number, `stripe_*`) not shown in any admin view | none | **Partial** (no single admin tenant page) |
| 3 | Suspend / reactivate tenant | none. `status='paused'` type exists, no setter; closest: `billing_status` via `admin/billing` or `release-tenant` (destructive) | n/a | **Missing** |
| 4 | Impersonation / support view (read-only?) | Switcher gives admin full OWNER-level access, read AND write, to any tenant, cookie-based (`dashboard-context.ts:47-57`); no banner, no read-only mode, no per-view audit, no time limit | audit only for specific writes; step-up not applied | **Partial** (works, but unsafe: no read-only, no logging of access) |
| 5 | Manual plan/comp/cap overrides | API `POST /api/admin/billing`; CLI grandfather | audited (`billing.admin_override`; cap/date values not recorded); no step-up | **Partial** (no UI, no comp list/expiry, weak audit meta) |
| 6 | Provider health & integration status | Env-presence badges only on demo page (non-prod) (`demo/page.tsx:74-85`); `/api/health` DB+LLM probe; `admin/jobs` diagnostics (voice line mismatch) | public / admin | **Missing** for prod (no Twilio/ElevenLabs/Stripe/Google/Resend/LLM live checks, no key-rotation status) |
| 7 | Job status / history & run-now | Status+last result: `GET /api/admin/jobs`; run-now: `POST /api/admin/jobs/run` (dry-run default). No UI. Enable/disable env only | run-now audited if non-dry; no step-up; no rate limit | **Partial** (no UI, no history, no toggles) |
| 8 | Audit log search / export | UI: per-tenant or `?all=1` table, API: `GET /api/team/audit` (cursor); DB layer supports actor/action filter but not exposed; no meta view, no date range, no CSV/JSON export, no business column | owner+ ; admin may read all | **Partial** |
| 9 | Webhook / event delivery log | none (`processed_events` is dedup only) | n/a | **Missing** |
| 10 | Failed-SMS / delivery dashboard | Only audit rows `sms.delivery_failed`, `sms_logs` table with status/error code; no UI/API | n/a | **Missing** |
| 11 | Announcements / maintenance mode | none (no table, no banner, no kill switch; only per-tenant call-mode pause and env `JOBS=off`) | n/a | **Missing** |
| 12a | Create tenant user (owner/staff) | API `POST /api/admin/users` (sets password, auto-verified) | audited; no step-up | **Partial** (no UI) |
| 12b | Create global admin | CLI only `scripts/create-user.ts --role admin` | shell access | **Partial** (CLI) |
| 12c | List / disable global admins, invite, force logout, reset 2FA for others | Disable per business user: `PATCH /api/team/users/[id]` (owner/admin); force-logout: `revoke-sessions` (admin = everywhere); break-glass revoke-all: API + button; **reset another user's 2FA: none** (only self-disable `2fa/disable`, or password-reset flow disables TOTP `reset-password/route.ts:54`); list admins: none; invite admins: none | audited on team routes | **Partial** |
| 13 | Feature flags | none (env only) | n/a | **Missing** |
| 14 | Usage / revenue overview (platform wide) | none. Per-tenant usage via billing page. No MRR, active/trial/past_due counts, minutes totals, SMS totals | n/a | **Missing** |
| 15 | Data requests (export / erase) | Per customer (phone) per tenant: `privacy/export|erase` owner or admin, step-up required for cookie sessions. No tenant-level export/delete (account closure), no data-request queue/log UI. Retention purge: API `admin/retention` | erase/export: step-up + audit; retention route: no audit, no step-up | **Partial** |
| 16 | Config / settings editor (platform-wide, replacing env) | none. No settings model; every platform value is env | n/a | **Missing** |
| 17 | Tenant offboarding/release | API `release-tenant` (one), CLI (batch), job (env-gated); no UI; report only in raw JSON | audited; no step-up | **Partial** |
| 18 | Provider ops (repair numbers, resync agents, refresh creds) | API only, batched with cursor | audited; rate-limited; no step-up | **Partial** (no UI, operator must loop on `next_cursor` by hand) |
| 19 | Break-glass session management | UI button revoke-all; list in `/api/auth/sessions` | audited | **Present** (but all-or-nothing) |

## 10. Cross-cutting gaps (ordered by operator risk)

1. **No admin UI at all** (zero admin-only pages in production). Every capability above marked Partial is reachable only via curl with a bearer token.
2. **Admin has no step-up on destructive endpoints** (release-tenant, retention purge, billing override, users create, repair/resync). Cookie-session admins are "ambient" credentials exactly like the tenant routes the code already protects.
3. **Impersonation is full write, unaudited access** via a client-set cookie; any admin write inside a tenant is attributed in audit as the admin user (when via DB user) but reads and the fact of "entering" a tenant are not recorded.
4. **`admin/retention` has no audit row and no rate limit**; `admin/jobs/run` has no rate limit; the audit meta of `billing.admin_override` omits the new cap/date values.
5. **Platform config is 100% env**; changing job switches, caps defaults, 2FA requirement, country allow-list, demo mode, tick interval requires a redeploy.
6. **No platform-level observability**: no provider health, no delivery failures, no event log, no usage/revenue rollup; only per-tenant billing page and raw JSON.
7. **Shared Bearer token** = no individual accountability for token callers (actor `admin_token`), and rotation requires env change + revoke-all.
8. **`/api/businesses` GET and the layout load every tenant on each admin render** (`listBusinesses()` in `dashboard-context.ts:47`), which will not scale past low hundreds of tenants.
9. **Business `status='paused'` is declared but never set**, so "suspend" has no data model beyond billing state.

## 11. Existing building blocks to reuse for an admin UI

- Audit: `listAuditEvents` already supports `action` and `actor_user_id` filters (`db/audit.ts:87`); only the API/page need to expose them plus meta.
- Jobs: `jobsStatus()` / `JOB_INFO` / `runJob()` return report shapes ready for a table.
- Billing: `billingSummary()` and `setBillingState()` are already the single write path.
- Admin API conventions (`authenticate({role:'admin'})`, dry-run default, audit helper `actor_kind`) are consistent across all 7 write endpoints, so a UI can wrap them 1:1.
- `requireRecentAuth` + `/api/auth/reauth` UX (dashboard retries on `reauth_required`) already exists for tenant routes and can be applied to admin routes.
