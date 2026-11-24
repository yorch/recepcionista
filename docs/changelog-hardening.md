# Hardening changelog: what changed since the original reviews

`docs/review/00-07` are point-in-time snapshots of the code as it was when each review was written. They are left unedited on purpose, so some of their
statements ("no CI", "nothing schedules the briefing", "the app has no authentication") are **no longer true**. This file maps every finding id to where it stands now.
Each row was checked against the current tree (file, test or doc named in the Evidence column), not copied from a commit message. Where a finding is only partly addressed, or not
addressed, the row says so.

Status words: **Fixed** (the behaviour the review asked for exists and is covered by code/tests), **Partly** (some of it), **Open** (not changed; no code resolves it),
**Documented** (accepted limitation, written down in `docs/known-limitations.md` or the doc named), **Info** (a positive note or a question, nothing to fix).

## Resolution areas (commits on this branch)

| Area | Commit | What it did |
| --- | --- | --- |
| A | `319c453` (#2) | P0/P1 remediation of reviews 00-04, hardened after review 05: proxy/auth, webhook verification, SSRF guard, per-business time zone + booking exclusion constraint, money in cents, tests, CI |
| B | `fdfd4ac` (#3) | per-tenant users and sessions, shared Postgres state (rate limits, leases, event claims), compliance (disclosure, STOP, retention, export/erase), integration tests, Docker hardening; fixes review 06 |
| C | `527c65a`, `d791dc8`, `92723f3` | self-signup, 2FA, billing/trials, E.164 phone model, email, onboarding/UX overhaul, `verify:deploy` |
| D | `dfc5026` | fixes review 07 (fail-closed billing, SMS pumping, opt-out repair, 2FA/signup hardening, Turnstile CSP) |
| E | `de88992` | captcha required for production signup, release of canceled tenants, atomic invites, session revocation |
| F | this hardening pass | provisioning fails loudly (no fake numbers) and is resumable, the background job runner (6 PM briefing, gratitude sweep, cleanup, retention), SMS metering in segments + trial caps |

Migration order: `20261114192900_init`, `20261114203144_add_business_agent_id`, `20261123120000_timezone_cents_booking_integrity` (A), `20261123180000_unique_agent_id` (A),
`20261123210000_shared_state_compliance_users` and `20261124120000_review2_call_keys_event_leases_followup_consent` (B), `20261125120000_accounts_billing_e164_constraints` (C),
`20261126120000_review3_optout_repair_trials_indexes` (D). Area F adds **no migration** (job state lives in `processed_events` and `provision_locks`).

## 00 Executive summary (top issues)

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| 1 No authentication | Fixed (A, B) | proxy + per-tenant users/sessions, tenant scoping on every route | `src/proxy.ts`, `src/lib/session.ts`, `docs/auth.md`, `tests/proxy-decisions.test.ts` |
| 2 Destructive/abusable endpoints | Fixed (A, B) | demo routes 404 unless `DEMO_MODE=true`; SMS routes authenticated with server-fixed wording; rate limits; provisioning lease + billing gate | `src/app/api/demo/reset/route.ts`, `src/lib/ratelimit.ts`, `src/lib/db/locks.ts` |
| 3 No webhook verification | Fixed (A, B) | Twilio signature, ElevenLabs HMAC + tool secret, Stripe secret mandatory | `src/lib/providers/twilio.ts` (`verifyTwilioSignature`), `tests/integration/signatures.test.ts` |
| 4 SSRF | Fixed (A) | resolve-and-pin fetch with per-hop validation | `src/lib/net/safe-fetch.ts`, `src/lib/net/ip-shape.ts` |
| 5 Booking correctness | Fixed (A) | per-business IANA zone module, exclusion constraint, overlap check, cancelled bookings free the slot | `src/lib/time.ts`, `prisma/migrations/20261123120000_timezone_cents_booking_integrity`, `tests/time.test.ts`, `tests/integration/booking.test.ts` |
| 6 Payments not wired | Fixed (A) | Stripe metadata, deposit recorded in cents, `/pay` reads the DB | `src/lib/providers/stripe.ts`, `src/app/pay/[id]/page.tsx`, `src/lib/money.ts` |
| 7 Agent honesty/safety | Fixed (A, B) | "owner notified" only when the text went out; tenant derived from the agent id; free-form SMS removed | `src/lib/voice/owner-alert.ts`, `src/lib/voice/tools.ts` |
| 8 Legal/compliance | Fixed (B), Documented | disclosure, sticky decline, STOP/opt-out, quiet hours, 911 rules, retention, export/erase. Legal review is the operator's | `docs/compliance.md`, `docs/known-limitations.md` |
| 9 Docs/PRD overstate the build | Fixed (A-F) | PRD reconciled; the 6 PM briefing and gratitude sweep now really run on a timer (F) | `PRD.md`, `src/lib/jobs/index.ts`, `docs/runbook.md` "Background jobs" |
| 10 No tests, no CI | Fixed (A, B) | CI exists since `319c453` (`.github/workflows/ci.yml`: Postgres service, typecheck, lint, `next build`, migrate, `bun test`); suite is several hundred tests. CI triggers on `pull_request` only | `.github/workflows/ci.yml`, `tests/`, `docs/testing.md` |
| Recommended order, Phase 3 (UX/DRY) | Partly | see 03 below | |

## 01 Security and integrations

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| C1 No authN/authZ | Fixed (A, B) | as 00 #1; patch allow-list, business resolved from the session | `src/lib/session.ts`, `src/app/api/businesses/[id]/route.ts` |
| C2 Open SMS relay | Fixed (A, B) | `kind`/`consent_basis` server-fixed, recipient validation + country allow-list, payment link built server-side for the booking's own number | `src/app/api/sms/send/route.ts`, `src/app/api/sms/payment-link/route.ts`, `src/lib/messaging/recipient.ts`, `tests/sms-recipient.test.ts` |
| C3 Unauthenticated DB wipe | Fixed (A) | 404 unless `DEMO_MODE=true`; compose forces `false`, deploy.sh refuses `true` | `src/app/api/demo/reset/route.ts`, `compose.production.yaml`, `deploy.sh` |
| C4 Paid calls anyone can trigger | Fixed (A, B, F) | auth + billing gate (`assertProvisioningAllowed`), rate limits, provisioning lease. F: a failed number purchase no longer stores a fake number and goes live | `src/app/api/businesses/[id]/provision/route.ts`, `tests/integration/provision-numbers.test.ts` |
| C5 SSRF | Fixed (A) | see 00 #4 | `src/lib/net/safe-fetch.ts` |
| H1 Voice webhooks unauthenticated | Fixed (A, B) | tool secret header, HMAC on post-call, tenant checks on call ids | `src/app/api/voice/tools/[tool]/route.ts`, `src/app/api/voice/post-call/route.ts`, `tests/integration/voice-tools.test.ts` |
| H2 Stripe webhook | Fixed (A, B) | secret mandatory (compose/deploy.sh), metadata on links, `restrictions[completed_sessions][limit]=1`, DB event claims, any matching `v1` accepted | `src/lib/providers/stripe.ts`, `src/app/api/payments/webhook/route.ts`, `tests/integration/stripe-webhook.test.ts` |
| H3 Twilio validation / shared line | Fixed (A), Documented | signature check, no "first business" fallback. One shared `ELEVENLABS_PHONE_NUMBER_ID` binding remains an operator step | `src/app/api/voice/incoming/route.ts`, `docs/known-limitations.md` |
| H4 Tenant unresolvable in tools | Fixed (A, B) | conversation-initiation webhook injects tenant/call ids; tenant derived from the agent id | `src/app/api/voice/initiation/route.ts`, `src/lib/voice/tools.ts` |
| H5 Prompt injection reaches SMS tools | Fixed (A, B) | recipient is only the call's verified caller or the owner; scraped text is wrapped as `untrusted_data` | `src/lib/voice/tools.ts` (`sendSmsTool`), `src/lib/kb/index.ts` |
| M1 Call correlation | Fixed (A, B) | `conversation_id` / `call_sid` unique keys | `prisma/schema.prisma` (`Call`), migration `20261124120000_...call_keys...` |
| M2 Post-call payload shape | Fixed (A) | parses `{type, data:{...}}` | `src/lib/voice/postcall.ts` |
| M3 Time zone / double booking | Fixed (A) | see 00 #5 | `src/lib/availability.ts`, migration `20261123120000_...` |
| M4 SMS dedupe, gratitude, scheduler | Fixed (A, B, F) | booking-keyed dedupe + inbound webhook (`/api/sms/inbound`) in A/B; the sweep is now run hourly by a leased job runner (F). The dedupe remains check-then-send inside a 2-minute window rather than an insert-first unique intent row | `src/lib/messaging/actions.ts`, `src/app/api/sms/inbound/route.ts`, `src/lib/jobs/index.ts`, `tests/integration/jobs.test.ts` |
| M5 Fake checkout in production | Fixed (A) | Stripe failure throws in production; mock only outside it | `src/lib/providers/stripe.ts` (`link.fallback_to_mock` is non-production) |
| M6 Shared tools / duplicated agents | Fixed (A, B) | tools matched by name AND url, per-business provisioning lease | `src/lib/voice/elevenlabs.ts` (`findToolByName`), `src/lib/db/locks.ts` |
| M7 No outbound timeouts | Fixed (A) | `AbortSignal.timeout` on LLM, Twilio, Stripe calls | `src/lib/providers/llm.ts`, `src/lib/providers/stripe.ts`, `src/lib/providers/twilio.ts` |
| L1 PII in logs | Partly | secret-looking keys are redacted; phone numbers still appear at `info` and the mock-mode SMS body is printed (mock mode only) | `src/lib/log.ts`, `src/lib/providers/twilio.ts` |
| L2 Internal errors to clients | Fixed (A) | 5xx answer `internal error` | `src/lib/http.ts` |
| L3 Unvalidated `date` | Fixed (A) | `isDateKey` before any key/path use | `src/lib/briefing/index.ts`, `src/app/api/briefings/generate/route.ts` |
| L4 Mock detection by substring | Partly (F) | now one regex helper `isMockPoolNumber` (`+1<area>555xxxx`) used by provisioning and onboarding-status; still derived from the number, there is no stored flag | `src/lib/providers/twilio.ts` |
| L5 Phone-id guidance | Partly | docs and the boot check say `phnum_...`; a code comment in `bindPhoneNumber` still says "UUID" | `src/instrumentation.ts`, `docs/env-vars.md` |
| L6 Security headers | Fixed (A, C) | HSTS etc. in `next.config.ts`, per-request nonce CSP in the proxy | `next.config.ts`, `src/lib/csp.ts`, `docs/security-headers.md` |
| L7 Bought numbers never configured | Documented | operator imports the number into ElevenLabs | `docs/known-limitations.md`, `docs/runbook.md` |
| L8 Duplicate webhook routes | Fixed (A) | `/api/voice/webhook` is a documented alias of `/api/voice/post-call` (same handler and auth) | `src/app/api/voice/webhook/route.ts` |

## 02 Data layer and logic

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| H1 Slots in server time | Fixed (A) | `lib/time.ts` per-business zone everywhere | `src/lib/time.ts`, `src/lib/scheduler.ts`, `tests/time.test.ts` |
| H2 Double booking | Fixed (A) | gist exclusion constraint + overlap check inside a transaction; cancelled bookings do not block | `prisma/migrations/20261123120000_...`, `src/lib/db/index.ts`, `tests/integration/booking.test.ts` |
| H3 `isWithinHours` no-op | Fixed (A) | `validateSlot` on the requested interval | `src/lib/availability.ts`, `tests/availability.test.ts` |
| H4 LLM date parsing, no "now" | Fixed (A) | `parseScheduledAt`, dynamic date/zone variables for the agent | `src/lib/time.ts` (`parseScheduledAt`, `nowVariables`) |
| H5 "Owner notified" lies | Fixed (A) | `notified` only when the text really went out | `src/lib/voice/owner-alert.ts` |
| H6 Deposits / units | Fixed (A) | integer cents, `markDepositPaid`, one money module | `src/lib/money.ts`, `src/lib/db/index.ts`, `tests/money.test.ts` |
| M1 Extraction SSRF / size cap | Fixed (A) | see 01 C5 | `src/lib/net/safe-fetch.ts` |
| M2 Scraped text in the prompt | Fixed (A) | `untrusted_data` wrapping | `src/lib/kb/index.ts` |
| M3 `send_sms` any text/number | Fixed (A, B) | see 01 H5 | `src/lib/voice/tools.ts` |
| M4 Briefing day bucketing | Fixed (A) | one local-day range in SQL in the business zone | `src/lib/briefing/index.ts` (`gather`) |
| M5 `dayRange` UTC-5 | Fixed (A) | DST-correct `dayRange` | `src/lib/time.ts` |
| M6 `activeCall` wrong call | Fixed (A, B) | keyed on call id / sid / conversation id, tenant-checked | `src/lib/voice/tools.ts` (`activeCall`) |
| M7 Swallowed tool errors | Fixed (A) | `toolFailure` logs the cause | `src/lib/voice/tools.ts` |
| M8 Price validation | Fixed (A) | `dollarsToCents` | `src/lib/money.ts` |
| M9 Duplicate confirmation SMS | Partly | booking-keyed dedupe in a 2-minute window, still check-then-send (no unique intent row) | `src/lib/messaging/actions.ts` |
| M10 KB upsert clobbers | Fixed (A) | only defined fields are written | `src/lib/db/index.ts` (`upsertKnowledgeBase`) |
| M11 `updateX` swallow errors | Partly | still returns `null`, but the failure is now logged (`business.update_failed`) | `src/lib/db/index.ts` |
| M12 Inbound lookup scan | Fixed (A, C) | indexed `phone_key` / `phone_e164` | `prisma/schema.prisma` (`@@index([phoneKey])`, `@@index([phoneE164])`) |
| M13 Extraction hours parsing | Not re-verified | no change was made or traced in this pass | |
| M14 LLM adapter robustness | Partly | timeouts and fenced-JSON parsing exist; not otherwise re-audited | `src/lib/providers/llm.ts` |
| M15 Briefing persona / path | Partly | date validated (`isDateKey`). The prompt and the fallback script still hard-code a Miami HVAC persona and the name "Jorge" when the owner name is unset | `src/lib/briefing/index.ts` |
| M16 Demo seed frozen | Fixed (A) | evaluated per call in the demo zone | `src/lib/demo/seed-data.ts` |
| M17 Scripts/tests destructive | Fixed (A, B) | `scripts/_safe-db.ts` (whole-token name match), a real suite, DB tests gated on a scratch DB | `scripts/_safe-db.ts`, `tests/helpers/preload.ts`, `docs/testing.md` |
| L1 Free-form enums | Partly | CHECK constraints were added for several columns in the accounts/billing migration; not every enum column | `prisma/migrations/20261125120000_accounts_billing_e164_constraints` |
| L2 Whole-file `any` | Open | `db/index.ts` still disables `no-explicit-any` | `src/lib/db/index.ts` |
| L3 Missing indexes | Partly | indexes added for opt-outs, owner phone, consent basis; `sms_log.booking_id` still has no FK | `prisma/migrations/20261126120000_...` |
| L4 Unbounded lists | Open | list helpers (`listCalls`, `listBookings`, `listSms`, `listBusinesses`) are still unpaginated; the hourly gratitude sweep reads one business's bookings and texts per pass | `src/lib/db/index.ts` |
| L5 `checkAvailability` queries | Fixed (A) | one ranged query | `src/lib/scheduler.ts` |
| L6 `format.ts` | Partly | `whenET` and money now use the zone/cents helpers; not every quirk listed was re-checked | `src/lib/format.ts` |
| L7 `log.ts` | Open | redaction is still key-name based | `src/lib/log.ts` |
| L8 HVAC coupling | Open | the prompt checks and templates remain HVAC-specific | `src/lib/kb/index.ts` |
| L9 Dead code | Partly | `DEFAULT_HOURS_EXPORT` is still exported "for older imports" | `src/lib/db/index.ts` |
| L10 `tools.ts` conventions | Fixed (A, B) | tenant no longer taken from the model | `src/lib/voice/tools.ts` |
| L11 Migration housekeeping | Info | | |
| DRY 1-10 | Partly | one time module (`lib/time.ts`) and one money module exist; `TOOL_NAMES` is still declared in both `kb/index.ts` and `voice/tools.ts`; mappers and `provisionBusiness` extraction not done | `src/lib/time.ts`, `src/lib/money.ts` |

## 03 Frontend and UX

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| 1 Dashboard no auth / single tenant | Fixed (B) | per-tenant auth and context | `src/lib/dashboard-context.ts`, `src/app/dashboard/layout.tsx` |
| 2 Onboarding/landing tenant leaks | Fixed (B, C) | onboarding scoped to the caller's own business; landing page has no tenant metrics | `src/app/onboarding/layout.tsx`, `src/app/page.tsx` |
| 3 Mock payment never records | Fixed (A) | mock completion reads the amount from the DB, `DEMO_MODE` only | `src/app/api/pay/mock-complete/route.ts` |
| 4 Pay page trusts the URL | Fixed (A) | amounts come from the booking row | `src/app/pay/[id]/page.tsx` |
| 5 Prefilled test card | Fixed (A) | no prefilled card values remain in `src/app` | `src/app/pay/[id]` |
| 6 Onboarding hard-codes demo values | Fixed (C) | only a placeholder remains | `src/app/onboarding/step-verify.tsx` |
| 7 Onboarding no recovery | Fixed (C, F) | state derived from the database (`onboarding-status`); F adds the partial-provisioning state and retry guidance | `src/app/api/businesses/[id]/onboarding-status/route.ts`, `src/app/onboarding/step-provision.tsx` |
| 8 loading/error/not-found | Fixed (A, C) | present | `src/app/loading.tsx`, `src/app/error.tsx`, `src/app/dashboard/loading.tsx`, `src/app/dashboard/error.tsx` |
| 9 Today page time bugs | Not re-verified | the zone module replaced the ad-hoc code; this page was not re-audited | |
| 10 Mislabelled stats | Not re-verified | | |
| 11 Phone display / env bug | Not re-verified | | |
| 12 VoicePlayer a11y | Fixed (C) | `aria-pressed`, progress label | `src/components/ui/audio.tsx` |
| 13 No mobile nav | Fixed (C) | `#mobile-nav` disclosure | `src/components/dashboard/shell.tsx` |
| 14 Knowledge editor state | Fixed (C) | state follows props | `src/components/dashboard/knowledge-editor.tsx` |
| 15 A11y basics | Partly | not exhaustively re-audited | |
| 16 DRY / 17 tokens / 18 `Button` client | Open | not addressed | |
| 19 Unused deps | Fixed (A) | `lucide-react` is not in `package.json` | `package.json` |
| 20 `next.config.ts` personal domain | Fixed (A) | `ALLOWED_DEV_ORIGINS` env | `next.config.ts` |
| 21 Metadata / noindex | Partly | `viewport` + `themeColor` set, some page titles; no site-wide `noindex` on the dashboard was found | `src/app/layout.tsx` |
| 22 Landing claims | Fixed (F), Partly | "a short voice briefing each evening" is now backed by the 18:00 job; hours/settings editing exists (`src/app/dashboard/settings/page.tsx`) | `src/lib/jobs/index.ts` |
| 23 Hydration/Date | Not re-verified | | |
| UX 1 Thin onboarding | Fixed (C) | connect step with forwarding instructions | `src/app/onboarding/step-connect.tsx` |
| UX 2 Cannot correct what she learned | Fixed (C) | review step edits | `src/app/onboarding/step-review.tsx` |
| UX 3 No money flow in demo | Fixed (A) | `DEMO_MODE` mock checkout completes and records the deposit | `src/app/api/pay/mock-complete/route.ts` |
| UX 4 No operational controls | Partly | settings page (retention, disclosure, time zone); no pause/forward switch | `src/app/dashboard/settings/page.tsx` |
| UX 5 Calendar is a list | Open | `bookings/page.tsx` is still a list titled "Calendar" | `src/app/dashboard/bookings/page.tsx` |
| UX 6 Bilingual UI | Open | dashboard is English-only (`docs/known-limitations.md`: English and Spanish for agent/texts/UI) | |
| UX 7 Copy/branding | Not re-verified | | |
| UX 8 Consent notice / privacy policy | Fixed (B), Documented | recording disclosure shipped; publishing a privacy policy and terms is the operator's task | `docs/compliance.md` |

## 04 Docs, deploy and product

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| Top 1-3 (auth, open endpoints, voice) | Fixed (A, B) | see 00 and 01 | |
| Top 4 Stripe fail-open | Fixed (A) | `${STRIPE_WEBHOOK_SECRET:?}` in compose, deploy.sh check | `compose.production.yaml`, `deploy.sh` |
| Top 5 SSRF | Fixed (A) | | `src/lib/net/safe-fetch.ts` |
| Top 6 Quick start | Fixed (A) | `.env.example` has `DATABASE_URL`; README says Prisma reads `.env` | `.env.example`, `README.md` |
| Top 7 PRD overstates | Fixed (A-F) | PRD reconciled; consent/STOP/disclosure shipped; the 6 PM briefing and gratitude timer shipped in F; calendar grid still open (03 UX 5) | `PRD.md` |
| Top 8 Legal exposure | Fixed (B), Documented | `docs/compliance.md` | |
| Top 9 Deploy operations | Fixed (A) | `deploy.sh` dies on an unhealthy app, takes a pre-migrate `pg_dump`, `--seed` needs `--i-know-this-wipes-data` | `deploy.sh` |
| Top 10 Repo hygiene | Fixed (A) | `.github/workflows/ci.yml` and `.github/dependabot.yml` exist, `package.json` has `test`, `LICENSE` exists. The review's "No `.github/`, so no CI" is stale | `.github/workflows/ci.yml`, `package.json`, `LICENSE` |
| PRD table: briefing at 6 PM (FR-3.1) | Fixed (F) | per-business-zone job, idempotent, billing-gated | `src/lib/jobs/index.ts`, `tests/integration/jobs.test.ts` |
| PRD table: 24h gratitude (FR-4.1) | Fixed (F) | hourly sweep job | `src/lib/jobs/index.ts` |
| PRD table: phone provisioning (FR-1.3) | Fixed (F), Documented | no fake number in production; US-only/305 documented | `src/lib/providers/twilio.ts`, `docs/known-limitations.md` |
| PRD table: guardrail 911 / recording consent | Fixed (B) | prompt rules + disclosure | `docs/compliance.md` |
| PRD table: calendar grid, owner voice reply, live transcript, Google Calendar | Open / by design | unchanged | |
| PRD table: settings panel, `paused` status | Partly | settings page exists; `paused` is set by tenant release (`clearBusinessProviderResources`) | `src/lib/db/index.ts` |
| PRD table: Supabase / Next 14 / env block | Fixed (A) | PRD states Postgres + Prisma, Next 16 | `PRD.md` |
| Doc-accuracy table (README quick start, DEPLOY backup/pointing providers/hardening, `.env.example` drift, CONTRACTS route table) | Fixed (A, B) for the items checked: quick start, backup command (`exec -T db sh -c`), `LOG_LEVEL` commented out, tools image `USER node`; not every row re-verified | `README.md`, `DEPLOY.md`, `.env.example`, `Dockerfile` |
| Deploy table (digests, Traefik rate limit, `.env` sourcing, `check-elevenlabs-key.sh` path) | Partly | images pinned by digest; no Traefik rate-limit middleware in compose; `deploy.sh` still sources `.env` with `set -a; . ./.env` (values must be shell-safe); `check-elevenlabs-key.sh` no longer hard-codes `/Users/yorch` | `Dockerfile`, `compose.production.yaml`, `deploy.sh` |

## 05 Adversarial review of the remediation branch

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| B1 `next build` fails | Fixed (A) | `normalizeUrl` lives in a client-safe module; CI now runs `next build` | `src/lib/extraction/url.ts`, `.github/workflows/ci.yml` |
| H1 `/api/voice/agent-prompt` public | Fixed (A) | owner+, own business | `src/app/api/voice/agent-prompt/route.ts` |
| H2 Env agent id cross-tenant | Fixed (A) | only for a single-business install | `src/lib/voice/elevenlabs.ts` (`resolveAgentIdFor`) |
| H3 SMS recipient bypass | Fixed (A, B) | recipient rules shared by every text path | `src/lib/messaging/recipient.ts`, `src/lib/voice/tools.ts` |
| H4 Auth open outside production | Fixed (A) | `insecureDevAllowed()` needs an explicit flag and is ignored in production | `src/lib/auth.ts` |
| M1 Proxy extension exemption | Fixed (A) | matcher excludes only static assets | `src/proxy.ts`, `tests/proxy-decisions.test.ts` |
| M2 Open redirect | Fixed (A) | | `src/lib/safe-redirect.ts`, `tests/safe-redirect.test.ts` |
| M3 Duration mismatch | Fixed (A) | `clampDuration` + one interval model | `src/lib/availability.ts` |
| M4 Prod deploy w/o ElevenLabs secrets | Fixed (A) | deploy.sh enforces them when the key is set | `deploy.sh` |
| M5 Spoofable login limiter key | Fixed (A, B) | trusted-proxy aware client key, per-(account, IP) backoff | `src/lib/auth.ts` (`clientKey`), `src/lib/login-throttle.ts` |
| L1 `/` leaks tenant metrics | Fixed (B) | | `src/app/page.tsx` |
| L2 `/pay` ids predictable | Partly | mock completion is `DEMO_MODE` only; the page still shows booking details to anyone with the id | `src/app/api/pay/mock-complete/route.ts` |
| L3 `.env.example` drift | Fixed (A) | `STRIPE_ALLOW_UNSIGNED=true` | `.env.example` |
| L4 Stripe dedupe in memory | Fixed (B) | `processed_events` claims | `src/lib/db/events.ts` |
| L5 Payment-link minimum | Fixed (A) | `MIN_CENTS = 100` and a below-minimum re-ask | `src/app/api/payments/create-link/route.ts`, `src/lib/voice/tools.ts` |
| L6 IPv6 ranges | Fixed (A) | SIIT and local-use NAT64 rejected | `src/lib/net/ip-shape.ts` |
| L7 Sessions never expire | Fixed (B) | admin cookie is an opaque DB session, 12 h, revocable | `src/lib/session.ts`, `src/app/api/auth/revoke-admin-sessions/route.ts` |
| L8 CSRF only SameSite | Fixed (B) | same-origin check on cookie-authenticated writes | `src/lib/session.ts`, `src/proxy.ts` |
| L9 Post-call 400 for foreign agents | Fixed (B) | answered `200 {ignored}` | `src/lib/voice/postcall.ts` |
| L10 `gratitude-reply` vs real Twilio | Fixed (B) | `/api/sms/inbound` is the one inbound URL; the legacy route still honours STOP | `src/app/api/sms/inbound/route.ts`, `DEPLOY.md` |
| L11 CI only on PRs, no build | Partly | `next build` now runs in CI; the trigger is still `pull_request` only | `.github/workflows/ci.yml` |

## 06 Adversarial review, round 2

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| H1 Declined recording still stored | Fixed (B) | sticky decline, metadata-only | `src/lib/voice/postcall.ts`, `tests/integration/review2.test.ts` |
| H2 Caller id dropped | Fixed (B) | texts go to the platform-reported caller id | `src/lib/voice/tools.ts` (`verifiedCaller`) |
| H3 Junk logins lock tenants | Fixed (B) | failure backoff per (account, IP); account-wide counter only alerts | `src/lib/login-throttle.ts` |
| M1 Opt-out bypass via owner phone | Fixed (B, D) | owner alerts only to a verified phone; opt-out repair | `src/lib/messaging/owner.ts`, `tests/compliance-owner-policy.test.ts` |
| M2 Arbitrary free text to any number | Fixed (B) | | `src/app/api/sms/payment-link/route.ts` |
| M3 Erasure/export misses PII | Fixed (B) | | `src/lib/db/compliance.ts`, `src/lib/privacy.ts`, `tests/compliance-db.test.ts` |
| M4 Retention deletes on first boot | Fixed (B), unchanged in F | OFF by default, preview log, dry-run endpoint, audio files purged; now driven by the shared runner with the same default | `src/lib/retention-job.ts`, `src/lib/jobs/index.ts` |
| M5 STOP not received | Fixed (B), Documented | `/api/sms/inbound` + FCC wording; Twilio-side opt-out limits documented | `src/lib/messaging/keywords.ts`, `docs/known-limitations.md` |
| M6 Disclosure not validated | Fixed (B) | | `src/lib/kb/disclosure.ts` |
| L1 `_safe-db` bypasses | Fixed (B) | whole-token regex, flag passed from deploy.sh | `scripts/_safe-db.ts`, `tests/safe-db.test.ts` |
| L2 `withStopFooter` | Fixed (B), Fixed (F) tests | code-point cut, ASCII `...`, segment budget; F adds emoji/unicode footer tests | `src/lib/messaging/policy.ts`, `tests/sms-metering.test.ts` |
| L3 `claimEvent` loses events | Fixed (B) | `processing`/`done` claims with a lease | `src/lib/db/events.ts` |
| L4 `withLease` lost lease | Fixed (B) | `AbortSignal` checked before paid steps | `src/lib/db/locks.ts`, `src/app/api/businesses/[id]/provision/route.ts` |
| L5 DB tests skip silently | Fixed (B) | preload throws when `CI` is set without `TEST_DATABASE_URL` | `tests/helpers/preload.ts` |
| L6 Migration locks / rollback | Documented | forward-only; restore a backup | `docs/known-limitations.md`, `docs/runbook.md` |
| L7 Staff can read the prompt | Fixed (B) | prompt blanked for staff | `src/app/api/businesses/[id]/route.ts` |
| L8 Still open | Partly | admin cookie now a DB session; the briefing audio route is authenticated; `GET /api/voice/incoming`/"first tenant" fallback was not traced again | `src/lib/session.ts`, `src/app/api/briefings/audio/[name]/route.ts` |
| L9 Docs drift | Fixed (B) | retention and inbound URL are in README/DEPLOY | `README.md`, `DEPLOY.md` |
| L10 Decline reply asks for data | Open | `tools.ts` still asks "Is this the best number to reach you?" in the callback reply | `src/lib/voice/tools.ts` |

## 07 Adversarial review, round 3

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| B1 Open signup + billing off | Fixed (D, E) | production fails closed (`BILLING_ENFORCED` unset = enforced), non-admin provisioning always needs a plan, captcha required for open signup | `src/lib/db/usage.ts` (`billingEnforced`, `isProvisioningAllowed`), `deploy.sh`, `docs/billing.md` |
| H1 Owner gets the webhook secret | Fixed (D) | only an admin creates the webhook and sees the secret | `src/app/api/businesses/[id]/provision/route.ts`, `tests/integration/review3-fixes.test.ts` |
| H2 Verification as SMS relay | Fixed (D) | per-user/IP/number/business and platform-wide caps | `src/lib/messaging/verify-limits.ts` |
| H3 `+52` opt-outs reassigned | Fixed (D) | E.164 opt-out repair migration | `prisma/migrations/20261126120000_review3_optout_repair_trials_indexes` |
| M1 Malleable owner-phone challenge | Fixed (D) | | `src/lib/messaging/owner-verify.ts` |
| M2 Switch signup off with 30 requests | Fixed (D) | only accounts actually created count toward the cap | `src/lib/signup.ts` |
| M3 Turnstile blocked by CSP | Fixed (D) | CSP allows `challenges.cloudflare.com` when configured | `src/lib/csp.ts` |
| M4 Pre-account squatting | Fixed (D) | | `src/lib/account-flows.ts` |
| M5 TOTP brute force | Fixed (D), Documented | per-pending-session limits; account-wide guessing only alerts | `src/lib/mfa.ts`, `docs/known-limitations.md` |
| M6 Over cap still answers 15 minutes | Fixed (D) | capacity gate + initiation override; the cap is not enforced mid-call (documented) | `src/lib/voice/capacity.ts`, `docs/known-limitations.md` |
| L1 Unlimited trials | Fixed (D), Documented | card and email fingerprints; many distinct cards still pass | `src/lib/billing/trial.ts`, `docs/known-limitations.md` |
| L2 Invite phishing text | Fixed (D) | name is quoted and truncated | `src/lib/email/templates.ts` |

## Findings from the later PRD audit (this pass, area F)

These were not in the original reviews; they came from auditing `PRD.md` against the code.

| Defect | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| Fake `+1<area>555xxxx` number stored and the business set `live` when the Twilio purchase failed | Fixed (F) | purchase failure (or production without Twilio) is a 502/503, status stays `onboarding`, audited, idempotent; the mock number exists only outside production with no Twilio credentials; an ambiguous purchase answer is reconciled against the account | `src/lib/providers/twilio.ts`, `src/app/api/businesses/[id]/provision/route.ts`, `tests/integration/provision-numbers.test.ts` |
| Number bought, then agent/webhook step failed: number lost, business shown live | Fixed (F) | number recorded immediately, status stays `onboarding`, 502 with `partial`, `onboarding-status.provision_partial`, retry reuses it (one purchase total) | same files |
| 6 PM briefing had no timer | Fixed (F) | `daily_briefing` job, per business zone, once per local day, billing/quiet-hours/cap gated | `src/lib/jobs/index.ts`, `src/lib/jobs/schedule.ts`, `tests/jobs-schedule.test.ts`, `tests/integration/jobs.test.ts` |
| Gratitude sweep had no timer | Fixed (F) | hourly job, per-business lease and hour claim, quiet hours skipped, bounded per pass | same files |
| Expired sessions/tokens/events/rate-limit rows only cleaned opportunistically | Fixed (F) | hourly `cleanup` job | `src/lib/jobs/index.ts` |
| Retention job was a separate timer | Fixed (F) | part of the same runner; still OFF unless `RETENTION_JOB=on` | `src/lib/retention-job.ts`, `src/lib/jobs/index.ts` |
| Caps counted one unit per send, not per SMS segment | Fixed (F) | real GSM-7/UCS-2 segments, a text that would exceed the cap is blocked, billing page says "segments" | `src/lib/messaging/index.ts`, `src/lib/db/usage.ts`, `tests/sms-metering.test.ts`, `tests/integration/sms-metering.test.ts` |
| No lower cap for trials | Fixed (F) | `TRIAL_SMS_CAP` (50) / `TRIAL_CALL_MINUTES_CAP` (30), admin overrides win | `src/lib/db/usage.ts` |
| Docs claimed an in-process scheduler that did not exist | Fixed (F) | `docs/known-limitations.md`, README, DEPLOY, runbook describe the real runner | |
