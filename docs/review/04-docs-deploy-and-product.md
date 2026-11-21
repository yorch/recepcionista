# Review 04: docs, deploy, and product

Scope: PRD.md, README.md, CONTRACTS.md, DEMO.md, DEPLOY.md, MEL_USAGE.md,
deploy.sh, Dockerfile, compose.*.yaml, .env.example, .gitignore,
.dockerignore, scripts/check-elevenlabs-key.sh, git history, and a structural
skim of src/. Read-only: no source changed, nothing built, linted, or deployed.
Lint, typecheck, and the test scripts were not run.

Severity: **Critical** = exploitable or money/data loss on a public host.
**High** = material risk or a doc that will fail as written. **Medium/Low** =
hygiene.

---

## Top findings

1. **Critical: no authentication on any route.** There is no `src/middleware.ts`
   or `src/proxy.ts`, and `src/app/dashboard/layout.tsx` only redirects when no
   business exists. The health comment in `src/app/api/health/route.ts` refers
   to a "(dashboard) auth surface" that does not exist. DEPLOY.md never says
   the dashboard is public.
2. **Critical: destructive and spend-making endpoints are open.**
   `POST /api/demo/reset` wipes every table (`src/lib/db/index.ts:486-491`).
   `POST /api/sms/send` sends arbitrary SMS. `POST /api/payments/create-link`
   and `POST /api/sms/payment-link` create Stripe links and text them.
   `POST /api/businesses/[id]/provision` buys numbers and agents.
   `GET /api/businesses` returns every business, including `owner_phone`.
3. **Critical: voice webhooks and tools are unauthenticated.**
   `/api/voice/webhook`, `/api/voice/post-call`, `/api/voice/incoming`, and
   `/api/voice/tools/[tool]` do no ElevenLabs HMAC or Twilio
   `X-Twilio-Signature` check. Anyone can invoke `create_booking`, `send_sms`,
   or `create_payment_link` for any business.
4. **High: Stripe webhook fails open.** Without `STRIPE_WEBHOOK_SECRET`,
   `src/app/api/payments/webhook/route.ts:41-43` accepts unsigned events, and
   a forged `booking_id` flips `deposit_paid` and `status: confirmed`
   (lines 72-73). `deploy.sh` only warns, and compose does not require the
   variable. Signature and 5-minute tolerance are correct when the secret is set
   (lines 131-137).
5. **High: SSRF on `/api/extract`.** `src/lib/extraction/index.ts:74-75` allows
   any http(s) URL. There is no private, loopback, or metadata-IP block. The app
   also sits on the `egress` network.
6. **High: Quick Start in README.md fails as written.** `.env.example` has no
   `DATABASE_URL`, and Prisma reads `.env`, not `.env.local`.
7. **High: PRD overstates the build.** No Supabase, no 6 PM auto-briefing, no
   consent or STOP handling, no recording disclosure, no calendar grid, and no
   automated gratitude trigger. Next.js is 16, not 14.
8. **High: legal exposure.** Calls are recorded and transcribed with no
   disclosure. Florida is an all-party-consent state. Texts go out with no
   opt-out handling.
9. **Medium: deploy operations.** `deploy.sh` exits 0 even when the health wait
   times out. It takes no pre-migrate backup, and `--seed` truncates live data.
   The backup command in DEPLOY.md expands variables on the host, where they are
   unset.
10. **Medium: repo hygiene.** No `.github/`, so no CI. No test script in
    package.json, no LICENSE. `scripts/check-elevenlabs-key.sh` hard-codes
    `/Users/yorch/...`. No committed secrets were found.

---

## 1. PRD claims vs implementation

Status key: Yes, Partial, No. Evidence paths are relative to the repo root.

| Feature (PRD ref) | Claimed | Implemented | Evidence |
| --- | --- | --- | --- |
| URL to extraction to KB + system prompt (FR-1.1, Flow A) | MVP | Yes | `src/app/api/extract/route.ts`, `src/lib/extraction/index.ts`, `src/app/api/businesses/[id]/provision/route.ts` |
| Extract at least 5 services and 3 FAQs (FR-1.2) | MVP | Partial | Output is LLM or template; no minimum enforced. `src/lib/extraction/index.ts:204` only slices to 15 FAQs. |
| Extraction within 30s (FR-1.1) | MVP | Partial | No timeout in `src/lib/extraction/index.ts`. Not verified. |
| Phone number provisioning (FR-1.3) | MVP | Partial | `src/lib/providers/twilio.ts` `provisionNumber`, mock fallback. Live inbound routing uses ElevenLabs `bindPhoneNumber` (`src/lib/voice/elevenlabs.ts:360`), not Twilio. |
| Owner edits business and KB before go-live (FR-1.4) | MVP | Yes | `src/components/dashboard/knowledge-editor.tsx`, `PUT /api/businesses/[id]/knowledge`, `PATCH /api/businesses/[id]` |
| Spanglish answer, language switch (FR-2.1) | MVP | Partial | Prompt-driven in ElevenLabs. No detection in code. `src/app/api/voice/agent-prompt/route.ts`, `src/lib/demo/seed-data.ts` |
| Urgency triage (FR-2.2) | MVP | Yes | Prompt plus `urgency` field (`prisma/schema.prisma`), `flag_emergency` in `src/lib/voice/tools.ts` |
| Booking with availability check (FR-2.3) | MVP | Yes | `src/lib/voice/tools.ts` (`check_availability`, `create_booking`), `src/lib/scheduler.ts`, `getBookedSlots` in `src/lib/db/index.ts` |
| SMS confirmation with quote, under 10s (FR-2.4) | MVP | Yes | `src/lib/messaging/templates.ts`, `src/lib/messaging/index.ts` `sendAndLog`. The 10s figure is not measured. |
| Emergency Stripe deposit link plus SMS (FR-2.5) | MVP | Yes | `src/lib/voice/tools.ts` (`DEPOSIT_CAP_CENTS`), `src/app/api/sms/payment-link/route.ts`, `src/app/api/payments/create-link/route.ts` (`MAX_CENTS = 50_000`) |
| Human handoff, "connect you with the owner" (FR-2.6) | MVP | Partial | `handoff_to_human` only flags for a callback. No live transfer. `src/lib/voice/tools.ts`. |
| Owner SMS alerts | implied | Yes | `kind: 'owner_alert'` in `src/lib/voice/tools.ts:219`, `src/app/api/payments/webhook/route.ts` |
| Briefing auto-generated at 6 PM (FR-3.1) | MVP | No | Generation is on demand only (`src/app/api/briefings/generate/route.ts`). No cron or timer exists. `src/lib/scheduler.ts` is slot math only. |
| Briefing content: calls, bookings, revenue, flags (FR-3.2) | MVP | Yes | `src/lib/briefing/index.ts` |
| Briefing audio playable (FR-3.3) | MVP | Partial | ElevenLabs needed. Without a key on Linux, `audio_url` is null (`src/lib/briefing/tts.ts:105-108`). |
| Owner voice reply to briefing (FR-3 step 4) | stretch | No | Not found |
| 24h gratitude SMS (FR-4.1) | stretch | Partial | Sweep exists at `src/app/api/gratitude/run/route.ts` and `src/lib/gratitude/index.ts`. Nothing schedules it. |
| Rating routing 4-5 review, 1-3 owner (FR-4.2) | stretch | Yes | `src/app/api/sms/gratitude-reply/route.ts`, `src/lib/gratitude/index.ts` |
| Call log with transcript and audio (Sec. 5) | MVP | Partial | Transcript shown. `recording_url` is stored (`src/app/api/voice/webhook/route.ts:121`) but `src/app/dashboard/calls/page.tsx` has no player. |
| Calendar view (Sec. 5) | MVP | Partial | `src/app/dashboard/bookings/page.tsx` is titled "Calendar" but is a list. No grid component. |
| Settings panel: voice, hours (Sec. 5) | MVP | No | No settings route under `src/app/dashboard/`. Only knowledge editor. |
| Business status `paused` (data model) | MVP | Partial | Type only, `src/lib/types.ts:6`. No route or UI sets it. |
| Seven voice tools (Sec. 6) | MVP | Yes | `src/lib/voice/tools.ts`, `src/app/api/voice/tools/[tool]/route.ts`. Names match CONTRACTS.md. |
| Guardrail: no invented prices | MVP | Yes | `get_pricing` returns `matched:false` (README table) |
| Guardrail: "call 911" for health | MVP | Partial | Only in demo prompt, `src/lib/demo/seed-data.ts:44`. Gas-leak and CO guidance absent. |
| Recording consent or disclosure | not in PRD | No | No disclosure in any prompt or greeting. |
| Google Calendar sync (stretch) | stretch | No | Intentionally internal, per README |
| Owner corrects KB by voice (stretch) | stretch | No | Not found |
| Live transcript in dashboard (stretch) | stretch | No | Post-call only |
| Supabase schema and client (Sec. 5, WS1) | MVP | No | Postgres 17 with Prisma (`prisma/schema.prisma`). Deviation, and README and MEL_USAGE agree with the code. |
| Next.js 14 (Sec. 7) | MVP | No | `package.json` has `next` 16.4.6. |
| OpenAI GPT-4o / Claude 3.5 | MVP | Yes | `src/lib/providers/llm.ts`, model from `LLM_MODEL` and `ANTHROPIC_MODEL` |
| Env vars `SUPABASE_*`, `STRIPE_PUBLISHABLE_KEY` (Sec. 5) | MVP | No | Not read anywhere in `src/` or `scripts/` |
| Stripe test mode only (Sec. 2) | MVP | Partial | Test keys by convention. Nothing enforces `sk_test_`. |

---

## 2. Product assessment

**Value proposition.** The strongest part is the single-URL onboarding, the
bilingual call handling, and the deposit-link flow. Those are concrete and
demoable. The PRD's "30-50% of calls lost" figure has no source. The claim that
the Miami bilingual market is underserved is also unsourced.

**Target market.** The owner-operator HVAC or plumbing shop in Miami-Dade is
well defined. The PRD does not size it, does not estimate call volume, and does
not describe how the owner buys or who pays.

**Differentiation.** Compared with answering services such as Smith.ai and Ruby,
and with AI receptionist startups, the claimed differences are (a) auto-built KB
from a URL, (b) Spanglish, and (c) emergency deposits by SMS link. All three are
plausible. None is measured. The PRD names no competitors.

**Monetization.** Absent. The PRD has no price, no per-call or per-minute unit
economics, and no cost model. Known variable costs are ElevenLabs minutes, the
Twilio number and per-minute charges, and LLM tokens. Those would need to be
priced against typical SMB retainers before the product is pitched.

**Gaps and risks.**

- **Recording consent.** `recording_url` and transcripts are stored from
  ElevenLabs, and no prompt or greeting discloses recording
  (`src/lib/voice/postcall.ts`, `src/app/api/voice/webhook/route.ts`). Florida
  requires all-party consent (Fla. Stat. 934.03). Get counsel review before any
  live call.
- **Texts and TCPA.** `src/app/api/sms/send/route.ts` lets the voice agent send
  arbitrary text to any number. The gratitude and review texts go to past
  customers. No STOP or HELP handling exists (grep found none). No 10DLC or A2P
  registration is referenced. Florida's FTSA also reaches some text marketing.
  Check with counsel.
- **AI identity.** The PRD persona is "Maria, the friendly bilingual
  front-desk employee", with no AI disclosure. Add a disclosure in the greeting.
- **Life safety.** HVAC calls include gas smell and carbon monoxide. Neither is
  routed to 911 in any prompt. A gas-smell or CO caller should be told to leave
  and call 911 before any booking.
- **Human handoff is a flag, not a transfer.** An emergency caller who asked for
  a person hears "I've flagged it" and nothing more. That is a missed-call risk.
- **PII.** Caller phone, name, address, transcripts, and recordings are kept in
  Postgres with no retention rule. No DELETE route exists (grep found zero
  `export async function DELETE` in `src/app/api`). Combined with the
  missing auth, this is a data-exposure risk.
- **Deposits.** $500 cap is enforced in three places. No refund or dispute policy
  is written down, and the mock checkout (`src/app/pay/[id]/checkout.tsx`)
  renders a card form. That form is labelled a demo, but confirm it is never
  reachable on a live host.

---

## 3. Doc accuracy

| Doc | Claim | Reality | Fix |
| --- | --- | --- | --- |
| README.md Quick start | `cp .env.example .env.local`, then `bunx prisma migrate deploy` | Prisma reads `.env`. `.env.example` has no `DATABASE_URL`. `prisma/schema.prisma` uses `env("DATABASE_URL")`. Step fails. | Add `DATABASE_URL=postgresql://recepcionista:recepcionista@localhost:5433/recepcionista?schema=public` to `.env.example`, and tell the user to copy to `.env`. |
| README.md Logs | `journalctl --user -u recepcionista-dev` | Personal systemd unit not in repo | Mark as an example |
| README.md Verify | `smoke.ts` is 39 assertions | A simple grep of `check(`/`assert(`/`expect(`/`ok(` gave 25. Could be a different pattern. | Recount and state the method |
| DEPLOY.md Backups | `pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"` on the host | Variables are not sourced on the host. Expands to empty. | Run inside the container: `exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"'` |
| DEPLOY.md Pointing providers | Twilio number to `POST /api/voice/incoming` | Route returns JSON with `agent_id` and `ws_url`, not TwiML (`src/app/api/voice/incoming/route.ts:90-96`). A Twilio voice webhook cannot use that. | Document that inbound routing goes through ElevenLabs phone binding, or add TwiML. |
| DEPLOY.md endpoint table | ElevenLabs post-call to `/api/voice/webhook` | Both `src/app/api/voice/webhook/route.ts` and `src/app/api/voice/post-call/route.ts` are POST receivers. Only one is documented. | Name the canonical one and remove or redirect the other. |
| DEPLOY.md Hardening | "non-root (`node`)" applied | True for `app`. `tools` target has no `USER`, so migrate and seed run as root. | Add `USER node` to `tools`, or note the exception. |
| DEPLOY.md (whole) | Not mentioned | Dashboard, `/api/demo/*`, `/api/sms/send`, and `/api/extract` are public. | Add an "Access control: none" section, or add auth first. |
| .env.example | `LOG_LEVEL=debug` | Set explicitly, so production logs at debug. The comment says production defaults to info, but only when unset. | Comment the line out. |
| .env.example | `LLM_MODEL=gpt-6-luna` | Unusual model id. Cannot verify offline. | Confirm it is a real, available model. |
| .env.example, code | Coverage | Used in code but not in example: `ELEVENLABS_PHONE_NUMBER` (`src/app/page.tsx:74`, `src/app/dashboard/page.tsx:46`), `NEXT_PUBLIC_ELEVENLABS_PHONE_NUMBER` (`src/components/dashboard/shell.tsx:31`), `NEXT_PUBLIC_APP_URL` (`src/lib/providers/stripe.ts`), `DATABASE_URL`. Example has `ELEVENLABS_PHONE_NUMBER_ID` (the UUID) and the code shows the digits in another variable. | Add all four. |
| PRD env block | `SUPABASE_*`, `STRIPE_PUBLISHABLE_KEY` | Not read by code | Replace with the real list |
| CONTRACTS.md | Route table | Methods match `src/app/api` exports. Omits `/api/voice/post-call` (exists, see DEPLOY row above). | Add the missing route |
| check-elevenlabs-key.sh | Verdict logic | `cd /Users/yorch/hackathon-prd/app \|\| exit 1` fails silently on any other machine. Its warning that the dashboard badge "will falsely say live" is accurate: `src/app/dashboard/demo/page.tsx:57` checks only key presence. | Make the path relative, and fix the badge to call the API |
| README.md | "Stripe: no card data touches this app" | True for real Stripe. The mock checkout takes card-like fields. | Qualify: "mock checkout collects demo card fields; never enabled in production" |
| DEPLOY.md | `deploy.sh` "refuses to start" on bad APP_URL | True, and checked: `deploy.sh` `[[ "${APP_URL}" == "https://${DOMAIN}" ]]` | none |

Also: the PRD demo number `+1-305-555-0199` differs from the seeded
`+13055550142` in CONTRACTS.md. The PRD says Next 14, Supabase, and 6 PM
briefings. Mark the PRD as a historical v1.0 plan so it stops reading as the
current spec.

---

## 4. Deploy, Docker, and compose

Confirmed good: no secrets baked into the image (`.dockerignore` excludes
`.env*` and `.git`), the dummy `DATABASE_URL` is scoped to one RUN, runner stage
runs as `node` with `read_only`, `cap_drop: ALL`, `no-new-privileges`, Postgres
is on an `internal` network with no published ports, `APP_URL` and `DOMAIN` are
checked, and Stripe timestamp tolerance is 300s.

| Sev | Finding | Evidence | Recommendation |
| --- | --- | --- | --- |
| Critical | No app auth; public demo and spend endpoints (see top findings 1-3) | `src/middleware.ts` absent. `src/app/api/**` no auth. | Add owner auth (session or basic) to `/dashboard`, `/api/demo`, `/api/sms/send`, `/api/payments/create-link`, `/api/sms/payment-link`, `/api/businesses/*`, `/api/extract`, `/api/briefings/generate`, `/api/gratitude/run`. Verify ElevenLabs HMAC and Twilio signature on voice and SMS webhooks. |
| Critical | Public demo reset | `src/app/api/demo/reset/route.ts` | Gate behind `NODE_ENV !== 'production'` or a flag, and also at Traefik |
| High | Stripe webhook fail-open | `src/app/api/payments/webhook/route.ts:31-43`; `deploy.sh` warns only | Make `STRIPE_WEBHOOK_SECRET` required in `compose.production.yaml` (`${STRIPE_WEBHOOK_SECRET:?}`) and have `deploy.sh` exit |
| High | SSRF in extract | `src/lib/extraction/index.ts:74-75` | Resolve hostname, reject loopback, link-local, RFC1918, and metadata ranges, and reject redirects to them |
| High | `deploy.sh` sources `.env` with `set -a; . ./.env` | `deploy.sh` | Values with `$`, backticks, `;`, `&`, or spaces run as shell. Use a parser, or document that quoting is required. Compose parses `.env` differently, so the two can disagree. |
| Medium | Health wait falls through on timeout | `deploy.sh` loop ends and exits 0 | `die` after the loop if not healthy |
| Medium | No backup before migrate | `deploy.sh` runs `up -d` with migrate | Run `pg_dump` into a host directory before `migrate` |
| Medium | `--seed` truncates live data | `deploy.sh` `--seed`, `scripts/seed.ts` | Require a typed confirmation or refuse unless `FORCE_SEED=1` |
| Medium | `tools` image runs as root | `Dockerfile` tools stage, no `USER` | Add `USER node`. Migrate has `cap_drop` but still runs root. |
| Medium | Tags not digests | `oven/bun:1.4.1`, `node:24-bookworm-slim`, `postgres:17-alpine` | Pin digests. No Watchtower or scanning, which DEPLOY already admits. |
| Medium | Traefik has no rate limit or path rules | `compose.production.yaml` labels | Add a rate-limit middleware, and deny `/api/demo` and `/api/voice/tools` from the public internet, or allow provider IPs only |
| Medium | Prisma engine in standalone | `next.config.ts` has no `outputFileTracingIncludes`; runner copies only `.next/standalone` | Unverified. Confirm the image starts and queries with a real build. |
| Low | `DATABASE_URL` built from unencoded password | `compose.production.yaml` app environment | Document percent-encoding, or require an alphanumeric password |
| Low | No log rotation | `compose.production.yaml` `app` has no `logging:` | Add `max-size` (DEPLOY already says so) |
| Low | Dev and prod project names differ | `name: app` in `compose.dev.yaml`, `name: recepcionista` in production | Harmless, but pinned volume name is fragile |
| Low | `db` has no resource limit | `compose.production.yaml` | Add `mem_limit` |
| Low | Health route only checks `SELECT 1` | `src/app/api/health/route.ts` | Acceptable for readiness |

Note on migrations on deploy: `migrate` runs before `app` on every `up`, and is
forward-only. DEPLOY.md's rollback caveat is correct.

---

## 5. Repo hygiene

- **Committed secrets:** none found. Searched for Stripe `sk_live`/`sk_test`/
  `whsec_`, Twilio `AC` SIDs, `sk-`, `sk-ant-`, AWS `AKIA`, PEM private keys,
  GitHub `ghp_`, and URLs with passwords. Only `.env.example` is tracked. The
  Dockerfile build DB URL is a dummy.
- **Personal or machine-specific references:**
  `scripts/check-elevenlabs-key.sh:4` (`/Users/yorch/...`),
  `DEPLOY.md` (`~/code/tradr`, `~/code/docker-compose-services`),
  `next.config.ts:10` (`allowedDevOrigins: ['recepcionista.brnby.in']`, a
  personal tunnel hostname). Move the tunnel host to an env var.
- **CI and automation:** no `.github/`. No workflow runs lint, typecheck, the
  `scripts/*-test.ts` suites, `hadolint`, `yamllint`, or `markdownlint`. The
  configs are present (`eslint.config.mjs`, `.markdownlint.jsonc`), and
  Dockerfile and compose carry lint directives, but nothing enforces them.
- **Tests:** five ad hoc scripts (`scripts/ws1-test.ts` 14, `ws3-test.ts` 40,
  `ws4-test.ts` 71, `ws5-test.ts` 17, `smoke.ts`). No `test` script in
  `package.json`. No unit test framework. No test runs against a real
  ElevenLabs, Twilio, or Stripe sandbox in CI.
- **Scripts in package.json:** `lint`, `db:*`, `postinstall`. No `typecheck`,
  `test`, or `format`.
- **Missing standard files:** no LICENSE, no SECURITY.md, no CONTRIBUTING.md.
- **Dead or duplicate code:** two post-call receivers (`voice/webhook` and
  `voice/post-call`). `package.json` has a non-standard `ignoreScripts` key next
  to `trustedDependencies`.
- **Git history:** conventional commits, readable. One `wip:` commit
  (`dab93ef`). `310317b` added a personal tunnel hostname to `next.config.ts`.
- **Screenshots:** `docs/screenshots/` (~1 MB, six PNGs) is committed. Fine.
- **Docs:** `.markdownlint.jsonc` sets an 80-column limit with tables and code
  exempt. Commit `90358d0` says all hand-written markdown passes. Nothing
  re-checks it.
