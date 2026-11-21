# Project Review — Executive Summary

Four independent reviews (Opus: security/integrations; Sonnet: data layer, frontend; Haiku: docs/deploy/product). Detailed findings with file:line references are in the numbered reports. Findings are agent-produced from reading the code; nothing was built or run, except that the scheduler time-zone issue was reproduced by the data-layer reviewer. Treat Critical items as "verify then fix", not as unchecked fact. I spot-checked two headline claims (no middleware/proxy file exists; Stripe webhook runs unverified when its secret is unset), and both held.

| Report | Scope |
|---|---|
| [01-security-and-integrations.md](01-security-and-integrations.md) | Auth, webhooks, SSRF, abuse, payments (5 Critical, 5 High, 7 Medium, 8 Low) |
| [02-data-layer-and-logic.md](02-data-layer-and-logic.md) | Booking logic, time zones, schema, DRY, tests |
| [03-frontend-and-ux.md](03-frontend-and-ux.md) | Next.js usage, /pay page, dashboard, a11y, UX |
| [04-docs-deploy-and-product.md](04-docs-deploy-and-product.md) | PRD vs. reality, legal/product, deploy, hygiene |

## Verdict

A convincing demo-grade prototype with a clear value proposition (answer calls, book, text, take deposits, daily briefing). It is **not safe to expose to the internet or real customers in its current state**. The main blockers are security (no auth at all) and correctness of the core booking path (time zones, double-booking). Both are fixable in a bounded amount of work.

## Top issues (all reviewers converge)

1. **No authentication anywhere (Critical).** No middleware/proxy; every API route and the dashboard is open. `GET /api/businesses` leaks all tenant IDs and owner phones; `PATCH /api/businesses/[id]` can redirect alerts, swap agent IDs, or rewrite the AI's knowledge. The dashboard shows `listBusinesses()[0]` — no tenancy.
2. **Destructive/abusable open endpoints (Critical).** `POST /api/demo/reset` wipes all tables; `/api/sms/send` and `/api/sms/payment-link` send arbitrary texts (phishing, SMS pumping); create+provision buys real Twilio numbers (with a double-buy race); no rate limits on any paid API.
3. **No webhook verification (High/Critical).** ElevenLabs and Twilio webhooks are unauthenticated; Stripe verification fails open when the secret is unset. Anyone can forge calls/payments or rebind the shared voice line to another business.
4. **SSRF (Critical).** The URL fetch behind `/api/extract` and provisioning allows internal/loopback addresses, follows redirects, has no body cap; scraped text flows straight into the agent's system prompt (prompt injection).
5. **Booking correctness (High).** Slots are built in server-local time (UTC in Docker) but validated in Eastern, so the agent can offer 3 AM slots; no DB uniqueness/overlap check (double-booking); cancelled bookings still block; past times accepted; DST hard-coded in `dayRange`; offset-less ISO strings parsed as UTC.
6. **Payments not wired end to end (High).** Stripe links carry no metadata so paid deposits never confirm bookings; `deposit_amount` is never recorded (revenue shows $0); dollars vs. cents mixed; mock `/pay` page always shows $189 and never records payment; `/pay` trusts URL query params (spoofable amounts/business names).
7. **Agent safety/honesty (High).** `flagEmergency`/`handoffToHuman` claim "owner notified" even when the SMS failed or no owner phone exists. The voice agent is never given its `business_id`. Free-form `send_sms` tool is injectable via caller speech.
8. **Legal/compliance (High, product).** Florida all-party consent for call recording is not disclosed; no SMS opt-in/STOP/10DLC handling; no 911/emergency routing for gas/CO; no PII retention or deletion path.
9. **Docs/PRD overstate the build (High).** PRD claims Supabase, 6 PM auto-briefing, consent/STOP handling, calendar grid, gratitude trigger — largely not implemented. README Quick start fails (`.env.example` lacks `DATABASE_URL`; Prisma reads `.env`, not `.env.local`).
10. **No tests and no CI (Medium/High).** Only ad-hoc `scripts/ws*-test.ts`, some of which wipe whatever `DATABASE_URL` points at.

## Recommended order of work

**Phase 0 – before any public exposure (days)**
- Add auth (middleware/proxy + session or at least a shared secret) to dashboard and all non-webhook routes; scope every query by business.
- Remove/guard `/api/demo/*` and `/api/sms/send` behind auth + `NODE_ENV` check.
- Verify Twilio signatures, ElevenLabs HMAC, and make Stripe verification mandatory (fail closed).
- SSRF guard (resolve and block private ranges, no redirects to them, size/time caps); treat scraped text as untrusted.
- Rate limit and cap paid-API routes; make provisioning idempotent.

**Phase 1 – correctness of the core flow**
- Single time-zone module (per-business IANA zone, `date-fns-tz`/Temporal), set `TZ` in Docker; fix `dayRange`/DST; reject past times.
- Booking: transaction + exclusion/unique constraint, duration overlap, ignore cancelled.
- Payments: Stripe metadata → webhook confirms booking and records `deposit_amount`; one money helper (integer cents).
- Pass `business_id` to the agent; honest tool results on SMS failure; fix post-call payload shape and call matching (persist `call_sid`).

**Phase 2 – product, legal, ops**
- Recording disclosure, STOP/opt-in, emergency routing copy; retention/delete.
- Reconcile PRD with reality (or build the gaps); fix README/DEPLOY commands and env drift.
- deploy.sh: fail on health timeout, backup before migrate, non-root tools image, pin image digests.
- Add test runner (unit tests for time/hours/parsing first) and CI (lint, typecheck, tests).

**Phase 3 – UX/DRY**
- Make onboarding editable (remove hard-coded demo values), mobile nav, loading/error states, accessibility contrast/focus/labels, consolidate duplicated fetch/toast and mapper code, remove unused deps (verify `lucide-react`, `date-fns`).

## Limits of this review

`node_modules` was not installed, so Next 16-specific API usage was judged from code only (the frontend reviewer found it plausible). The reviewers did not run the app, the DB, or any provider APIs. The post-call ElevenLabs payload-shape finding should be checked against current ElevenLabs docs. Severity labels come from individual reviewers and are not normalised across reports.

## Review cost note

Opus was used only for the security/integration slice (highest stakes); Sonnet for logic and frontend; Haiku for docs/deploy/product comparison.
