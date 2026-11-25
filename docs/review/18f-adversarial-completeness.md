# 18f. Adversarial completeness review of the mock / stub inventory (18a-18e)

Reviewer role: adversarial (Opus). Inputs: `docs/review/18a`..`18e`. Method: an independent grep sweep of `src/` (mock|fake|stub|placeholder|canned|simulate|demo|TODO|noop|not implemented, `Math.random`, `setTimeout`, fixed `ok:true` responses, env fallbacks to demo/example/localhost values, empty handlers, forever-disabled controls), then a read of every call path behind a hit, plus a re-read of the code behind each HIGH/CRITICAL item in 18a-18e. Read-only on source; this file is the only one written. Line numbers are as of 2026-11-25.

Reach key: **PROD** = reachable in a production build with normal config; **PROD-misconfig** = production with a provider key missing or mistyped; **DEV** = non-production or `DEMO_MODE=true` only; **TEST** = test seams.
Size: S < 0.5 day, M 0.5-3 days, L > 3 days. **Decision** = needs an owner or product decision first.

Summary: 18a-18e are accurate on the whole. I found **5 real items they missed (N1-N5)** and **4 consumers they missed for known defects (N6-N9)**. Two of the new items are HIGH: dashboard knowledge edits never reach the live agent (N1), and a self-serve number is bought with no Twilio webhooks (N2). I also corrected **7 items that were overstated or partly wrong** (section 2). No HIGH item turned out to be a pure false positive.

---

## 1. Confirmed items the five reports missed

### N1. Dashboard knowledge and business edits never reach the live voice agent, yet the UI says "She will use this on the next call" (PROD, HIGH)
- **Where:** `src/components/dashboard/knowledge-editor.tsx:57-78` saves through `PATCH /api/businesses/[id]` and then `PUT /api/businesses/[id]/onboarding-status/knowledge` (`route.ts:95-112`). The other KB route, `PUT /api/businesses/[id]/knowledge` (`route.ts:36-39`), behaves the same way. Each rebuilds `system_prompt` in the DB and returns. Neither calls `syncAgent`, `resyncAfterKbChange` or `markAgentDirty`. `PATCH /api/businesses/[id]` (hours, service area, name) does not resync the agent either; only a vertical change does (`src/lib/verticals/change.ts:48-63`). The toast is `kb.ed.saved`, "Saved. She will use this on the next call" (`src/lib/i18n/catalog/knowledge.ts:33,172`). The landing page claims "Edit every price and answer she knows" (`land.f6.d`).
- **Why it matters:** on the native ElevenLabs line, the only production AI path (18a B1), the agent's prompt is whatever the last `syncAgent` PATCHed. `voice/initiation` overrides only `first_message` and the dynamic variables (`src/app/api/voice/initiation/route.ts:42-51,139-143`); it does not override the prompt. So after an edit, callers keep hearing the old prices, FAQs, hours and service area. That lasts until something else triggers a sync: a voice change, a vertical change, an owner call-in change, re-provisioning, or `POST /api/admin/resync-agents`. Booking slots are still validated server-side against the DB, so the stale prompt makes spoken answers wrong but does not cause double-booking.
- **Real implementation:** after both KB PUTs and after a business PATCH that touches prompt fields, call `resyncAfterKbChange(id)` (`src/lib/voice/owner/apply.ts:37`). On failure call `markAgentDirty(id)`; the existing `reconcile` drain retries it (`src/lib/voice/agent-resync.ts`). Make the toast say "saved; the agent could not be updated yet" when the sync failed.
- **Size:** S. **Decision:** no.

### N2. A purchased Twilio number is configured with no Voice URL and no SMS URL (PROD, HIGH for self-serve)
- **Where:** `src/lib/providers/twilio.ts:266-270`. The purchase POST sends only `PhoneNumber` and `FriendlyName`. Repo-wide there is no `VoiceUrl` / `SmsUrl` and no ElevenLabs `convai/phone-numbers` import (grep hits only docs). `docs/runbook.md:27-30` makes the inbound SMS URL a manual operator step, and the voice import is also manual (18a B1).
- **Missed by 18a:** 18a B1 covers the voice side only. The SMS side breaks real features that the app already implements: STOP/START/HELP, the "Reply C to cancel" footer on every confirmation (`src/app/api/sms/inbound/route.ts:57-60`), 1-5 gratitude ratings, and the owner call-in "YES <code>" confirmations that every owner KB change requires (`handleOwnerSms`). Until an operator edits each number by hand in the Twilio console, all of these replies go nowhere. Self-signup plus automatic provisioning means this happens with no operator in the loop.
- **Real implementation:** set `SmsUrl=${APP_URL}/api/sms/inbound` (plus `SmsMethod=POST`) on purchase. When `lineKind()==='webhook'`, also set `VoiceUrl=${APP_URL}/api/voice/incoming`. The native-line import is B1(a).
- **Size:** S for SMS. The voice side is L and tied to B1. **Decision:** no for SMS; yes for voice (B1).

### N3. Free-form customer texts to the business number are silently dropped (PROD, MEDIUM)
- **Where:** `src/app/api/sms/inbound/route.ts:62-77`. Anything that is not a keyword, an owner code, a bare C or a bare 1-5 hits `return xml(twiml()); // not a keyword: no auto-reply`. The message is not logged, not stored, not forwarded to the owner and not shown in the dashboard.
- **Impact:** a customer who replies to a confirmation ("can you come at 3 instead?", "gate code is 1234") reaches nobody, and the owner never learns of it. This is not documented in `docs/known-limitations.md`, README or PRD.
- **Real implementation:** store inbound messages (an `sms_log` row with `direction=inbound`, or a new table). Forward them to the verified owner phone through `alertOwner`, rate limited, and/or show them in a dashboard SMS thread. A short auto-reply ("Messages here are not monitored, call X") is the minimum.
- **Size:** S (forward + auto-reply) to M (an inbox UI). **Decision:** yes (forward, inbox, or auto-reply).

### N4. The gratitude sweep always texts English; the Spanish template is unreachable from the job (PROD, LOW-MEDIUM)
- **Where:** `src/lib/gratitude/index.ts:83` calls `sendGratitude(booking.id, 'en')`. `gratitudeSms` has `es` and `mixed` variants (`src/lib/messaging/templates.ts:164-180`), but only the manual route `/api/sms/gratitude` can pass a language, and it defaults to `en` (`route.ts:24`). Spanish callers, whose call language is stored on `calls.language`, get an English follow-up from a product sold as bilingual.
- **Real implementation:** derive the language from the booking's call (`getCall(booking.call_id).language`), falling back to `business.locale_default`.
- **Size:** S. **Decision:** no.

### N5. The webhook-line "repair" sync pushes a KB-less prompt to the live agent (PROD on webhook line / mixed config, MEDIUM)
- **Where:** `src/app/api/voice/incoming/route.ts:117` (owner call-in branch) and `:233` (customer branch) both call `syncAgent({ business, kb: null })`. `agentBody` (`src/lib/voice/elevenlabs.ts:407-412`) uses `kb?.system_prompt || buildSystemPrompt(business, { services: [], faqs: [], pricing_notes: '' })`. With `kb: null`, every inbound call on that route PATCHes the business's ElevenLabs agent with a prompt that has no services, prices or FAQs.
- **Contradiction:** the `syncAgent` docstring (`elevenlabs.ts:571-574`) says everything is "rebuilt from the database on every call" ("the prompt (KB, hours, ...)"), but the KB is not loaded when `kb` is null.
- **Reach:** any deployment where a Twilio number points at `/api/voice/incoming` while `ELEVENLABS_API_KEY` is set. That includes the webhook-line default, the demo UI, and a mixed setup where the same agent is also bound to the native number through the shared `ELEVENLABS_PHONE_NUMBER_ID` (18a B2). The agent then answers with no price list.
- **Real implementation:** pass `await getKnowledgeBase(business.id)`, or make `syncAgent` load the KB itself when `kb` is null.
- **Size:** S. **Decision:** no.

### Missed consumers of known defects (folded into the existing items)
- **N6. More places that treat `mock` as delivered (extends 18a A1 / 18b M1 / 18e A2):**
  - The voice `send_sms` tool (`src/lib/voice/tools.ts:598-610`) rejects only `failed`, so on `mock` the agent tells the caller "I just sent that text to you."
  - Owner voice reply (`src/lib/messaging/owner-reply.ts:175-189`, and `:161`, which maps `mock` to `sent`) records the reply as `sent` and tells the owner on the call that the customer was texted.
  - The gratitude sweep counts `mock` as sent (`src/lib/gratitude/index.ts:84-94`), so the owner-facing `sent` total is inflated.
  - `/api/sms/send` returns the `mock` row as success (`route.ts:47-48`).
  - The complete list of customer paths that need the shared `smsDelivered(status)` helper is: `tools.ts:478`, `:598`, `:691`, `actions.ts:71`, `booking-changes.ts:46`, `owner-reply.ts:161,175`, `gratitude/index.ts:84`, `sms/inbound/route.ts:67`, `booking-panel.tsx:134`, and the verify-start routes (`owner-phone/verify/start/route.ts:54`, `forward-number/verify/start/route.ts:51`). The one correct path is `owner-alert.ts:152`.
- **N7. `DEMO_MODE` has no `NODE_ENV` guard on any route that uses it (extends 18e A6, which named only `mock-complete`):**
  - `demoModeEnabled()` (`src/lib/auth.ts:233-235`) also gates `/api/demo/reset`, which wipes every table, and `/api/demo/simulate-call`.
  - `twilio.ts:82` echoes SMS bodies, including verification codes and payment links, to stdout in production when `DEMO_MODE=true`.
  - Contrast: `insecureDevAllowed()` (`auth.ts:95-97`) does refuse production. The only production guards are compose and deploy.sh.
  - Fix: `demoModeEnabled = DEMO_MODE==='true' && NODE_ENV!=='production'`. Size S.
- **N8. Webhook-line JSON answers to signed Twilio calls go beyond the `ai` action (extends 18a B1):** the out-of-service branch (`incoming/route.ts:207-227`) and the owner call-in branch (`:110-124`) return JSON with no `isJson` check. A plan-lapsed tenant's caller therefore hears a Twilio "application error", not the "honest out-of-service line" the comment at `:103-104` promises. The paused/voicemail branches already return TwiML. Runbook line 226 discloses the out-of-service case. Fix: return `unavailableTwiml()` (or the paused TwiML) for form posts. Size S.
- **N9. Static "ready" health GETs:** `GET /api/voice/webhook`, `/api/voice/post-call`, `/api/voice/incoming` and `/api/voice/initiation` return a fixed `{ready:true}`. The `voice/webhook` comment says this is "so the dashboard can confirm the route is wired", but nothing in the dashboard calls them, and they check nothing (no secret configured, no provider). LOW; either delete them or make them report whether the matching secret is set. Size S.
- **Dev/staging inconsistency (LOW, DEV):** `verifyElevenLabsSignature` and `verifyToolSecret` (`elevenlabs.ts:48-56,80-89`) skip auth whenever `NODE_ENV!=='production'`. They do not require `ALLOW_INSECURE_DEV`, although their log line says they do. Twilio's check does require it (`twilio.ts:41-48`). A staging box built with `NODE_ENV=development` and no secret accepts forged post-call webhooks and tool calls. 18a E4 says these skips are "under ALLOW_INSECURE_DEV", which is wrong. Size S.

---

## 2. Challenged items: overstated, partly wrong, or reclassified

| Item | Claim | Verdict after reading the code |
| --- | --- | --- |
| 18a A1 / A2 "CRITICAL" (SMS mock = delivered; verification code "sent") | Critical, PROD whenever Twilio is incomplete | **Real, but HIGH, not critical.** In production with no Twilio config, provisioning already refuses (`fakeNumberAllowed`, `provision/route.ts:238-255`, 503 `phone_provider_not_configured`), so no NEW tenant can go live. The exposure is a box whose Twilio env is removed, rotated or mistyped after tenants exist, or a single var missing (`hasTwilio` needs SID + token + phone). Still a fake success that must fail closed. |
| 18a A6 "`mock_agent` ids with `mock:true` on ANY provider failure ... callers continue as if fine" | Provider failures are treated as success | **Partly false.** Every failure return carries `error` (`elevenlabs.ts:645,664,667,680`). Provisioning turns that into a 502 (`provision/route.ts:322,343-349`), `resyncAfterKbChange` reports `failed`, and `voice/route.ts:79` reports `synced=false`. The incoming-route consent condition `(!hasElevenLabs() || !agentMock)` marks a call `disclosed` only in the **no-key** case. Only that no-key consent assertion is real (S). |
| 18c F-01 "HIGH" / 18b M2 / 18e A7 (fake card form at `/pay/<bookingId>`) | High; reachable in prod | **Real, MEDIUM.** Production deposit links are `buy.stripe.com` (`stripe.ts:68-85`), and the Payment Link sets no `after_completion` redirect, so no customer is ever sent to `/pay/<id>`. Only someone who types or guesses a booking id reaches it. It still shows business name, service and amount to anyone holding the id, and still collects card digits in browser state, so gate it. |
| 18c F-02 "HIGH" (receipt page claims texts) | High, PROD | **Downgrade to LOW.** The claim is false: the webhook texts the owner only (`payments/webhook/route.ts:130-143`). But for the reason in the row above, the receipt page is off the normal customer path. It is a copy fix (or a later receipt SMS), not a high-impact fake. |
| 18d P-12 (`deploy.sh --seed`) "can purchase a real Twilio number" | Seed buys a number | **Partly wrong.** The seeded business already has `phone: '+13055550142'` (`seed-data.ts:92`), so provision reuses it and buys nothing (`provision/route.ts:232-234`). The real hazards are different: it truncates all tables, creates a `live`/`active` tenant on a fake 555 number, and, with ElevenLabs configured, registers a real agent and calls `bindPhoneNumber`, which re-points the shared `ELEVENLABS_PHONE_NUMBER_ID` (18a B2) at the demo agent. Keep MEDIUM, decision. |
| 18a E4 | Tool and webhook skips need `ALLOW_INSECURE_DEV` | **Wrong:** they need only non-production (see the dev/staging note above). |
| 18e A4 "fake services, prices" | Fabricated data | **Overstated wording:** these are the vertical pack's labelled starting prices (`docs/known-limitations.md:84`). Only the direct-API path skips the review step. The real defects are the literal `'Miami-Dade County'` (`extraction/index.ts:48`) and no gate on `source==='template'`. MEDIUM stays. |
| 18b M5, M6, M12; 18d P-05, P-06, P-11 | Listed among mocks | **Reclassified** as "unimplemented feature / hard-coded policy". They are not fakes; they are product scope decisions. They stay in the backlog under that class. |
| 18c F-04 "MEDIUM" (timer-driven progress labels) | Medium | **LOW-MEDIUM.** The labels are cosmetic, and the real result or error replaces them. Nothing is recorded or charged off the fake progress. |

No HIGH item from 18a-18e was a pure false positive. I re-read the code for: A1/A2 (SMS mock), A3/P-01 (live with mock agent: `provision/route.ts:350-354` sets `live` with `agentMock` true), A4/P-08 (TTS `say` fallback: `tts.ts:93-112`), B1/B2 (no per-tenant AI line), F-03/P-04/A9 (demo console ungated: `dashboard/demo/page.tsx:19` checks only the admin role), B7/A3 (`templates.ts:184` demo review URL), P-06 (timezone display-only: `settings/route.ts:43`), M3/M4/F-07 (no UI for payment link, booking create, privacy erase/export; grep of `src/app`/`src/components` finds no caller), and A6/18e (`mock-complete` has no `NODE_ENV` check).

---

## 3. Fail-closed check: what production does with a credential missing

| Missing in production | Behaviour | Verdict |
| --- | --- | --- |
| `TWILIO_*` (any of 3) | Number purchase 503 (fail closed). Webhook signature refuses. **`sendSms` returns `mock`, treated as delivered by ~12 customer paths (A1/N6).** **Verification "code sent" (A2).** Owner alerts correctly not delivered. | **FAILS OPEN** (SMS) |
| `ELEVENLABS_API_KEY` | **Provision sets `live` with a mock agent after buying a number (A3/P-01).** **`consent_status='disclosed'` with nothing spoken (A6).** Recording deletion fails closed. Briefing TTS silently null (A4). | **FAILS OPEN** (go-live, consent) |
| `ELEVENLABS_WEBHOOK_SECRET` / `ELEVENLABS_TOOL_SECRET` | 401 (`elevenlabs.ts:50-53,83-85`) | closed |
| `ELEVENLABS_VOICE_ID` (key set) | Briefing audio null, logged at debug only (`tts.ts:29-31,102`) | silent degrade |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Extraction 422 (closed). Call summary becomes a heuristic excerpt, and briefing narration a template with unverified claims (P-02/P-03/C1). Neither is labelled. | silent degrade |
| `STRIPE_SECRET_KEY` | Deposit link, refund and billing all throw (closed). `/pay/<bookingId>` still renders the demo card form (M2) and its Pay button 404s. | closed (UI leak) |
| `REVIEW_URL` | Real customers texted `https://g.page/r/demo/review` (B7/A3) | **FAILS OPEN** |
| `EMAIL_PROVIDER` / Resend | `EmailConfigError`, signup 503 | closed |
| `GOOGLE_*` with mock flag | Mock refused, boot error | closed |
| `DEMO_MODE=true` leaked | mock-complete marks deposits paid unauthenticated; reset wipes the DB; SMS bodies echoed (N7). Only compose/deploy.sh stop it. | **no app-level guard** |
| `ALLOW_INSECURE_DEV=true` leaked | Ignored in production (`auth.ts:96`) | closed |
| (no credential involved) Twilio number webhooks | New numbers have no Voice/SMS URL (N2) | feature silently dead |

---

## 4. Consolidated ranked backlog: all REAL mock / unimplemented items (18a-18f, deduplicated)

Class: **PF** = prod-reachable fake or false success, **DM** = dev-only mock (hardening), **UF** = unimplemented or unwired feature, **DC** = doc or copy claim.

| # | Item (source ids) | Class | Reach | Size | Owner decision? |
| --- | --- | --- | --- | --- | --- |
| 1 | SMS `mock` counted as delivered across ~12 customer paths; plan cap burned; follow-up consent fabricated (18a A1, 18b M1, 18e A2, 18f N6) | PF | PROD-misconfig | S | No (boot refusal: D2 optional) |
| 2 | Owner/forward verification "code sent" when nothing was sent (18a A2) | PF | PROD-misconfig | S (with #1) | No |
| 3 | Business goes `live` with a mock agent after buying a number when the ElevenLabs key is absent; deploy.sh does not require the key (18a A3, 18d P-01, 18e A1) | PF | PROD-misconfig | S | Yes, brief (refuse vs a "no agent yet" state) |
| 4 | Dashboard KB/business edits not pushed to the live agent; toast "She will use this on the next call" (18f N1) | PF | PROD | S | No |
| 5 | Purchased number has no SmsUrl/VoiceUrl: STOP, C-cancel, ratings and owner YES-codes dead on self-serve numbers (18f N2) | UF | PROD | S (SMS) | No (SMS) |
| 6 | No per-tenant AI line: number never imported into ElevenLabs; one shared `ELEVENLABS_PHONE_NUMBER_ID` rebinds across tenants; webhook line returns JSON for ai, out-of-service and owner-mode (18a B1, B2, B3, B5; 18f N8) | UF | PROD | L | **Yes** (import vs TwiML stream) |
| 7 | `consent_status='disclosed'` recorded with no agent speaking (no key) (18a A6, 18e A1) | PF | PROD-misconfig | S | No |
| 8 | Placeholder review link `g.page/r/demo/review` sent to real customers (18a B7, 18e A3) | PF | PROD default | S-M | **Yes** (per-business URL; skip when unset) |
| 9 | Template KB with literal "Miami-Dade County" and pack prices can go live through the API path (18c F-08, 18d P-07, 18e A4) | PF | PROD (API) | S-M | **Yes** (owner must confirm prices?) |
| 10 | Incoming-route sync pushes a KB-less prompt (`kb: null`) to the agent (18f N5) | PF | PROD (webhook/mixed) | S | No |
| 11 | Every tenant in `America/New_York`; time zone not editable (18d P-06) | UF | PROD | M | **Yes** (infer vs ask; US-only) |
| 12 | Briefing audio: macOS `say` fallback, no voice-id default, owner's voice ignored, silent null player, local-disk storage (18a A4/A5, 18b M8, 18c F-05, 18d P-08, 18e A8) | PF (silent degrade) | PROD | M | **Yes** (storage vendor; fallback policy) |
| 13 | Call summaries and briefing narration fall back to templates, unlabelled; template asserts unperformed actions (18a C1, 18d P-02/P-03, 18e A5) | PF | PROD-misconfig / LLM outage | S | **Yes** (is no-LLM a supported prod mode?) |
| 14 | `/pay/<bookingId>` renders the demo card form in production; `CONTRACTS.md:74` wrong (18b M2, 18c F-01, 18e A7/D15/D22) | PF | PROD (direct URL) | S | Brief (404 vs redirect to Stripe link) |
| 15 | Demo console nav and page visible to prod admins; buttons 404; badges inaccurate; HVAC-only scripts (18a C3, 18c F-03, 18d P-04, 18e A9/E4) | PF (dead UI) | PROD admin | S | No (hide), unless demo is a sales feature |
| 16 | Free-form customer texts silently dropped (18f N3) | UF | PROD | S-M | **Yes** (forward / inbox / auto-reply) |
| 17 | No UI for privacy erase/export (compliance), deposit link request/resend, SMS log, manual text (18b M3, 18c F-07) | UF | PROD | M each | **Yes** (launch scope; manual-paid semantics) |
| 18 | No dashboard booking creation; PATCH only changes status (18b M4) | UF | PROD | M-L | **Yes** (scheduler vs AI log) |
| 19 | `DEMO_MODE` not refused in production on any route (mock-complete, reset, simulate-call, SMS echo) (18b M11, 18e A6, 18f N7) | DM (hardening) | PROD only if the flag leaks | S | No |
| 20 | Gratitude sweep always English (18f N4) | UF | PROD | S | No |
| 21 | Receptionist persona "Maria" hard-coded (18d P-05) | UF | PROD | S-M | **Yes** |
| 22 | `handoff_to_human` described as a transfer; `transfer_to_human` undescribed; `NATIVE_TRANSFER` off by default; forward on native line (18a B4, 18e D13) | UF / DC | PROD | S text / M live test | **Yes** (enable by default after the live test) |
| 23 | Receipt page claims "we texted you"; HVAC "tech" wording; `last4="----"` (18c F-02) | DC | PROD (off-path) | S | Brief (send receipt SMS or drop the claim) |
| 24 | Deposit model hard-coded: USD, card-only, $1-$500 cap, LLM picks the amount (18b M5) | UF | PROD | M | **Yes** |
| 25 | Plan price is free-text env, not from Stripe; caps not shown (18b M6, 18d P-11, 18c F-10) | DC / UF | PROD | S check / L multi-plan | **Yes** |
| 26 | `deploy.sh --seed` in production: wipe, fake live tenant, real agent plus shared-number rebind (18d P-12, corrected in 18f) | DM / ops hazard | PROD (explicit flag) | S | **Yes** (keep a prod demo tenant?) |
| 27 | No-LLM deploy makes "Paste your website" 422 for every user; prompt invites "plausible" services (18d P-09) | UF | PROD-misconfig | S | **Yes** (LLM mandatory?) |
| 28 | Tenant release / grandfather are manual scripts, not jobs (18b M7) | UF | PROD ops | S-M | **Yes** (auto-release is destructive) |
| 29 | Slot grid, lead time, horizon, capacity hard-coded (18b M12) | UF | PROD | M-L | **Yes** (single vs multi-crew) |
| 30 | Number search US-only, area code 305 default (18a B6) | UF | PROD | L | **Yes** (markets) |
| 31 | Timer-driven onboarding progress labels (18c F-04) | PF (cosmetic) | PROD | S spinner / M real stages | Yes, minor |
| 32 | Unverified provider call shapes (transfer config, initiation flags, live transcript, voices, DialCallDuration) (18a D) | UF (live test) | PROD | M | No |
| 33 | Non-prod Stripe error silently falls back to a mock link; mock billing checkout 404s without DEMO_MODE (18b M9, M11) | DM | DEV / staging | S | No |
| 34 | Non-prod ElevenLabs webhook/tool auth skipped without `ALLOW_INSECURE_DEV` (18f) | DM | staging | S | No |
| 35 | Static values: `agent-prompt` language constants; "EN" for unknown language; waveform is decoration; "ready" health GETs; default vertical hvac; hours prefill (18a C2, 18c F-06/F-08, 18f N9) | PF (cosmetic) | PROD | S | No |
| 36 | Signup verification-email failure invisible (18d P-13) | UF | PROD (provider outage) | S | No |
| 37 | Docs drift: README "Calendar internal, no OAuth", "scripted calls", "macOS say real audio", "seven tools", "today's revenue"; PRD contradictions (reschedule, owner reply, transfer, language detection, test counts); `.env.example` LLM comment; `env-vars.md` TWILIO "outside production only"; stale `scheduler.ts:2-3` comment; extraction docstring (18b M10, 18d drift, 18e D1-D22) | DC | n/a | S-M | **Yes** for D9/D10 in 18e (PRD source of truth; Calendar supported?) |

**Counts:** 37 backlog rows. PF 16 (incl. 3 cosmetic), UF 16, DM 4, DC 4 (some rows carry two classes). Owner decisions needed: 22 rows. No-decision quick wins (all S): #1, #2, #4, #5 (SMS), #7, #10, #15, #19, #20, #33, #34, plus #14 after a one-line decision.

**Suggested order:** #1+#2 (one change), #4, #5, #3, #7, #10, #19, #15, #14, #20. Then the decision items, asked one at a time: #6 (architecture) first, because it gates whether production AI calls work at all; then #8, #13, #9, #12, #16, #17, #11.

---

## 5. Resolution (mock cleanup, branch `claude/serene-clarke-fowr2c`)

Status per backlog row of section 4. **done** = implemented with regression tests; **skipped (decision pending)** = owner decision outstanding, another pass will do it; **documented** = copy/docs corrected to match the code. Tests: `tests/mock-cleanup-pure.test.ts`, `tests/integration/mock-cleanup.test.ts` (plus `billing-routes` updates).

| # | Status | What changed |
| --- | --- | --- |
| 1 | **done** | One policy, `smsDelivered(status)` (`src/lib/messaging/delivery.ts`): `sent` is delivered; `mock` only outside production. In production `sendSms` itself returns `failed` / `sms_provider_not_configured` instead of a mock. Used by every customer path of N6 (voice `send_sms`, booking confirmation and payment-link tools, `sendConfirmation` consent, change notices, owner reply, gratitude sweep, inbound rating lookup, booking panel, `/api/sms/send` -> 503). `sendAndLog` refunds the plan reservation and does not meter an undelivered text; follow-up consent is recorded only for a delivered text; the console echo of bodies is non-production only. |
| 2 | **done** | `owner-phone` and `forward-number` verify/start answer an honest `503 sms_provider_not_configured` (no code "sent"); the UI maps it to a localized message (EN/ES `err.smsNotConfigured`). |
| 3 | skipped (decision pending) | - |
| 4 | **done** | `PUT /knowledge`, `PUT /onboarding-status/knowledge` and `PATCH /businesses/:id` (name, owner name, website, area, hours) call `syncPromptAfterEdit` (`resyncAfterKbChange` + `markAgentDirty` on failure) and return `agent_sync`. The editor toast is honest (`kb.ed.saved` / `savedPending` / `savedNoAgent`, EN+ES). Owner-call-in apply/revert also queue a retry on failure. |
| 5 | **done** (SMS) | Purchase sets `SmsUrl`/`SmsMethod` (and `VoiceUrl` only when `lineKind()==='webhook'`). New admin route `POST /api/admin/repair-numbers` (dry run by default, batched, idempotent, audited; never touches the platform sender, mock-pool numbers or a native line's Voice URL). Documented in runbook, env-vars, auth.md. Voice import of the native line stays with #6. |
| 6 | skipped (decision pending) | - |
| 7 | **done** | `consent_status='disclosed'` on the incoming route needs a real agent refresh, or the scripted demo outside production; production without `ELEVENLABS_API_KEY` stays `unknown`. |
| 8, 9 | skipped (decision pending) | - |
| 10 | **done** | `syncAgent` loads the stored KB when `kb` is null (a load error fails the sync and leaves the old prompt). |
| 11-14 | skipped (decision pending) | #14: README and `CONTRACTS.md` now state the `/pay/<bookingId>` limitation honestly (documented). |
| 15 | **done** | The demo console page is `notFound()` unless `demoModeEnabled()`; the nav item and the onboarding link are hidden; integration badges use the real readiness checks (`hasTwilio`, `hasElevenLabs`, `hasLlm`). HVAC-only scripts left (page is not reachable in production). |
| 16-18 | skipped (decision pending) | - |
| 19 | **done** | `demoModeEnabled()` is false when `NODE_ENV==='production'` (mock-complete, reset, simulate-call, mock-activate, demo console, Stripe-error fallback, SMS echo). Tests that rely on `DEMO_MODE` keep working in the test environment. |
| 20 | **done** | The gratitude sweep texts in the booking's call language, falling back to the business `locale_default`. |
| 21-31 | skipped (decision pending) | - |
| 32 | untouched (live test needed) | - |
| 33 | **done** | A Stripe error with a real key throws unless `DEMO_MODE=true` (never in production); mock billing checkout answers 503 instead of a link that 404s unless `DEMO_MODE=true`. |
| 34 | **done / corrected** | The skips already required `ALLOW_INSECURE_DEV` (`isProd = () => !insecureDevAllowed()`): the 18f/18a E4 claim was wrong. The misleading `isProd` name and log lines were fixed (`authStrict`) and a test pins the behaviour; docs corrected. |
| 35 | **done** | The four webhook GET probes report real readiness (200/503 by secret configured, `readiness()`); the unknown-language badge shows an em dash instead of "EN"; the waveform is documented in code as decoration (progress is the only real signal). Default vertical, `agent-prompt` language constants and the hours prefill are unchanged (cosmetic). |
| 36 | **done** | A failed deferred verification email (signup and public resend) is logged at error level and audited (`auth.verification_email_failed`, class only); the "check your email" hint says the page cannot know whether it went out and points to resend/support. The response stays identical for every address (anti-enumeration). |
| 37 | **documented** | README, PRD (reschedule, owner reply, transfer, language detection, calendar sync, test counts, tool count, demo console, audio, LLM fallback), `env-vars.md`, `.env.example`, `CONTRACTS.md` `/pay/[id]`, `scheduler.ts` header, extraction docstring, runbook step 5, `known-limitations.md`, `auth.md`. Not decided here: which PRD section is the product source of truth for D9/D10 (the text now follows the code). |

Also fixed in passing: the N6 `owner-alert` check now uses `demoModeEnabled()`.


## 5B. Resolution, agent B (messaging / inbox / privacy)

| # | Status | What changed |
| --- | --- | --- |
| 8 | **done** | `businesses.review_url` is the only source (Settings card `rv.*`, `PUT /api/businesses/:id/review-url`, owner only, audited). `reviewUrl()` and the `REVIEW_URL` env fallback were removed; with no link the 4-5 star reply is a thank-you without a link (never the placeholder, never another tenant's link). Review and gratitude texts are signed `<assistant_name or Maria>, <business>`; the review request follows the booking's call language. |
| 16 (N3) | **done** | `src/lib/messaging/inbox.ts` (`handleInboundText`) behind `POST /api/sms/inbound`: sid-deduped `recordInboundMessage`, per-sender 10/h and per-business 300/h flood limits, forward through `alertOwner` (verified owner phone only, quiet hours skipped, `INBOX_FORWARD_HOURLY_LIMIT` budget, once per message via `markInboundForwarded`, stamp reverted when the text did not go out), one auto-reply per sender per 24 h (`inbox_autoreply`, `sendAndLog`: opt-outs, plan cap, STOP footer; EN/ES from the text or the business locale, trade word, assistant name). STOP handling stays first. UI: `/dashboard/messages` (inbox with new/handled/ignored filters, detail with full number, conversation thread, mark handled / ignore / reopen, reply), sidebar badge with the new count. Owner voice channel hook: a new inbox text from a number that also has a call or booking becomes a `text` lead in `reply-leads.ts`. Residual: a sender with no call/booking is not a voice-reply lead (`owner_replies.lead_kind` CHECK is `call`/`booking`; a schema change would be needed). |
| 17 (part) | **done** for manual text, SMS log, privacy; **not done** for deposit link request/resend | Manual text to a known customer and replies (`sendManualText`, 320 chars, STOP footer, quiet hours, opt-out, plan cap, per-business 40/h and per-recipient 6/h); Text log tab (sent with status / received); owner-only privacy card (lookup counts, JSON export, typed-confirmation erase) with step-up, rate limits and audit rows. Deposit link request/resend belongs to the payments agent. |


## 5A. Resolution, agent A (voice / telephony)

| # | Status | What changed |
| --- | --- | --- |
| 3 | **done** | Provisioning refuses (503 `voice_provider_not_configured`, nothing bought, business stays `onboarding`, audited) when `ELEVENLABS_API_KEY` is missing in production or with real Twilio configured; a mock agent in those conditions is a 502 after the number is kept; `deploy.sh` requires the key when Twilio is configured. Outside both (local demo, tests) the mock agent still works. |
| 6 | **done (provider shapes unverified)** | Each purchased number is imported into ElevenLabs and bound to ITS tenant's agent (`elevenlabs-phone.ts`, `tenant-line.ts`); `bindPhoneNumber` uses the tenant's own `elevenlabs_phone_number_id`; the shared env number is a single-business fallback and is never rebound across tenants; admin repair imports existing numbers (dry run default); release deletes the import; the per-call rebinding in `/api/voice/incoming` is gone. The webhook-line AI answer goes through register-call TwiML (unverified) or an honest voicemail. |
| 5 / N2 (voice side) | **done** | The import hands the Voice URL to ElevenLabs; the SMS URL stays ours (`configureNumberWebhooks(..., { skipVoiceUrl })` after an import); a forced `webhook` deployment keeps the Voice URL on `/api/voice/incoming`. |
| 10 / N5 | **done** (already by batch 1; verified) | `syncAgent` loads the stored KB when `kb` is null. |
| N8 | **done** | Every branch of `/api/voice/incoming` returns TwiML to a signed Twilio call (out-of-service, unknown number, owner line, AI, an internal error). |
| 21 | **done** | `businesses.assistant_name` (default "Maria") in the first message, prompt, owner prompt; Settings card; `PATCH /api/businesses/:id/line`. Customer SMS templates carry no persona name, so nothing to change there. The demo seed data keeps its fixed "Maria" (fixture). |
| 22 | **done (default stays OFF)** | `handoff_to_human` is described and prompted as "text the owner and offer a callback"; `transfer_to_human` is described properly and exists only for a business that opted in (`native_transfer_enabled` + `NATIVE_TRANSFER=on`). Whether to turn the capability ON by default still waits for the live transfer test (decision pending). |
| 32 | **partial** | The unverified phone-number / register-call shapes are isolated in one module with documented schemas and graceful errors; they still need the live test (runbook section 8). The older transfer-config / initiation / voices shapes are untouched. |


## 5C. Resolution, agent C (bookings / payments)

Tests: `tests/booking-payments-pure.test.ts`, `tests/integration/booking-payments.test.ts` (database-gated; roles, tenant isolation, CSRF, step-up, crews, quiet hours, manual deposits never reaching Stripe, the `/pay` page in production), plus the updated `voice-tools` and `review2` tool tests.

| # | Status | What changed |
| --- | --- | --- |
| 14 | **done** | `/pay/<bookingId>` never renders the card form in production (or outside production without `DEMO_MODE=true`): a live Payment Link redirects to its `buy.stripe.com` URL (looked up on Stripe, host checked, cached 60 s, 60 lookups a minute per process), a paid booking shows the receipt, anything else shows "this link is not available, contact the business" with the business's AI line to call; a cancelled booking never forwards. `last4` removed. |
| 17 (deposit link, manual paid) | **done** | Booking panel: request / resend the deposit link (`POST /api/bookings/:id/deposit`, policy-bound, previous link deactivated, `send:false` returns the link to copy), mark paid manually (owner, step-up, audited, `deposit_source='manual'`, open Stripe link deactivated), undo a manual mark. The privacy and manual-text parts of #17 are agent B's. |
| 18 / M4 | **done** | Owner "New booking" dialog (calendar toolbar, a click on an empty slot of the week / day grid with the day and half hour prefilled, and the agenda tab), edit dialog (name, number, service, address, price estimate, length), reschedule dialog unchanged, no-show (a cancellation after the start, no customer text), cancel, request / resend deposit, mark paid, manual refund record. Server: `POST /api/bookings`, `PATCH /api/bookings/:id` (edit), `GET /api/bookings/slots`. Same engine as the AI, `created_via='dashboard'`. |
| 23 | **done** (honest copy) | The receipt says "Your deposit is paid and your appointment is confirmed" and "keep this page and the reference"; no text is claimed, no "tech" wording, no card row. No receipt SMS is sent (decision: honest copy). |
| 24 | **done** (USD, card only unchanged) | Per-business deposit policy (off, fixed or percentage, min / max inside the platform limits 100..100000 cents), Settings > Deposits card (EN / ES), `GET/PUT /api/businesses/:id/deposit-policy` (owner, audited). The amount is computed on the server (`computeDepositCents`): the voice tool ignores `amount_cents` (the spec lists only `description` and `booking_id`), refuses when the policy is off, and only touches a booking made on that call; the call script's $500 cap stays on top for the AI. Owner requests must fit the policy range. Currency and payment methods are still the Stripe Payment Link defaults (USD, card). |
| 25 | **done** | `src/lib/billing/price.ts` reads `STRIPE_PRICE_ID` / `STRIPE_PRICE_ID_ANNUAL` from Stripe (cached 10 min, failure remembered 60 s, fail-soft to the `NEXT_PUBLIC_PLAN_PRICE_DISPLAY*` text); Billing, the onboarding plan step and the landing page show amount / interval; the caps lines come from the same functions as the metering (`PLAN_*`, `TRIAL_*`, `BILLING_TRIAL_DAYS`). |
| M3 | **done** | See #17. |

Residual / not done: per-service deposit amounts, non-USD currency and wallets, a receipt SMS, per-booking notes, and an automated live test against Stripe (the Price GET and Payment Link GET shapes are written from Stripe's documented API and exercised only against fakes).


## 5D. Resolution, agent D (platform / scheduling / audio / ops)

No migration (the Phase 1 columns and helpers are used as built: `slot_minutes`, `min_lead_minutes`, `horizon_days`, `buffer_minutes`, `crews`, `bookings.crew`, `content_confirmed_*`, `briefing_audio`). Tests: `tests/platform-d-pure.test.ts`, `tests/integration/platform-d.test.ts` (plus updates to `phase2-pure`, `verticals-pure`, `jobs-schedule`, `availability`).

| # | Status | What changed |
| --- | --- | --- |
| 9 | **done** | Template content gate. The template no longer carries "Miami-Dade County" (`templateResult(name, vertical, lang, serviceArea = [])`: the owner's own area or empty); the service area is a go-live BLOCKER (`kb/readiness`); going live needs the owner to confirm services / prices / service area (`POST /api/businesses/:id/content-confirmation`, fingerprint contract: a change makes it `stale`), enforced by the provision route through `readinessForGoLive` (`src/lib/kb/readiness-server.ts`; admins keep their override; a business that is already live is not re-gated). Onboarding review has the confirm checkbox (EN/ES), the Knowledge page a confirm card. The website prompt no longer asks for "plausible" services or an area "inferred from the name". |
| 11 | **done** | Editable time zone: `GET/PUT /api/businesses/:id/timezone` (owner, IANA only, audited, agent resync, `hours_recheck`), Settings card, onboarding field on the verify step pre-selected from the owner's phone area code (a suggestion: saved only when the owner continues), US/Canada list with DST-aware offset labels (`src/lib/tz-options.ts`). Everything already read `business.timezone` (`tzOf`). |
| 12 | **done (provider shape unverified)** | Briefing audio: ElevenLabs TTS with the business `voice_id` (else `ELEVENLABS_VOICE_ID`, else the default voice id), stored with `saveBriefingAudio`; `GET /api/briefings/:id/audio` (staff+, tenant scoped, Range, ETag/304, private cache); `POST` regenerates (owner, rate limited, audited); the macOS `say` / `afconvert` path and every disk write are gone; the player and the list say "audio unavailable" (EN/ES) with an owner "Generate audio" button; `cleanup` prunes after `BRIEFING_AUDIO_KEEP_DAYS`. A failed regeneration deletes the stale audio of the older text. |
| 13 / 27 | **done** | LLM required in production: `deploy.sh` dies without a key, boot logs an error banner, `/api/health` answers 503 `llm_not_configured`. Runtime fallbacks are labelled: call summaries are stored `[auto] ...` and shown as "Auto excerpt"; the briefing's automatic text is stored with `stats.narration = 'automatic'`, starts with "automatic summary" and states only data-derived facts (the invented "dejar todo listo", "cliente quedó tranquilo", "la manejé completa", "dinero seguro" are gone); the LLM prompt forbids unstated actions. Website import says it needs the LLM (hint on the screen + 422 text). |
| 26 | **done** | `deploy.sh --seed` is refused outright (exit 2), `scripts/seed.ts` refuses `NODE_ENV=production`, the compose tools container no longer defaults to the seed command. |
| 28 | **done (acts only when switched on)** | `tenant_release` and `grandfather` are admin jobs of the runner (`src/lib/jobs/tenants.ts`): dry run by default; a real run only with `TENANT_RELEASE_JOB=on` (otherwise the report says `refused_not_enabled`); `report` stores a daily dry-run report; max 10 releases per run; audit-only state (`jobs.tenant_release_report`, `jobs.grandfather_report`, plus the existing `billing.*` rows) shown in `GET /api/admin/jobs`. The two scripts remain as operator CLIs and also need the switch for `--apply`. |
| 29 | **done** | Configurable slot grid, notice, horizon, buffer, crews: enforced by `slotsForDate`, `nextAvailable`, `slotsForMove`, `validateSlot` (`too_soon`, `too_far`), `createBooking` / `rescheduleBooking` (owner-initiated moves skip notice + horizon), Google busy blocks (buffer applies), the per-crew DB constraint, and the voice tools (messages say the real horizon). Settings > Scheduling (`GET/PUT /api/businesses/:id/scheduling`, owner, audited, 409 `crew_in_use`) with crews help text. |
| 31 | **done** | The onboarding website step shows two real stages (the single read/extract request, then saving) instead of timer-driven labels. |
