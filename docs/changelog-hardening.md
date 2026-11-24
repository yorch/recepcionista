# Hardening changelog: what changed since the original reviews

`docs/review/00-07` are point-in-time snapshots of the code as it was when each review was written. They are left unedited on purpose, so some of their
statements ("no CI", "nothing schedules the briefing", "the app has no authentication") are **no longer true**. This file maps every finding id to where it stands now.
Each row was checked against the current tree (file, test or doc named in the Evidence column), not copied from a commit message. Where a finding is only partly addressed, or not
addressed, the row says so.

Area G adds migration `20261127120000_call_mode_forwarding` (call mode columns, enum CHECKs, `sms_log` foreign key). Area H (round-4 fixes, `docs/review/08`) adds `20261128120000_review4_jobs_status_index` (index on `businesses.status`).

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
| F | previous hardening pass | provisioning fails loudly (no fake numbers) and is resumable, the background job runner (6 PM briefing, gratitude sweep, cleanup, retention), SMS metering in segments + trial caps |

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
| Recommended order, Phase 3 (UX/DRY) | Fixed (G), Documented | calendar grid, pause/forward switch, pagination, hydration, noindex done; remaining cosmetic refactors are in `docs/known-limitations.md` | `src/components/calendar/`, `docs/known-limitations.md` |

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
| L1 PII in logs | Fixed (G) | value-based scrubbing: phone numbers keep the last four digits, emails the first letter, credentials always masked (`LOG_PII=true` unmasks phone/email for debugging); mock SMS bodies are echoed only outside production or in demo mode | `src/lib/log.ts` (`scrub`), `src/lib/providers/twilio.ts`, `tests/hardening-pure.test.ts` |
| L2 Internal errors to clients | Fixed (A) | 5xx answer `internal error` | `src/lib/http.ts` |
| L3 Unvalidated `date` | Fixed (A) | `isDateKey` before any key/path use | `src/lib/briefing/index.ts`, `src/app/api/briefings/generate/route.ts` |
| L4 Mock detection by substring | Documented | one regex helper; no stored flag by design (mock numbers exist only outside production without Twilio) | `src/lib/providers/twilio.ts`, `docs/known-limitations.md` |
| L5 Phone-id guidance | Fixed (G) | the `bindPhoneNumber` comment now says `phnum_...` like the docs and the boot check | `src/lib/voice/elevenlabs.ts` |
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
| M9 Duplicate confirmation SMS | Fixed (G) | an atomic `processed_events` claim per booking serialises senders, plus the 2-minute recent-send lookup; 6 concurrent resends send one text | `src/lib/messaging/actions.ts`, `tests/integration/calendar.test.ts` |
| M10 KB upsert clobbers | Fixed (A) | only defined fields are written | `src/lib/db/index.ts` (`upsertKnowledgeBase`) |
| M11 `updateX` swallow errors | Fixed (G) | `null` only for "no such row" (P2025); any other failure is logged and thrown | `src/lib/db/index.ts`, `tests/integration/calendar.test.ts` |
| M12 Inbound lookup scan | Fixed (A, C) | indexed `phone_key` / `phone_e164` | `prisma/schema.prisma` (`@@index([phoneKey])`, `@@index([phoneE164])`) |
| M13 Extraction hours parsing | Fixed (G) | `parseClock` / `sanitizeHours`: 12h am/pm (the old `slice(0,5)` read "5:00 PM" as 05:00), noon/midnight, case-insensitive day keys, open<close enforced, always seven days | `src/lib/extraction/index.ts`, `tests/hardening-pure.test.ts` |
| M14 LLM adapter robustness | Fixed (G) | balanced-bracket JSON extraction (prose and stray brackets), one bounded retry on 429/5xx/network, error bodies clipped to 200 chars | `src/lib/providers/llm.ts`, `tests/hardening-pure.test.ts` |
| M15 Briefing persona / path | Fixed (G) | prompt uses the business name; no hard-coded persona or owner name ("Hola." when unset) | `src/lib/briefing/index.ts` |
| M16 Demo seed frozen | Fixed (A) | evaluated per call in the demo zone | `src/lib/demo/seed-data.ts` |
| M17 Scripts/tests destructive | Fixed (A, B) | `scripts/_safe-db.ts` (whole-token name match), a real suite, DB tests gated on a scratch DB | `scripts/_safe-db.ts`, `tests/helpers/preload.ts`, `docs/testing.md` |
| L1 Free-form enums | Fixed (G) | CHECKs for business/call/booking status, call urgency and sms kind/status, validated, legacy values normalised first | `prisma/migrations/20261127120000_call_mode_forwarding`, `tests/db/migration.test.ts` |
| L2 Whole-file `any` | Fixed (G) | mappers typed with Prisma row types and `Prisma.*UpdateInput`; the file-level eslint-disable is gone | `src/lib/db/index.ts` |
| L3 Missing indexes | Fixed (G) | `sms_log.booking_id` has an index and a foreign key (`ON DELETE SET NULL`, dangling ids cleared) | `prisma/migrations/20261127120000_call_mode_forwarding` |
| L4 Unbounded lists | Fixed (G) | every list helper is bounded; keyset pagination (`listCallsPage`, `listBookingsPage`, `listBookingsInRange`, `listBriefingsPage`, `listSmsPage`, `listBusinessesPage`, audit) with "Load more" on Calls, Agenda and Briefings; Today uses SQL aggregates; the gratitude sweep reads only the 20-48 h window | `src/lib/db/index.ts`, `src/lib/db/paging.ts`, `tests/integration/calendar.test.ts` |
| L5 `checkAvailability` queries | Fixed (A) | one ranged query | `src/lib/scheduler.ts` |
| L6 `format.ts` | Fixed (G) | injected clock for `relative`, `dayLabelET` for "Today/Tomorrow" in the business zone, tests | `src/lib/format.ts`, `tests/hardening-pure.test.ts` |
| L7 `log.ts` | Fixed (G) | redaction is also value based (see L1 above) | `src/lib/log.ts` |
| L8 HVAC coupling | Documented | deliberate product focus | `docs/known-limitations.md` |
| L9 Dead code | Fixed (G) | `DEFAULT_HOURS_EXPORT` removed | `src/lib/db/index.ts` |
| L10 `tools.ts` conventions | Fixed (A, B) | tenant no longer taken from the model | `src/lib/voice/tools.ts` |
| L11 Migration housekeeping | Info | | |
| DRY 1-10 | Fixed (G), Documented | one `TOOL_NAMES`, typed mappers, one time and money module; extracting `provisionBusiness` is a documented non-goal | `src/lib/kb/index.ts`, `docs/known-limitations.md` |

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
| 9 Today page time bugs | Fixed (G) | counts by the business's local day/month in SQL, `dayLabelET` instead of splitting a label, one clock read | `src/app/dashboard/page.tsx`, `src/lib/db/index.ts` (`getDashboardStats`), `tests/integration/calendar.test.ts` |
| 10 Mislabelled stats | Fixed (G) | "Deposits: paid, jobs this month", "Needs you: flagged, last 7 days", bilingual counts today's calls | `src/app/dashboard/page.tsx` |
| 11 Phone display / env bug | Fixed (G) | the number comes from the server layout (`biz.phone`), no `NEXT_PUBLIC_` phone var remains, `tel:` links are only rendered with a value | `src/components/dashboard/shell.tsx` |
| 12 VoicePlayer a11y | Fixed (C) | `aria-pressed`, progress label | `src/components/ui/audio.tsx` |
| 13 No mobile nav | Fixed (C) | `#mobile-nav` disclosure | `src/components/dashboard/shell.tsx` |
| 14 Knowledge editor state | Fixed (C) | state follows props | `src/components/dashboard/knowledge-editor.tsx` |
| 15 A11y basics | Documented | focus ring, skip link, `aria-current`, labelled nav exist; the calendar adds roles, labels, arrow-key navigation, focus return and status icons. No automated audit in CI | `src/components/calendar/`, `docs/known-limitations.md` |
| 16 DRY / 17 tokens / 18 `Button` client | Fixed (G), Documented | `Button` is server-compatible; new UI uses tokens; remaining raw hex is a documented cosmetic non-goal | `src/components/ui/button.tsx` |
| 19 Unused deps | Fixed (A) | `lucide-react` is not in `package.json` | `package.json` |
| 20 `next.config.ts` personal domain | Fixed (A) | `ALLOWED_DEV_ORIGINS` env | `next.config.ts` |
| 21 Metadata / noindex | Fixed (G) | dashboard and onboarding are `noindex`; every dashboard page has a title | `src/app/dashboard/layout.tsx`, `src/app/onboarding/layout.tsx` |
| 22 Landing claims | Fixed (F, G) | briefing job, hours editing, and the calendar / pause switch the page now mentions exist | `src/app/page.tsx` |
| 23 Hydration/Date | Fixed (G) | locale-dependent `toLocaleString` in client panels replaced by fixed-locale `utcStamp`/`utcDate`; the calendar reads the clock only after mount | `src/components/dashboard/dates.ts` |
| UX 1 Thin onboarding | Fixed (C) | connect step with forwarding instructions | `src/app/onboarding/step-connect.tsx` |
| UX 2 Cannot correct what she learned | Fixed (C) | review step edits | `src/app/onboarding/step-review.tsx` |
| UX 3 No money flow in demo | Fixed (A) | `DEMO_MODE` mock checkout completes and records the deposit | `src/app/api/pay/mock-complete/route.ts` |
| UX 4 No operational controls | Fixed (G) | pause / forward switch with verified number, schedule and audit | `src/components/dashboard/call-mode.tsx`, `src/lib/voice/call-mode.ts` |
| UX 5 Calendar is a list | Fixed (G) | week/day/month calendar with side panel and owner actions; the list is the Agenda tab | `src/app/dashboard/bookings/page.tsx`, `src/components/calendar/` |
| UX 6 Bilingual UI | Documented | dashboard is English only | `docs/known-limitations.md` |
| UX 7 Copy/branding | Fixed (G) | the "Miami is answering" copy is gone; no persona name is derived from the business name | `src/app/onboarding/` |
| UX 8 Consent notice / privacy policy | Fixed (B), Documented | recording disclosure shipped; publishing a privacy policy and terms is the operator's task | `docs/compliance.md` |

## 04 Docs, deploy and product

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| Top 1-3 (auth, open endpoints, voice) | Fixed (A, B) | see 00 and 01 | |
| Top 4 Stripe fail-open | Fixed (A) | `${STRIPE_WEBHOOK_SECRET:?}` in compose, deploy.sh check | `compose.production.yaml`, `deploy.sh` |
| Top 5 SSRF | Fixed (A) | | `src/lib/net/safe-fetch.ts` |
| Top 6 Quick start | Fixed (A) | `.env.example` has `DATABASE_URL`; README says Prisma reads `.env` | `.env.example`, `README.md` |
| Top 7 PRD overstates | Fixed (A-G) | PRD reconciled; the calendar grid and pause/forward switch shipped in G | `PRD.md` |
| Top 8 Legal exposure | Fixed (B), Documented | `docs/compliance.md` | |
| Top 9 Deploy operations | Fixed (A) | `deploy.sh` dies on an unhealthy app, takes a pre-migrate `pg_dump`, `--seed` needs `--i-know-this-wipes-data` | `deploy.sh` |
| Top 10 Repo hygiene | Fixed (A) | `.github/workflows/ci.yml` and `.github/dependabot.yml` exist, `package.json` has `test`, `LICENSE` exists. The review's "No `.github/`, so no CI" is stale | `.github/workflows/ci.yml`, `package.json`, `LICENSE` |
| PRD table: briefing at 6 PM (FR-3.1) | Fixed (F) | per-business-zone job, idempotent, billing-gated | `src/lib/jobs/index.ts`, `tests/integration/jobs.test.ts` |
| PRD table: 24h gratitude (FR-4.1) | Fixed (F) | hourly sweep job | `src/lib/jobs/index.ts` |
| PRD table: phone provisioning (FR-1.3) | Fixed (F), Documented | no fake number in production; US-only/305 documented | `src/lib/providers/twilio.ts`, `docs/known-limitations.md` |
| PRD table: guardrail 911 / recording consent | Fixed (B) | prompt rules + disclosure | `docs/compliance.md` |
| PRD table: calendar grid, owner voice reply, live transcript, Google Calendar | Fixed (G), Documented | calendar grid shipped; owner voice reply, live transcript and Google Calendar sync are roadmap by owner decision | `docs/known-limitations.md` |
| PRD table: settings panel, `paused` status | Fixed (G) | `call_mode` 'paused' is an owner switch; tenant release still sets `status='paused'` | `src/lib/db/call-mode.ts` |
| PRD table: Supabase / Next 14 / env block | Fixed (A) | PRD states Postgres + Prisma, Next 16 | `PRD.md` |
| Doc-accuracy table (README quick start, DEPLOY backup/pointing providers/hardening, `.env.example` drift, CONTRACTS route table) | Fixed (A, B, G) | quick start, backup command, `LOG_LEVEL`, tools image user verified; CONTRACTS route table extended with the new routes | `README.md`, `DEPLOY.md`, `CONTRACTS.md` |
| Deploy table (digests, Traefik rate limit, `.env` sourcing, `check-elevenlabs-key.sh` path) | Documented | digests pinned, key-check path fixed; no proxy rate-limit middleware and shell-sourced `.env` are documented limits | `docs/known-limitations.md` |

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
| L2 `/pay` ids predictable | Documented | unguessable UUID bearer link by design | `docs/known-limitations.md` |
| L3 `.env.example` drift | Fixed (A) | `STRIPE_ALLOW_UNSIGNED=true` | `.env.example` |
| L4 Stripe dedupe in memory | Fixed (B) | `processed_events` claims | `src/lib/db/events.ts` |
| L5 Payment-link minimum | Fixed (A) | `MIN_CENTS = 100` and a below-minimum re-ask | `src/app/api/payments/create-link/route.ts`, `src/lib/voice/tools.ts` |
| L6 IPv6 ranges | Fixed (A) | SIIT and local-use NAT64 rejected | `src/lib/net/ip-shape.ts` |
| L7 Sessions never expire | Fixed (B) | admin cookie is an opaque DB session, 12 h, revocable | `src/lib/session.ts`, `src/app/api/auth/revoke-admin-sessions/route.ts` |
| L8 CSRF only SameSite | Fixed (B) | same-origin check on cookie-authenticated writes | `src/lib/session.ts`, `src/proxy.ts` |
| L9 Post-call 400 for foreign agents | Fixed (B) | answered `200 {ignored}` | `src/lib/voice/postcall.ts` |
| L10 `gratitude-reply` vs real Twilio | Fixed (B) | `/api/sms/inbound` is the one inbound URL; the legacy route still honours STOP | `src/app/api/sms/inbound/route.ts`, `DEPLOY.md` |
| L11 CI only on PRs, no build | Fixed (G) | CI runs `next build` and also on pushes to `main` | `.github/workflows/ci.yml` |

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
| L8 Still open | Fixed (G) | `GET /api/voice/incoming` answers `{ready:true}` only; an unknown number routes only to a single-business install, never "the first of several" (404 test) | `src/app/api/voice/incoming/route.ts`, `tests/integration/call-mode.test.ts` |
| L9 Docs drift | Fixed (B) | retention and inbound URL are in README/DEPLOY | `README.md`, `DEPLOY.md` |
| L10 Decline reply asks for data | Fixed (G) | handoff confirms the verified caller id ("ending in 0142") and only asks for a number when caller id is withheld; booking only asks for what is missing; prompt and tool schema no longer require a spoken number | `src/lib/voice/tools.ts`, `src/lib/kb/index.ts`, `tests/hardening-pure.test.ts` |

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

## Round 4 review (`docs/review/08-adversarial-review-round-4.md`), area H

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| F1 Failed purchase adopts another tenant's number, then DELETEs it | Fixed (H) | a candidate must be held by no business (any status), not be `TWILIO_PHONE_NUMBER`, and is reserved for this attempt; the attempt is recorded before the purchase and tagged with a per-attempt FriendlyName; adoption needs that tag AND the recorded attempt AND no holder, with backoff for Twilio listing lag; `releaseNumber` refuses any number another business holds (database check, fails closed) and the provision rollback releases only a number THIS call bought; a lost DB race answers 502 `number_taken` and deletes nothing; the `retry` text no longer says "nothing was purchased" when something was. The old test that enshrined the DELETE is rewritten; two-tenant concurrency tests added | `src/lib/providers/twilio.ts`, `src/lib/db/number-attempts.ts`, `src/app/api/businesses/[id]/provision/route.ts`, `tests/integration/provision-numbers.test.ts`, `tests/release-providers.test.ts`, `tests/db/release-tenant.test.ts` |
| F2 SMS cap is check-then-send | Fixed (H) | `reserveSms`: one atomic `INSERT .. ON CONFLICT DO UPDATE .. WHERE used + n <= cap RETURNING`; the reservation is the metering and is refunded when the send fails | `src/lib/db/usage.ts`, `src/lib/messaging/index.ts`, `tests/integration/sms-metering.test.ts` (20 concurrent, cap 5 / used 4: exactly 1 goes out) |
| F3 Cap-exempt owner alerts can be pumped | Fixed (H) | alert text cut to 320 GSM-safe characters, per-field clamps in the tools, identical alerts per call sent once, `OWNER_ALERT_HOURLY_LIMIT` (6) budget separate from the plan cap, the first emergency of a call goes through up to 2x the budget, honest tool results (`notify_failure: rate_limited`) | `src/lib/voice/owner-alert.ts`, `src/lib/voice/tools.ts`, `tests/integration/owner-alerts.test.ts` |
| F4 Canceled tenant that still gets calls is never released | Fixed (H) | recent calls counts only handled calls (not `out_of_service:*`, at least 15 s, or transcript/summary/booking) | `src/lib/billing/release.ts` (`countRecentRealCalls`), `tests/db/release-tenant.test.ts` |
| F5 Platform-number guard compares raw strings | Fixed (H) | E.164 comparison; an unparseable `TWILIO_PHONE_NUMBER` makes releases refuse | `src/lib/providers/twilio.ts` (`isPlatformNumber`), `tests/release-providers.test.ts` |
| F6 Half-configured provider reports mock success on release | Fixed (H) | incomplete Twilio credentials (or production without them) and a real agent id without `ELEVENLABS_API_KEY` return `ok:false`; the database reference is kept | `src/lib/providers/twilio.ts`, `src/lib/voice/elevenlabs.ts` (`deleteAgent`), `tests/release-providers.test.ts`, `tests/db/release-tenant.test.ts` |
| F7 Segment undercount at a two-unit character boundary | Fixed (H) | greedy per-segment packing (GSM extension characters and surrogate pairs are never split) | `src/lib/messaging/policy.ts`, `tests/sms-metering.test.ts` |
| F8 Scheduler re-reads every tenant and history each tick | Fixed (H) | narrow-column, indexed, keyset-paged `listLiveBusinessesForJobs`; after 18:00 two batched lookups for all due tenants; the gratitude sweep already read only the 20-48 h window (area G); a test counts the statements | `src/lib/db/index.ts`, `src/lib/jobs/index.ts`, `src/lib/db/client.ts` (`recordQueries`), `tests/integration/jobs.test.ts`, migration `20261128120000_review4_jobs_status_index` |
| F9 PRD contradicts the job runner | Open (lead) | the stale PRD rows were listed for the lead, who owns `PRD.md`; the claim "PRD reconciled" in 00#9 stays Partly until then | |
| F10 Config inconsistencies | Fixed (H) | `JOBS` accepts the same values in `deploy.sh` and the app; Turnstile verification is demanded only when secret AND site key are set; `TWILIO_AREA_CODE` (default 305) plus the owner phone's own area code per business; env docs, `.env.example`, compose and `deploy.sh` reconciled | `deploy.sh`, `src/lib/signup.ts`, `src/lib/phone.ts`, `docs/env-vars.md`, `tests/phone.test.ts`, `tests/auth-signup-pure.test.ts` |
| Suspicion: Twilio listing lag on reconcile | Fixed (H) | reconcile retries with backoff (about 13 s total) | `tests/integration/provision-numbers.test.ts` |
| Suspicion: jobs ignore a lost lease | Fixed (H) | jobs check the lease before generating, texting and every gratitude send, give the claim back and report `lease_lost` | `src/lib/jobs/index.ts`, `src/lib/gratitude/index.ts`, `tests/integration/jobs.test.ts` |
| Suspicion: no lock around a release | Fixed (H) | release and heads-up run under the provisioning lease `provision:<id>` with facts re-read inside it | `src/lib/billing/release.ts`, `tests/db/release-tenant.test.ts` |
| Suspicion: stale cached tool ids on other instances | Fixed (H) | tool ids expire after 10 minutes and a 4xx on agent create/update flushes them and retries once | `src/lib/voice/elevenlabs.ts`, `tests/integration/stale-tool-ids.test.ts` |
| Suspicion: `completeEvent` never throws | Open | unchanged: a silently failed `done` write lets the claim expire after 10 minutes and the briefing be regenerated once | |
| Suspicion: mock-pool collisions in a dev DB | Documented | surface as `number_record_failed`; development only | |

## Round 5 review (`docs/review/09-adversarial-review-round-5.md`)

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| H1 Owner-phone path bypasses `validateForwardNumber` (Jamaica repro) | Fixed | one rule set (`forwardTarget`/`trustedForwardNumber`) is run by `resolveCallRoute`, `setCallMode`, the owner-phone adoption (PUT and db layer), start/confirm and again before every `<Dial>`; libphonenumber type (premium, shared-cost, personal, UAN, toll-free, pager), explicit NANP deny list (Caribbean, 670/671/684, toll-free, 900/976) extensible with `FORWARD_DENY_AREA_CODES`, any `NXX 976` exchange, any assistant number (any tenant, `TWILIO_PHONE_NUMBER`); a refused stored number gives the voicemail and the flag "Forwarding was refused" | `src/lib/voice/forward-number.ts`, `forward-vet.ts`, `call-mode.ts`, `src/lib/db/call-mode.ts`, `tests/call-mode.test.ts`, `tests/integration/review5.test.ts` (H1 x5) |
| H2 Forwarded minutes unmetered, cap ignored | Fixed | bridged seconds metered once per call (claimEvent) from `<Dial action>` and the new signed `/api/voice/dial-status`, voicemail seconds too; `<Dial timeLimit>` = minutes left (max `FORWARD_MAX_CALL_SECONDS`); cap/trial/lapsed plan/failed check = no forward; per-hour limits for forwards and voicemails | `src/lib/voice/forward-metering.ts`, `src/app/api/voice/{incoming,voicemail,dial-status}/route.ts`, `tests/integration/review5.test.ts` (H2 x5), `tests/integration/call-mode.test.ts` |
| M1 Paused still books / texts / takes deposits on the native path | Fixed | `runTool` refuses every tool except `handoff_to_human` / `flag_emergency` whenever `resolveCallRoute(business, now, 'native')` is not `ai` (same decision as the greeting; after-hours schedule consistent); optional prompt override behind `ELEVENLABS_PAUSED_PROMPT_OVERRIDE` | `src/lib/voice/tools.ts`, `capacity.ts`, `initiation-config.ts`, `tests/integration/review5.test.ts` (M1 x3) |
| M2 Forward never forwards on the native line | Fixed (honest) | `lineKind()`; on the native line Forward is refused (422), disabled with "Forwarding is not available on the AI voice line - callers will hear the paused message", label says so; runbook tables each line and the role of `/api/voice/incoming`; ElevenLabs transfer tool not usable (no documented per-call override) | `src/lib/voice/line.ts`, `call-mode.ts`, `src/components/dashboard/call-mode.tsx`, `docs/runbook.md` section 8, `docs/known-limitations.md` |
| M3 Voicemails invisible; raw recording URL exposed | Fixed | Calls > Voicemails tab; authenticated tenant-scoped proxy `GET /api/calls/:id/voicemail` (server-side Twilio credentials, Range, no-store, audited); `recording_url` stripped from `/api/calls` and the page payload (`has_voicemail`); retention purge and erasure delete the Twilio recording; export lists the playback path | `src/lib/voice/voicemail.ts`, `src/app/api/calls/[id]/voicemail/route.ts`, `src/components/dashboard/voicemail-list.tsx`, `src/lib/db/compliance.ts`, `tests/integration/review5.test.ts` (M3 x3) |
| M4 No step-up, no notification, silent mode change | Fixed | `user_sessions.sudo_at` (migration `20261129120000_review5_session_sudo`, one nullable column) + `POST /api/auth/reauth`; `requireRecentAuth` on switching into paused/forward and on every forward-number set; every transition audited with a reason (incl. the implicit drop to AI), owners emailed and the verified owner phone texted (6/h/channel) | `src/lib/session.ts`, `src/app/api/auth/reauth/route.ts`, `src/lib/voice/call-handling-changes.ts`, `tests/integration/review5.test.ts` (M4 x5) |
| L1 Midnight job 15 minutes tall | Fixed | `endMin = endMs >= midnight ? 1440 : wallMinutes` | `src/lib/calendar.ts`, `tests/calendar.test.ts` |
| L2 Running job in upcoming and past | Fixed | `past` excludes in-progress jobs | `src/lib/db/index.ts`, `tests/integration/review5.test.ts` |
| L3 Job walk stops at a deleted cursor row | Fixed | keyset on (created_at, id) with the values carried in the cursor / last row, in `listBusinessesPage` and `listLiveBusinessesForJobs` | `src/lib/db/index.ts`, `tests/integration/review5.test.ts` |
| L4 Focus lost after the toggle | Fixed | `aria-disabled` + busy guard, focus restored; browser-driven check | `src/components/dashboard/call-mode.tsx`, `tests/call-mode.test.ts` |
| L5 Hours checkbox re-sends a stale mode | Fixed | PATCH accepts `forward_during_hours` alone; the UI sends only that and shows the fresh server state | `call-mode/route.ts`, `call-mode.tsx`, `tests/integration/review5.test.ts` |
| L6 `date=9999-...` 500 | Fixed | `isCalendarDateKey` (real date within 50 years) -> 422 (API) / today (page) | `src/lib/calendar.ts`, `src/app/api/bookings/route.ts`, tests |
| L7 Territories / 976 / toll-free pass | Fixed | covered by H1; toll-free refused by decision (never "a phone the owner controls") | `forward-number.ts`, `tests/call-mode.test.ts` |
| Suspicion: forward to another tenant's AI number (loop) | Fixed | any business line and `TWILIO_PHONE_NUMBER` refused at set time and dial time | `forward-vet.ts` |
| Suspicion: `updateCall` throwing in `/api/voice/incoming` drops the call | Open | unchanged, could not be triggered | |
| Suspicion: `listBusinesses()` capped at 1000 / `bookings_upcoming` capped at 5000 | Open | unchanged (documented) | |

## Round 6 review (`docs/review/10-adversarial-review-round-6.md`)

One new migration, `20261130120000_review6_split_counters_recording_queue` (hand-written, zero drift: `prisma migrate diff --from-migrations ... --to-schema-datamodel` reports no difference, checked by `tests/db/migration.test.ts`): `usage_counters.voicemail_seconds` / `forward_seconds`, tables `forward_leases` and `pending_recording_deletions`. The five PoCs of the review (scratchpad `round6-poc.test.ts`) now fail on the old assertions; the same scenarios are re-proved against the fixed behaviour in `tests/integration/review6.test.ts` (23 tests).

| Id | Status | Resolution | Evidence |
| --- | --- | --- | --- |
| H1 One anonymous caller shuts a forwarding / paused business off | Fixed | per-CALLER hourly budgets before the business ones (3 forwards / 2 voicemails; callers withholding their number share one stricter bucket, 5 / 3; hashed keys); a caller over theirs gets the voicemail path / "try again later" without touching the business budget or texting the owner, and the call row says "Not taken"; each CallSid charged once (`claimEvent`, retries only re-read); business ceilings raised to 60/h and split: strangers may use 75% (`CALLER_UNKNOWN_SHARE_PCT`), known customers (booking or answered AI call in 90 days) keep the rest, one forward slot and their own missed-call text budget; at >80% of a budget a loud log + ONE owner text per hour; a voicemail refusal records the call instead of leaving it "in progress"; hang-up during ringing (`canceled`) costs nothing | `src/lib/voice/caller-limits.ts`, `forward-metering.ts`, `non-ai.ts`, `capacity.ts`, `src/app/api/voice/{incoming,voicemail}/route.ts`, `tests/integration/review6.test.ts` (H1 x7) |
| M1 Anonymous voicemails / carrier voicemail burn AI minutes | Fixed | `call_seconds` is AI seconds only; `forward_seconds` (cap `FORWARD_MINUTES_CAP` 600, trial 30) and `voicemail_seconds` (cap `VOICEMAIL_MINUTES_CAP` 60) with their own gates (`checkForwardAllowed`, `checkVoicemailAllowed`), shown in billing status and the Billing page; `recordCallSeconds` / `checkCallAllowed` keep their signatures; `FORWARD_MAX_CONCURRENT` live forwards (lease table) that also RESERVE their time limits against the cap; ring time 20 s; a leg that completes under `FORWARD_MIN_ANSWERED_SECONDS` or reports `AnsweredBy=machine*` is unanswered; caller limits from H1. Open: Twilio call screening (`<Number url>`) not built (known-limitations) | `src/lib/db/usage.ts`, `forward-leases.ts`, `src/lib/voice/forward-metering.ts`, `twiml.ts`, `src/lib/billing/summary.ts`, `src/app/dashboard/billing/page.tsx`, `tests/integration/review6.test.ts` (M1 x5), `tests/integration/review5.test.ts` |
| M2 Recording deletion is fire-and-forget | Fixed | `pending_recording_deletions` written in the same transaction as the call DELETE (purge, erasure, `clearAll`); job `recording_deletions` drains it with backoff, 2xx/404 = done, alert + audit after 5 failures, admin diagnostics; erasure says `recording_deletion: 'pending'`, export `recording_deletions_pending` | `src/lib/db/recording-deletions.ts`, `compliance.ts`, `index.ts` (`clearAll`), `src/lib/voice/recording-deletion.ts`, `src/lib/jobs/index.ts`, `tests/integration/review6.test.ts` (M2 x4) |
| L1 Break-glass cookie session skips the step-up | Fixed | `requireRecentAuth` covers `via: 'cookie'`; `/api/auth/reauth {admin_token}` for that session; only Bearer and dev are exempt (Bearer audited as `admin_token` with role in meta) | `src/lib/session.ts`, `src/app/api/auth/reauth/route.ts`, `src/components/dashboard/reauth.tsx`, tests (L1) |
| L2 `forward_during_hours` skips the step-up | Fixed | any change of the flag needs it (the default `false` is the baseline) | `call-mode/route.ts`, tests (L2) |
| L3 2FA account can step up with the password alone | Fixed | with `totp_enabled` the code is required (password alone: 422 `totp_required`; the dashboard switches to the code field); reauth lock coupling documented in docs/auth.md | `reauth/route.ts`, tests (L3) |
| L4 DB admin audited as `admin_token` | Fixed | `auditActorOf`: `user` + id, role / via in meta; used by call mode, forward-number, owner-phone and voicemail playback audits | `src/lib/session.ts`, tests (L4) |
| L5 `VOICE_LINE_KIND` misconfiguration misleads | Fixed | `webhook` against a configured native line is ignored (native wins), loud boot error `line_kind_mismatch`, `diagnostics.voice_line` in `GET /api/admin/jobs`, deploy.sh warning | `src/lib/voice/line.ts`, `instrumentation.ts`, `deploy.sh`, tests (L5) |
| Suspicion: no per-user limit on the voicemail proxy | Fixed | 40 requests per person and 120 per business per minute (429 + `Retry-After`), a complete recording (<= 2 MB) is cached in memory for 45 s so seeks (Range) cost one Twilio call, dropped when deletion is queued | `src/app/api/calls/[id]/voicemail/route.ts`, `src/lib/voice/voicemail.ts`, tests |
| Suspicion: Dial-action retries on caller hang-up | Fixed | covered by charge-once per CallSid; `canceled` takes no voicemail unit | `forward-metering.ts` (`classifyDial`), tests |
| Suspicion: `claimEvent` claims never completed | Not an issue | claims carry a lease (`CLAIM_LEASE_MS`, 5 min): a crashed worker's claim is taken over by the next retry | `src/lib/db/events.ts` |
| Suspicion: audit-write failure leaves `upstream.body` unread | Open | unchanged (minor, not measured) | |

## Phase: features (previously "not built" items, now built) and the integration pass

Migrations: `20261201120000_phase1_calendar_kb_transcript_passkeys_memberships` (all new tables and columns of the feature set) and `20261202120000_integration_gaps` (hand-written, zero drift, applied to an old-schema database with data in `tests/db/migration.test.ts`): `businesses.closed_dates`, `owner_kb_changes.base`, `calendar_connections.block_on_busy` (back-filled from the audit trail), `bookings.dispute_status` (CHECKed).

| Item that was "not built" | Implementation | Evidence |
| --- | --- | --- |
| Google Calendar two-way sync (PRD roadmap) | OAuth connect, busy blocks (times only), push of bookings, incremental sync + watch channels, needs-reauth handling, `block_on_busy` column, Today notices | `src/lib/integrations/google/*`, `src/lib/db/calendar.ts`, `tests/integration/google-calendar.test.ts`, `tests/google-calendar-pure.test.ts`, e2e run (busy block refused a slot; event pushed; external delete noticed) |
| Owner correction of the KB by voice | propose -> read-back -> SMS YES code -> apply -> undo; hours / closed dates / service area are REAL fields written in the same transaction (this pass) | `src/lib/voice/owner/*`, `src/lib/db/owner-kb.ts`, `src/lib/kb-patch.ts`, `tests/owner-callin-pure.test.ts`, `tests/integration/owner-callin.test.ts` |
| Live transcript during a call | push endpoint + polling source, SSE, consent-gated purge | `src/lib/voice/live-transcript.ts`, `tests/integration/telephony-phase2.test.ts`, e2e run (lines appeared on the call page) |
| Live human transfer | `transfer_to_human` + transfer-to-number system tool behind `NATIVE_TRANSFER`; call screening on the webhook line | `src/lib/voice/transfer.ts`, `screening.ts`, `tests/integration/telephony-phase2.test.ts` |
| STIR/SHAKEN caller trust, metering reconcile, 80/100% cap warnings, language detection | `call-trust.ts`, `reconcile.ts`, `billing/warnings.ts`, `LANGUAGE_DETECTION`; owner-line calls are metered consistently (this pass) | `tests/integration/telephony-phase2.test.ts` (race: post-call vs reconcile, owner kind included) |
| Passkeys (WebAuthn), multi-business | `passkey_credentials`, `memberships`, switcher, "add another location" | `tests/db/passkeys.test.ts`, `tests/db/multi-business.test.ts`, e2e run (CDP virtual authenticator registered and signed in; second location + switcher) |
| Reschedule, refunds, dispute flag, recording player, voice selection, readiness gate, annual plan | `bookings/:id/reschedule|refund`, `refund-events.ts` (+ `dispute_status`), `recording-audio.ts`, `voices.ts`, `kb/readiness.ts`, annual interval in checkout and onboarding | `tests/integration/phase2.test.ts`, `tests/phase2-pure.test.ts`, `tests/integration/billing-routes.test.ts` |

Integration gaps found and fixed in the integration pass (each with a test):

| Gap | Fix | Evidence |
| --- | --- | --- |
| Test scanned the last 20 GLOBAL audit events | assertions scoped by action + actor kind + timestamp; sweep found no other global-state scans (rate-limit buckets are cleared by prefix per file) | `tests/db/auth-mfa.test.ts` |
| Owner hours / closures / service area were FAQ notices that never changed availability | structured operations applied to the real fields, validated, transactional, undoable with `changed_since`, stale-checked; `closed_dates` honoured by `slotsForDate`, `nextAvailable`, `createBooking`, reschedule, forward-during-hours | `src/lib/closures.ts`, `src/lib/availability.ts`, `tests/integration/owner-callin.test.ts` |
| Owner calls skipped by reconcile but counted by post-call | one rule: owner calls are metered (never blocked); a deleted provider conversation settles instead of "giving up" | `tests/integration/telephony-phase2.test.ts` |
| "Reply C to cancel" was not handled | `src/lib/messaging/sms-cancel.ts` in `/api/sms/inbound` | `tests/integration/sms-cancel.test.ts` |
| Block-on-busy lived in the audit trail; no dispute flag; no dashboard notice | real column (+ backfill), `dispute_status`, `CalendarNotice` on Today; `usage_warnings` named consistently | `tests/integration/google-calendar.test.ts`, `tests/integration/phase2.test.ts`, `tests/integration/billing-routes.test.ts` |
| Onboarding offered monthly only; reauth copy named call mode; challenge cleanup was a 2% side effect; `clearAll` missed new tables | Monthly/Annual in onboarding, generic step-up copy, cleanup in the hourly job, `clearAll` covers every table (test fills all of them) | `tests/integration/jobs.test.ts`, `tests/db/clear-all.test.ts` |
| Agent tools registered through scattered paths | one `syncAgent`, in-flight tool dedupe, `POST /api/admin/resync-agents` | `tests/integration/agent-sync.test.ts` (fake ElevenLabs holds the final config) |
| Found by the mock end-to-end run | the booking-hook registry and the mock Google store were per-bundle singletons (bookings never reached Google); the mock OAuth token carried no scopes (connect always failed); onboarding showed raw `email_not_verified` | `tests/booking-hooks.test.ts`, `src/lib/integrations/google/mock.ts`, `src/app/onboarding/step-verify.tsx` |


## Review 14 (`docs/review/11-adv-calendar-owner.md`, `12-adv-voice-platform.md`, `13-adv-identity-money.md`, `14-adv-verticals-i18n-data.md`)

Every finding was either fixed with a regression test or recorded as a residual (see the "Resolution" section at the end of each report; the
residuals are collected under "Review 14 residuals" in `docs/known-limitations.md`). One hand-written migration,
`20261203120000_review14_provider_deletions_consent_lock_metering` (re-runnable, row locks only, zero drift proven with
`prisma migrate diff --from-migrations ... --shadow-database-url ... --exit-code`, and exercised on a populated old-schema database in
`tests/db/migration.test.ts`): `pending_recording_deletions.provider` (+ provider-aware shape CHECK), the transcript consent guard taking
`FOR SHARE` on the call row, the repair of the phase-1 `calls.metered_at` backfill, and `bookings.stripe_payment_link_id`.

| Area | Fix | Evidence |
| --- | --- | --- |
| Identity H1 | passkey registration needs a verified email; a password reset deletes passkeys registered while the address was unverified / before it was verified (audit + notice) | `tests/db/passkeys.test.ts` |
| Money H2, M1, L1, L2 | only the SAME amount may be re-sent while a refund is pending (UI locks it); asynchronous refund failures count as failed attempts (new key); cancel deactivates the deposit Payment Link and a payment for a cancelled booking alerts the owner and reopens the refund; revoke-sessions is scoped to the business (admin: everywhere) | `tests/integration/phase2.test.ts`, `tests/db/multi-business.test.ts` |
| Calendar M1, M3, L1, L2, L3 | reconnect keeps the chosen calendar (different account: old events cleaned up first); calendar switch takes the sync lease, sync / watch writes are conditional on the calendar they read; revoked is terminal for in-flight refresh / sync / failure writes; the other business's `rc_booking` events are busy time; 403/404 from `error` ends in `needs_reauth` | `tests/integration/google-calendar.test.ts` |
| Owner call-in M2, L4, L5, STIR | per-field stale check (confirming one proposal no longer stales the others); only applied / reverted changes are read out; confirmation text names the call; undo of any age validates; `TN-Validation-Failed` never enters owner mode | `tests/integration/owner-callin.test.ts` |
| Voice M1-M3, L1-L7 | live stream re-check against the call's business; recording proxy bounded (streamed cap, single flight, byte-capped cache, 4 concurrent downloads, 503 + Retry-After); ElevenLabs conversations deleted by erasure / retention / demo reset through the durable queue; every playback audited per person+call+10 min; unreadable transfer = unknown; AI part of a transfer metered as AI; forward-metering failure releases the claim; null duration is not 0 seconds; interim last turn + re-check for a mid-call decline; `/transcript` rate limit | `tests/review14-pure.test.ts`, `tests/integration/telephony-phase2.test.ts` |
| Verticals M1-M5, L1-L6 | urgency scored on caller turns only; failed agent sync after a vertical change is reported and retried (`agent-dirty`, `reconcile` job); consent guard `FOR SHARE`; only a 404 recreates an agent (+ bind / webhook for the new one); `metered_at` repair; malformed `rc_locale`; life-safety list; each pack's own 911 sentence in the prompt; vertical change serialised; signup notice in the account owner's language; `usage_warnings` every 10 min behind a lease | `tests/integration/review14-data.test.ts`, `tests/db/migration.test.ts`, `tests/db/locale.test.ts`, `tests/review14-pure.test.ts` |
