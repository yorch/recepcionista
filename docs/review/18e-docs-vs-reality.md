# 18e: docs and claims vs code reality

Slice: README.md, PRD.md, CONTRACTS.md, docs/*.md (incl. integrations/ and product/), docs/.env.example vs code, UI copy (src/lib/i18n/catalog/*, landing page). Read-only review; no repo files were changed. Line numbers are from the tree as of 2026-11-25.

Method: each claim was checked by reading the implementing code (not by name search alone). Env vars were reconciled with `.env.example`, `docs/env-vars.md`, `deploy.sh`, the compose files and every `process.env` read in `src/`, `scripts/` and `next.config.ts`. Limits: env reads done through computed names or helper indirection were only checked by name, not traced one by one. Tests were not run and `tests/` was not inventoried. The `docs/changelog-hardening.md` feature map was spot-checked, not fully verified.

## Summary counts

| Class | Count | Meaning |
| --- | --- | --- |
| A. Mock, fallback or fake success reachable in PRODUCTION | 9 | ranked below; A1-A4 are high impact |
| B. Dev/demo-only mocks, verified gated | 10 | prod-refused or DEMO_MODE/non-prod only |
| C. Test-only doubles | not inventoried | out of this slice; `tests/` uses fake providers per docs/known-limitations.md |
| D. Doc or claim contradicted by code, or internally inconsistent | 22 | README, PRD, CONTRACTS, env-vars, owner-call-in, known-limitations |
| E. Marketing or UI copy that overclaims | 4 | landing page and dashboard labels |
| Env vars | 0 dead app vars; 7 read but missing from `.env.example`; 3 doc defaults unsafe in prod | section 4 |

Decisions needed from the owner are listed in section 6, one per item, so they can be asked one at a time.

---

## 1. Class A: mock or fallback reachable in production (ranked by user-visible impact)

### A1. Production without ELEVENLABS_API_KEY: business goes live with a mock agent, and calls are recorded as disclosed
- **Where:** `src/lib/voice/elevenlabs.ts:592-594` (`syncAgent` with no key returns `agent_id = mock_agent_<biz>, mock: true`, no `NODE_ENV` guard); `src/app/api/businesses/[id]/provision/route.ts:321-327` (a mock agent is not an error, so `agentFailure` stays null) and `:354` (`status: 'live'` set regardless of `agentMock`); `src/app/api/voice/incoming/route.ts:247` (`recording_disclosed: true, consent_status: 'disclosed'` set when `!hasElevenLabs()`, in any environment) and `:264-272` (the response is JSON with `fallback_script`, not TwiML, and `ws_url` is null).
- **What is mocked:** the voice agent. Nothing answers the call. The consent state records that the AI disclosure was given.
- **Reachable:** production. `deploy.sh:65-69` only checks ELEVENLABS secrets when `ELEVENLABS_API_KEY` is set. It does not require the key. `src/instrumentation.ts:45` prints `off (scripted calls)` and continues.
- **Docs claim:** README line 358 "scripted replay without one"; `docs/env-vars.md` ELEVENLABS_API_KEY "unset: scripted calls"; README line 152 "Nothing fails open because of NODE_ENV"; PRD 5.4 and README "Phone numbers never fake it in production" cover only numbers.
- **User-visible impact:** a paying customer's number is bought and marked `live`, callers hear nothing or get a Twilio error, and the owner sees a healthy line. The compliance record says disclosure was given when no agent spoke. This is the highest-impact item.
- **Real implementation needs:** refuse to go live (422 or 503 `agent_not_configured`) in production when ELEVENLABS_API_KEY is unset, and do not set `consent_status='disclosed'` unless a real agent is connected. Also add a boot error in `instrumentation.ts` and a `deploy.sh` requirement.
- **Size:** S (refuse path) to M (also fix the consent logic and tests).
- **Decision:** yes. Should a production box without the voice key be allowed to provision at all? (See D1.)

### A2. Production without Twilio credentials: customer SMS is logged as `mock` and counted as delivered (fake success, plus consent recorded)
- **Where:** `src/lib/providers/twilio.ts:76-83` (no `TWILIO_*` means a 60 ms wait, status `'mock'`, no HTTP call; the echo to the console is gated, but the success result is not); `src/lib/messaging/actions.ts:71-74` (`delivered = sent.status === 'sent' || 'mock'`, then writes `followup_consent_at` when the text carries the follow-up notice); `src/lib/voice/tools.ts:478` (caller is told the confirmation was texted); `src/lib/booking-changes.ts:46` (`DELIVERED` includes `mock`); `src/components/calendar/booking-panel.tsx:134` (shows "ok").
- **What is mocked:** the SMS transport. Only `owner-alert.ts:152` refuses `mock` unless `DEMO_MODE=true`. The customer paths do not.
- **Reachable:** production. `deploy.sh:208-209` prints a warning and continues. Provisioning itself fails closed (`fakeNumberAllowed` in `twilio.ts:155-158`), so this needs an existing or manually-managed business, or a dashboard "send SMS" action (`/api/sms/send`) or a resend on a business that already exists.
- **Docs claim:** README "Twilio ... without a key: SMS logged and shown in the dashboard" (a dev statement). `docs/env-vars.md` TWILIO_ACCOUNT_SID "SMS is logged ... outside production only", which is wrong for SMS: the code has no production guard on the SMS mock.
- **User-visible impact:** the caller is told "I've texted you a confirmation" and nothing is sent. Follow-up (review/gratitude) consent is recorded from a text that never went out. That is a consent-evidence defect.
- **Real implementation needs:** in production, `sendSms` without Twilio should return `failed` with a clear error, and `'mock'` should count as delivered only in dev/DEMO_MODE, the same rule `owner-alert.ts` already uses. Also refuse at boot when Twilio is unset in production and the app is serving customers.
- **Size:** S.
- **Decision:** no product decision needed; it is a correctness fix. The boot refusal is a deployment-policy question (see D2).

### A3. REVIEW_URL defaults to a demo Google review link in production
- **Where:** `src/lib/messaging/templates.ts:183-184` (`return process.env.REVIEW_URL || 'https://g.page/r/demo/review'`), used by `src/lib/gratitude/reply.ts:32` for every 4-5 star review request. `.env.example:233` has it commented out. `deploy.sh` does not check it.
- **What is mocked:** the business's review destination.
- **Reachable:** production by default. Every gratitude sweep that routes a customer to review sends this link unless the operator sets REVIEW_URL.
- **Docs claim:** `docs/env-vars.md` REVIEW_URL default "demo link", with no warning about production.
- **User-visible impact:** real customers are asked for a review on a URL that is not the business's. It is a visible error in a customer text, and the owner may not notice.
- **Real implementation needs:** require REVIEW_URL in production when gratitude is enabled (deploy.sh check, plus a per-business `review_url` setting if needed). If unset, skip review requests and route the customer to the owner instead, rather than send a placeholder.
- **Size:** S (refuse or skip). M if per-business review URL is added to the dashboard.
- **Decision:** yes. The owner must supply the real review link, and the product must decide whether review texts are skipped when it is missing (see D3).

### A4. Businesses created without a website get template knowledge: fake services, prices and hours, and a hard-coded "Miami-Dade County" service area
- **Where:** `src/lib/extraction/index.ts:42-52` (`templateResult` returns the vertical pack's priced services, hours and FAQs, and `service_area: ['Miami-Dade County']`); `src/app/api/businesses/[id]/provision/route.ts:204-207` (no `business.url` means `generateKnowledgeBase(templateResult(...))`, with no warning and no `mocked` check). The non-admin readiness gate (`:219-224`) passes because template services carry base prices.
- **What is mocked:** the trade's prices, hours and service area, for a business that never supplied them.
- **Reachable:** production, through the normal API (`POST /api/businesses` with no `url`, then provision).
- **Docs claim:** `docs/known-limitations.md` "Verticals are templates, not verified trade knowledge ... owners must check every line on the review step". PRD 5.3 "Template fallback when no LLM key is set | Shipped": that is a different path, and the wording is wrong (see D12).
- **User-visible impact:** a non-Miami business can go live quoting Miami-Dade and vertical-default prices. The review step is the only guard, and only in the onboarding UI (`src/app/onboarding/step-review.tsx:42` flags `source === 'template'`). The provision API has no such gate.
- **Real implementation needs:** remove the hard-coded service area (leave it empty and require the owner to fill it), and refuse non-admin provisioning when the KB source is `template` until the owner has confirmed the prices and hours.
- **Size:** S (remove the hard-coded area and gate) to M (proper confirmation step).
- **Decision:** yes. Should a no-website business be allowed to go live on template prices, and what is the minimum owner confirmation? (See D4.)

### A5. LLM template fallback is silent in production for post-call summaries and briefing narration
- **Where:** `src/lib/voice/postcall.ts:294-302` (`summaryFallback`, a heuristic that splits the transcript), `:592-600` (`generateTextSafe(..., fallback)`, the `mocked` flag is discarded, and the result is stored as the call summary). `src/lib/briefing/index.ts:256` (`fallbackScript`), `:283-311` (`narrate` uses `.value` and ignores `mocked`; the fallback is also used when the LLM output is out of word range).
- **What is mocked:** the model's prose. The fallback is deterministic and labelled nowhere.
- **Reachable:** production when neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set, or when the model call fails.
- **Docs claim:** README line 237 "LLM ... without a key: deterministic templates, still coherent". This is documented, but the UI and DB do not mark the output as template-generated.
- **Contrast (verified clean):** `src/lib/extraction/index.ts:298-316` refuses to extract without an LLM (`no_llm`), and `:309-315` throws when `mocked` is true, so the website-to-KB step never silently templates.
- **User-visible impact:** the owner reads a heuristic summary as if the model wrote it. Quality is lower and nobody knows.
- **Real implementation needs:** store a `summary_source` (`llm` | `template`) and show it, or refuse to store a template summary in production.
- **Size:** S.
- **Decision:** yes, low priority (see D5).

### A6. DEMO_MODE is not refused in application code in production; the unauthenticated mock-complete route marks deposits paid when it is set
- **Where:** `src/app/api/pay/mock-complete/route.ts:14-15` (`if (!demoModeEnabled()) return 404`; no `NODE_ENV` check and no auth; then `markDepositPaid(booking.id, amount)` at `:28`). `src/lib/auth.ts:233-235` (`demoModeEnabled()` is only `process.env.DEMO_MODE === 'true'`). The only production guard is `deploy.sh:114-117`. `compose.production.yaml:216` forces `DEMO_MODE: "false"`.
- **Contrast:** `src/app/api/billing/mock-activate/route.ts:18` does check `NODE_ENV === 'production'`. `mock-complete` does not.
- **What is mocked:** a payment. The deposit is marked paid with no money moving.
- **Reachable:** production only if `DEMO_MODE=true` is set in the environment. Compose forces it off and deploy.sh refuses it, so this needs a bypass of both. It is defence-in-depth, not an open hole.
- **User-visible impact:** if the flag ever leaks into production, anyone holding a booking id can mark a deposit paid.
- **Real implementation needs:** make `demoModeEnabled()` return false when `NODE_ENV === 'production'`, and add the same boot refusal used for other dev switches. Also add the `NODE_ENV` check to `mock-complete`.
- **Size:** S.
- **Decision:** no (engineering hardening).

### A7. `/pay/[id]` booking branch renders the mock card form in production
- **Where:** `src/app/pay/[id]/page.tsx:88-101` (when a booking with a deposit exists, the page shows `<Checkout>` in production, with no `isProd` check on that branch; the `isProd` check at `:70` only guards the non-booking mock path). `src/app/pay/[id]/checkout.tsx:110` (the "demo" badge), `:123-140` (card number, expiry, CVC and ZIP fields), `:57-70` (Pay posts `booking_id` to `/api/pay/mock-complete`, which 404s in production, so the user sees "demo off").
- **What is mocked:** the checkout. Card fields are collected on this origin and then not used.
- **Reachable:** production by direct URL `/pay/<bookingId>` (a bearer link). The normal path sends a Stripe-hosted link, so the form is not on the customer's normal path.
- **Docs claim:** CONTRACTS.md line 74 "`GET /pay/[id]` mock checkout page (only reached in mock Stripe mode)": false. README line 364 "No card data touches this app": card digits are entered and held in browser state; they are not posted, but the form is still on the app origin.
- **User-visible impact:** a bearer-link visitor can type card numbers into a fake form that then errors. Operationally this is a dead end, and it trains customers to type card details into the app.
- **Real implementation needs:** in production, `/pay/<bookingId>` for a booking should 404 unless the booking has a real Stripe link, and the mock card form should be removed from production builds.
- **Size:** S.
- **Decision:** yes, briefly: confirm that the booking-level `/pay` page should be removed in production (see D6).

### A8. Briefing audio: the local macOS `say` path has no production guard, and its `mock: true` flag is misleading
- **Where:** `src/lib/briefing/tts.ts:64-77` (`localSay` uses `say` and `afconvert`, with no environment check), `:99-111` (on ElevenLabs failure it falls back to `say`; on Linux that fails and returns `{audio_url: null, mock: true}`). The `mock: true` flag is set on real macOS audio too (`:77`).
- **Reachable:** production. On a Linux server (the Dockerfile target) audio silently stays null. On a Mac host, `say` speaks the briefing with the Paulina voice.
- **Docs claim:** README line 359 "Briefing audio ... macOS say ... without one". PRD 5.7 says "text only without a TTS key" (conflicts, see D9).
- **User-visible impact:** in production without an ElevenLabs key the owner gets a text briefing with no voice note, and the dashboard shows an empty player. No error is shown.
- **Real implementation needs:** make the local TTS a dev-only option, and in production show "voice note unavailable" rather than an empty player.
- **Size:** S.
- **Decision:** yes, low priority (see D7).

### A9. Demo console is in the production admin nav, and every action it offers 404s
- **Where:** `src/components/dashboard/shell.tsx:30` (nav entry `/dashboard/demo`, admin gate). `src/app/dashboard/demo/page.tsx` renders for any admin with no DEMO_MODE check. `src/components/dashboard/demo-tools.tsx:40` (`/api/demo/simulate-call`) and `:58` (`/api/demo/reset`) both return 404 without DEMO_MODE (`simulate-call/route.ts:111`, `reset/route.ts:24`).
- **What is mocked:** nothing directly. The console is dead UI in production.
- **Reachable:** production admins.
- **Docs claim:** PRD 5.1 "demo console (admin only, DEMO_MODE)"; the page does not check DEMO_MODE.
- **User-visible impact:** an admin clicks "Call her" and gets an error. The page also shows "calls loaded" and "dial" text that suggests a working demo.
- **Real implementation needs:** hide the nav item and return a notFound page when DEMO_MODE is off.
- **Size:** S.
- **Decision:** yes (see D8).

---

## 2. Class B: dev/demo mocks, verified gated (listed so they are not mistaken for prod gaps)

| ID | Where | What is mocked | Gate | Verified |
| --- | --- | --- | --- | --- |
| B1 | `src/lib/providers/stripe.ts:23-28, 47-48, 91-93` | deposit Payment Link becomes `/pay/mock_...` | no key: prod throws (`:47`); Stripe error: prod throws (`:91`) | yes, prod refuses |
| B2 | `src/lib/providers/stripe-billing.ts:50-56`, `src/app/api/billing/mock-activate/route.ts:18` | subscription checkout and activation | prod throws `BillingConfigError`; mock-activate 404s in prod | yes |
| B3 | `src/lib/providers/stripe-refunds.ts:85-89` | refund returns `re_mock_...` as succeeded | prod throws (`:86`) | yes |
| B4 | `src/lib/providers/twilio.ts:151-160, 203-215, 356-398` | `+1<area>555xxxx` phone numbers, release is a no-op | `fakeNumberAllowed`: prod or any Twilio var set refuses | yes |
| B5 | `src/lib/integrations/google/config.ts:26-28`, `src/app/api/integrations/google/mock-event/route.ts`, `src/instrumentation.ts:96-97` | fake Google Calendar | `NODE_ENV !== production` and `GOOGLE_OAUTH_MOCK=true`; prod ignored with boot error | yes |
| B6 | `src/lib/email/index.ts` (`resolveEmailProvider`) | `log` provider writes links to logs | prod throws `EmailConfigError` | yes, fails closed |
| B7 | `src/app/api/demo/simulate-call/route.ts` (SCRIPTS at `:44-100`, runs `runTool` in-process), `src/app/api/demo/reset/route.ts` | scripted demo calls and reseed | `DEMO_MODE=true` plus admin; 404 otherwise | yes |
| B8 | `src/lib/demo/seed-data.ts`, `scripts/seed.ts`, `/api/demo/reset` | demo business "Miami Cool Air" with example.com URLs and a fake pay link (`seed-data.ts:91, 187`) | script, or reset (gated by B7) | yes; not in the product path |
| B9 | `src/app/pay/[id]/page.tsx:33, 101-102, 124` | `DEFAULT_BUSINESS` name and `?amount=` for the bare mock link | `!isProd && isMockId` | yes |
| B10 | `src/lib/voice/elevenlabs.ts:514, 784` | `mock_` agent ids skip provider calls | internal; no user-visible effect | yes |
| B11 | `src/lib/providers/llm.ts:183-214` | template output when no key | see A5 (dev and prod, not gated) | n/a, class A |
| B12 | `src/lib/voice/elevenlabs.ts:592-594, 664, 680` | mock agent | see A1 (prod, not gated) | n/a, class A |

Counted as class B: B1-B10 (10 items). A5, A8, A1 and A2 are class A because they are reachable in production.

---

## 3. Class D: docs and claims contradicted by code, or internally inconsistent

Ranked by how much a reader would be misled.

| ID | Claim (file:line) | Reality (code) | Status |
| --- | --- | --- | --- |
| D1 | README line 359 and 363 "Calendar is internal by design — no OAuth, no external sync"; PRD section 6 line 231 "Google Calendar or other external calendar sync" is a non-goal | Google Calendar OAuth two-way sync is built: `src/app/api/integrations/google/{connect,callback,webhook,busy,calendar,status,orphans}`, `src/components/dashboard/google-calendar-card.tsx`, `docs/integrations/google-calendar.md`, `src/lib/calendar.ts`. | False. Doc is stale in two places. |
| D2 | README line 48 "today's revenue at a glance" | Today page shows `deposits_month_cents` (`src/app/dashboard/page.tsx:116`); no "today revenue" figure exists. Revenue is in the briefing (`src/lib/briefing/index.ts:62-68`). | Drift |
| D3 | README line 237 "LLM ... without a key: deterministic templates, still coherent" | True for summaries and briefings. False for website-to-KB, which refuses (`src/lib/extraction/index.ts:298-301`). | Partial |
| D4 | README line 358 and `docs/env-vars.md` ELEVENLABS_API_KEY "scripted replay / scripted calls" | Scripted replay exists only in DEMO_MODE (`simulate-call`). In production without the key, the agent is a mock and the incoming route returns JSON (A1). | False in production |
| D5 | README line 359 "Briefing audio: macOS say ... without one"; PRD 5.7 line 196 "text only without a TTS key" | Both are true on different hosts, and neither is stated for production (A8). The two docs disagree. | Contradictory |
| D6 | README line 52 and layout line 268 "the demo console drives the same seven HTTP tools"; `src/app/api/demo/simulate-call/route.ts:4` | `simulate-call` calls `runTool` in-process, not over HTTP, and bypasses the tool secret. Its own header says so. | Inaccurate wording |
| D7 | README line 52, PRD 5.4 line 148 "Seven voice tools" | The agent registers more than seven: `TOOL_NAMES` plus `reschedule_booking`, `cancel_booking` (`src/lib/voice/tools-bookings.ts:32`), `propose_kb_change`, `list_recent_changes`, `undo_last_change` (`src/lib/voice/owner/specs.ts:8`), `list_recent_leads`, `draft_reply`, `mark_lead_handled`, `get_callback_number` (`specs.ts:10`), and `transfer_to_human` when `NATIVE_TRANSFER` is on (`elevenlabs.ts:353-354`). | Stale count |
| D8 | PRD line 102 "demo console (admin only, DEMO_MODE)" | The page is not gated by DEMO_MODE (A9). | Partial |
| D9 | PRD 5.4 line 160 "Bilingual conversation ... No language detection in code" | `languageDetectionEnabled` (`src/lib/voice/elevenlabs.ts:378-379`) defaults on; `docs/env-vars.md` LANGUAGE_DETECTION "on". | False |
| D10 | PRD 5.7 line 193 "No reschedule (cancel and rebook)" | Reschedule is built: `src/app/api/bookings/[id]/reschedule/route.ts`, `src/components/calendar/reschedule-dialog.tsx`, voice `reschedule_booking`. PRD roadmap item 9 (line 324) also says it is done. | False, contradicts PRD itself |
| D11 | PRD 5.4 line 157 "Owner voice REPLY shipped" vs PRD section 11 line 326 "Deferred by owner decision (not built, not scheduled): owner voice REPLY" | Built and on by default: `OWNER_REPLY_ENABLED` follows `OWNER_CALLIN_ENABLED`, which defaults to `true` (`src/lib/voice/owner/config.ts:7`, `reply-config.ts:6`, `specs.ts:9`). | Roadmap line is false |
| D12 | PRD 5.3 line 130 "Template fallback when no LLM key is set | Shipped" | Website extraction refuses without a key (`src/lib/extraction/index.ts:298-301`). Templates are only used for a business with no website (A4). | False as worded |
| D13 | PRD 5.4 line 156 "Live human transfer ... Shipped behind NATIVE_TRANSFER"; PRD section 6 line 230 non-goal "Live human transfer"; PRD roadmap line 316 item 1 "Live human transfer" | Built and off by default (`src/lib/voice/transfer.ts`, `elevenlabs.ts` transfer tool). Three places in the PRD disagree, and README does not mention it. | Contradictory |
| D14 | PRD 5.9 line 222 "about 730 test() cases in about 59 files" | Grep of `tests/` finds about 1,237 `test(`/`it(` declarations in about 92 files (approximate). The PRD says "not re-run". | Stale count |
| D15 | CONTRACTS.md line 74 "GET /pay/[id] mock checkout page (only reached in mock Stripe mode)" | Production renders the checkout for any booking with a deposit (A7). | False |
| D16 | `docs/owner-call-in.md` line 24 "Only services, FAQs and pricing notes can change" | Lines 14 and 43 of the same doc, and `src/lib/voice/owner/specs.ts:21`, add hours, closures and service area. | Internally inconsistent |
| D17 | `docs/known-limitations.md` "Mock providers need a non-production process ... refuses mock Google / mock checkout / the log email provider" | Accurate for those three. It does not mention that the SMS mock (A2), the ElevenLabs mock agent (A1), the template KB (A4), the REVIEW_URL demo default (A3) or the LLM fallbacks (A5) are active in production. | Incomplete |
| D18 | `docs/env-vars.md` REVIEW_URL "demo link" | The default is a production-reachable placeholder (A3). | Doc is accurate, but the risk is not stated |
| D19 | `docs/env-vars.md` OPENAI_API_KEY "unset: templates" | Only the summary and briefing paths template. Extraction refuses (`src/lib/extraction/index.ts:298`). | Partial |
| D20 | README line 152 "Nothing fails open because of NODE_ENV. If a secret is unset the app rejects the request." | True for the Twilio webhook signature (`src/lib/providers/twilio.ts:41-47`, fails closed without the token). False for the ElevenLabs agent path (A1), the SMS mock (A2) and the review URL (A3), which all proceed without their secret or key. | Partial |
| D21 | README line 180 "Phone numbers never fake it in production" | Verified true (`twilio.ts:155-158`, `:203-215`). | True (listed for completeness) |
| D22 | README line 364 "No card data touches this app" | Card fields are on the app origin in production for booking-level `/pay` pages (A7). Nothing is posted. | Technically true, misleading |

---

## 4. Env var reconciliation

Method: names in `.env.example` and `docs/env-vars.md` were compared with every `process.env` read in `src/`, `scripts/`, `next.config.ts`, and the names in `deploy.sh`, `compose.production.yaml`, `compose.dev.yaml`, `Dockerfile`.

- **In `.env.example`, read by no app code (compose or script only; documented as such):** `APP_IMAGE`, `TOOLS_IMAGE`, `TRAEFIK_NAME`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DOMAIN` (compose and deploy.sh), `DATABASE_URL_OVERRIDE` (compose only). No app-level example variable is dead. `ALLOWED_DEV_ORIGINS` is read by `next.config.ts:27`. `JOBS` and `DOMAIN` are documented in `docs/env-vars.md`, which I checked by name.
- **Read by code, absent from `.env.example`:** `NEXT_PUBLIC_APP_URL` (`src/lib/providers/stripe.ts:156`, `twilio.ts:26`, `csp.ts`), `NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ES`, `NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL_ES` (`src/app/site-config.ts:17-22`), `OWNER_REPLY_ENABLED`, `OWNER_REPLY_DAILY_LIMIT`, `OWNER_REPLY_REQUIRE_ATTESTATION` (`src/lib/voice/owner/reply-config.ts`), `REFUND_RECONCILE_AFTER_HOURS` (`src/lib/refund-service.ts`). All seven are documented in `docs/env-vars.md`. Framework-set and not needed in the example: `NEXT_PHASE`, `NEXT_RUNTIME`, `PRISMA_QUERY_EVENTS`.
- **Read by code, undocumented in `docs/env-vars.md`:** none found by name. Helper reads with computed names were not traced one by one.
- **Doc defaults that are unsafe or wrong in production:**
  - `ELEVENLABS_API_KEY` "unset: scripted calls" (A1).
  - `REVIEW_URL` "demo link" (A3).
  - `OPENAI_API_KEY` "unset: templates", true for summaries and briefings only (D19).
  - `TWILIO_ACCOUNT_SID` "SMS is logged ... outside production only" (A2): the SMS mock is not limited to non-production.
- **Missing requirements in `deploy.sh`:** `ELEVENLABS_API_KEY` (A1), `REVIEW_URL` (A3), and `TWILIO_*` is only a warning (A2). `DEMO_MODE` and `ALLOW_INSECURE_DEV` are refused (`deploy.sh:114-117`), as documented.

---

## 5. Class E: marketing and UI copy that overclaims

| ID | Where | Claim | Reality |
| --- | --- | --- | --- |
| E1 | `src/lib/i18n/catalog/publicPages.ts:15` (en and es) | "No hold music. No lost calls." | Not guaranteed. A1, A2 and the carrier-forwarding dependency can lose or mis-handle calls. |
| E2 | `src/lib/i18n/catalog/publicPages.ts:21` (step 2) | "Forward your business line to it. Your phone still rings first" | Depends on the owner's carrier forwarding. PRD 5.4 says forward mode is disabled on the native production line (`docs/known-limitations.md`). Carrier forwarding still works, but "phone rings first" depends on the carrier's no-answer setting. |
| E3 | `src/lib/i18n/catalog/dash.ts:127` | "Forty-five seconds. Then you know your day." | Narration is 110-140 words (`src/lib/briefing/index.ts`, word-count gate). That is about 45-55 s spoken; the "45 seconds" is approximate and only true on the ElevenLabs path. |
| E4 | `src/lib/i18n/catalog/billing.ts:70` (`demo.dial`) | "Bookings, deposits, and emergencies all land here within seconds." | Shown on `/dashboard/demo`, which is dead in production (A9). Accurate only with DEMO_MODE or a live line. |

---

## 6. Decisions needed from the owner (ask one at a time)

- **D1 (A1).** Production without `ELEVENLABS_API_KEY`: refuse to provision and go live (recommended), or allow a "no voice agent yet" state that never shows `live`?
- **D2 (A2).** Production without Twilio: boot refuses to serve customers (recommended), or keep the warning and just make SMS fail honestly?
- **D3 (A3).** The Google review link: what is the real per-business review URL, and should review requests be skipped when no link is set?
- **D4 (A4).** No-website businesses: allow going live on vertical template prices, or require the owner to confirm prices and hours first? Also: remove the hard-coded "Miami-Dade County" service area?
- **D5 (A5).** Template summaries and briefings in production: label them as automatic summaries, or refuse to store them?
- **D6 (A7).** The booking-level `/pay/<bookingId>` page in production: remove the mock card form entirely, or 404 it unless a real Stripe link exists?
- **D7 (A8).** Briefing voice notes without ElevenLabs: drop the macOS `say` fallback outside development, and show "voice note unavailable"?
- **D8 (A9).** Hide the demo console from production admins?
- **D9 (D5, D13, D11).** Product status of owner voice reply and live transfer: are they shipped (on by default, as the code shows), or deferred (as PRD section 11 says)? Which PRD section is the source of truth?
- **D10 (D1).** Google Calendar sync: the README and PRD say it is not built. Code says it is built and documented. Is it a supported feature?

## 7. Verified real (no mock in the product path)

- Website-to-KB extraction: real or error, no template fallback (`src/lib/extraction/index.ts:298-316`).
- Phone number purchase: fails closed in production, mock pool only outside production without Twilio (`src/lib/providers/twilio.ts:155-158, 203-215`).
- Stripe deposit links and refunds: fail closed in production (`stripe.ts:47, 91`; `stripe-refunds.ts:86`).
- Billing checkout and portal: mock only outside production, and mock-activate 404s in production (`stripe-billing.ts:50-56`).
- Email: fails closed in production (`src/lib/email/index.ts`, `resolveEmailProvider`).
- Google Calendar mock: ignored in production with a boot error (`src/instrumentation.ts:96-97`).
- Voice webhook signature: fails closed without the token (`src/lib/providers/twilio.ts:41-47`).
- Owner alerts: a mock SMS counts as delivered only under DEMO_MODE (`src/lib/voice/owner-alert.ts:152`).
- Seed data is not in the product path except the gated reset route.

## 8. Not verified in this slice

- `tests/` contents and the test count (only a grep count).
- `docs/runbook.md`, `docs/compliance.md`, `docs/auth.md`, `docs/billing.md`, `docs/refunds.md`, `docs/security-headers.md`, `docs/dependencies.md`, `DEPLOY.md`, `MEL_USAGE.md` were not read line by line. Their concrete claims were only spot-checked through the code they cite.
- The `docs/changelog-hardening.md` feature-to-code map was not fully checked.
- Jobs are wired (`src/instrumentation.ts:104-105` calls `startJobRunner`), but the schedule and each job were not traced.
