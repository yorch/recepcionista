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
