# 18d. Mock / stub / placeholder inventory: platform slice

Slice: auth, signup, email, captcha, `src/lib/demo/**`, `src/app/api/demo/**`, seed data, LLM usage (extraction, summaries, briefing, fallbacks without a key), website extraction, `scripts/`, Docker/compose/deploy.sh, env defaults.
Method: every item below was confirmed by reading the code at the cited line. Nothing is inferred from names alone. Read-only review; no repo file other than this report was touched.

Reach legend: **PROD** = reachable in a production build with normal config; **PROD-misconfig** = reachable in production only when an optional key is absent (and deploy.sh does not refuse that); **DEV/DEMO** = needs `DEMO_MODE=true` or non-production; **TEST** = tests/scripts only.
Size: S under half a day, M 1-3 days, L more. **Decision** = needs an owner product decision first.

## Verdict on the slice

Auth, signup, captcha and email are NOT mocked in production. The `log` email provider and the unset-provider case both fail closed with `EmailConfigError` (`src/lib/email/index.ts:55-75`); signup refuses with 503 when email is unconfigured (`src/app/api/auth/signup/route.ts:68`); captcha has no fake path (`src/lib/signup.ts:58-82` fails closed; `src/lib/signup-config.ts:16-21`); `deploy.sh:82-112,114` refuses `log`, `DEMO_MODE`, `ALLOW_INSECURE_DEV`, `STRIPE_ALLOW_UNSIGNED`, `GOOGLE_OAUTH_MOCK`. The real exposure in this slice is the LLM/TTS "silent template fallback" family and one misleading admin page.

---

## Ranked findings

### P-01. Provisioning goes "live" with a MOCK agent when `ELEVENLABS_API_KEY` is unset (fake success)
- File: `src/lib/voice/elevenlabs.ts:592-595` (returns `{agent_id: 'mock_agent_<id>', mock: true}` with no production guard; `isProd()` at :31 is only used for webhook/tool-secret auth), consumed at `src/app/api/businesses/[id]/provision/route.ts:318-357`.
- What is mocked: agent registration. With no key `syncAgent` returns a mock result with no `error`, so `agentFailure` stays null, the id is never saved (`!agent.mock` guard at :323), but `updateBusiness(id,{status:'live'})` runs at :350 and the response is 200 with `agent_mock: true`.
- Reach: PROD-misconfig. `deploy.sh:63-69` only checks ElevenLabs secrets when `ELEVENLABS_API_KEY` is set; it never requires the key itself (the Twilio-missing case gets a warning at :208-210, ElevenLabs gets nothing). `.env.example:116` leaves the key blank.
- Impact: a paying business is shown "live" with a purchased Twilio number but no AI agent behind it. Calls go unanswered by AI. The UI shows the mock note only if it reads `agent_mock`; the status badge says live.
- Real implementation: make `syncAgent` return `error: 'elevenlabs_not_configured'` in production (like Twilio's `phone_provider_not_configured` 503) and have provision refuse before buying a number; add ELEVENLABS_API_KEY to deploy.sh required list (or an explicit opt-out). Cross-slice (voice, see 18a) but the deploy gap is mine.
- Size: S. Decision: no (it is a bug, fail-closed matches the stated policy for Twilio/Stripe).

### P-02. Post-call "AI summary" silently becomes a truncated transcript excerpt without an LLM key
- File: `src/lib/voice/postcall.ts:294-312` (`summaryFallback`), used at :592-624 via `generateTextSafe(..., fallback)`; `src/lib/providers/llm.ts:200-215` returns `{value: fallback, mocked: true}`; the `mocked` flag is discarded here.
- What is canned: the stored `calls.summary` is "Routine. <first spoken line, 140 chars>. <last line matching tech|booked|scheduled|tonight|tomorrow|dispatch|sent>", not a summary. Also used on any LLM error/timeout.
- Reach: PROD (no LLM key, or provider outage). `deploy.sh` does not require `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`; `.env.example:107` says "Leave unset and extraction/briefing fall back to templates instead of failing" (stale for extraction, see P-09).
- Impact: Calls list, call detail, the owner's briefing facts and the emergency/handoff context show a first-sentence excerpt as if it were a summary. ElevenLabs' own `analysis.transcript_summary` is preferred when present (:593), which softens this.
- Real implementation: nothing external needed for correctness; needs a stored `summary_source` (`provider|llm|excerpt`) and a UI label ("excerpt, not summarized"), plus a deploy.sh/boot warning when no LLM key. LLM key is the provider requirement.
- Size: S. Decision: yes (is "no LLM key" a supported production mode, or must deploy.sh require a key?).

### P-03. Evening briefing narration is a canned template without an LLM key, and asserts things that were not checked
- File: `src/lib/briefing/index.ts:92-170` (es) and :173-248 (en) `fallbackScript`; chosen at :256 and :283-315 (`generateTextSafe` + word-count guard returns `fallback`); `mocked` ignored.
- What is canned: fixed sentences such as "Aproveché para dejar todo listo para mañana" / "I used the time to get everything ready for tomorrow" on a zero-call day (:105,185), and "A todas les tomé los datos, el problema y la dirección" / "I took the details, the problem and the address on every one" (:147,225) whenever more than one call has a non-empty `summary`, regardless of whether an address was actually captured. Names, times and dollar figures are real; the activity claims are static.
- Reach: PROD (no key / LLM failure / out-of-range word count).
- Impact: owner hears a first-person claim that was never verified (it also fires when the "summary" is the P-02 excerpt). Briefing page and texted link give no indication it is templated.
- Real implementation: LLM key for the real path; for the fallback, remove unverifiable claims (derive from data or drop) and store `narration_source`.
- Size: S. Decision: no for removing false claims; yes if you want the template to remain at all.

### P-04. `/dashboard/demo` ("Demo console") is a live admin nav item in production whose buttons cannot work, and its status badges are wrong
- Files: nav entry `src/components/dashboard/shell.tsx:30` (gate `'admin'` only; never hidden by `DEMO_MODE`); page `src/app/dashboard/demo/page.tsx:15-81`; client `src/components/dashboard/demo-tools.tsx:34-58` calls `/api/demo/simulate-call` and `/api/demo/reset`, which 404 unless `DEMO_MODE=true` (`src/app/api/demo/simulate-call/route.ts:111`, `reset/route.ts:24`). `compose.production.yaml:216` forces `DEMO_MODE=false`.
- What is faked/dead: in production every admin sees a "Demo console" with "Call her" and "Reset" that return 404 (toast shows a generic error). The "Integrations" badges are static env reads and inaccurate: LLM shows "mock" when only `ANTHROPIC_API_KEY` is set (`page.tsx:76-77` checks `OPENAI_API_KEY` only, while `hasLlm()` accepts either); Twilio keys on `TWILIO_AUTH_TOKEN` alone (:70) though live needs SID+token+phone (`src/instrumentation.ts:46-50`); the badge label "live" is shown for a key that is merely present.
- Reach: PROD (admin role: break-glass token or admin user).
- Impact: dead UI for operators; misleading integration status; the subtitle promises "reset to clean state" which would wipe all tables if it did work, so hiding it is also a safety win.
- Real implementation: hide the nav item and make the page 404 unless `demoModeEnabled()`; if an integrations health view is wanted, build a real one from a shared `providerSummary()` (already in `src/instrumentation.ts:26-53`).
- Size: S. Decision: no.

### P-05. Voice agent persona "Maria" is hard-coded for every tenant
- File: `src/lib/voice/elevenlabs.ts:143-148` (`firstMessageFor`: "this is Maria ... le habla Maria"). Also demo copy `src/lib/demo/seed-data.ts:174`.
- What is static: the receptionist's name is a literal; the owner cannot choose it, and `docs`/UI refer to the assistant as "she/her".
- Reach: PROD.
- Impact: every business's customers hear "Maria" on every call, including a business that would not want that name or gender. Not a mock but hard-coded demo persona leaking into the product path.
- Real implementation: `businesses.agent_name` column (default "Maria"), settings field, thread into prompt + first message + SMS signature.
- Size: S-M. Decision: yes (persona name/gender configurable or fixed brand?).

### P-06. Every tenant is created in `America/New_York`, and the time zone is display-only (no way to change it)
- Files: default `src/lib/time.ts:7` (`DEFAULT_TIMEZONE`), applied at `src/lib/db/index.ts:492`; `src/app/api/businesses/[id]/settings/route.ts:43` ("timezone is display-only"); read-only render `src/components/dashboard/settings-form.tsx:64-66`. The seed business is also Miami (`src/lib/demo/seed-data.ts:163`). `businessPatch` can write it (`src/lib/db/index.ts:276`) but no route or UI sets it.
- Impact: a business in Chicago/Los Angeles gets hours, slots, quiet hours (9pm-8am texts), the 6 PM briefing, usage-month boundaries and calendar all computed in Eastern time. Wrong bookable hours are a real-money failure. The "Time zone" row looks like a configured setting but is a hard-coded default.
- Real implementation: capture IANA zone at onboarding (infer from owner phone area code, confirm with a select), make it editable in Settings with audit and a re-check of stored hours/closures.
- Size: M. Decision: yes (US-only zones? infer vs ask?).

### P-07. Template knowledge base: invented prices and a fixed "Miami-Dade County" service area for any business created without a URL
- File: `src/lib/extraction/index.ts:42-54` (`templateResult`: service area `['Miami-Dade County']`, pack default prices e.g. `src/lib/verticals/packs/hvac.ts:12-15` AC Repair $120, Install $2500, Emergency $195), used at `src/app/api/businesses/[id]/provision/route.ts:207` when a business has no `url` and no stored KB.
- Reach: PROD via API (`POST /api/businesses` without `url`, then provision). The onboarding UI's manual path (`src/app/onboarding/step-info.tsx:104-113`) hands the user a blank draft first; I did not confirm that the UI always persists a KB before provisioning, so the direct-API path is the verified one.
- Impact: the minimum-content gate (`src/lib/kb/readiness.ts:50-60`: 3 priced services, hours, 1 FAQ) is satisfied by template data, so a tenant who never reviewed anything gets an agent quoting the vertical pack's starting prices and a Miami service area (the readiness service_area item is only a warning). The extraction docstring promises "never a silent fallback" but this is one.
- Real implementation: refuse provisioning for non-admins when KB `source` is `template` (store `source` and a "confirmed by owner" flag), or drop `Miami-Dade County` for an empty list.
- Size: S-M. Decision: yes (are pack prices acceptable as defaults, or must the owner confirm every price?).

### P-08. Briefing audio: macOS `say` fallback cannot run in the Linux image; ElevenLabs outage or a missing voice id silently yields no audio; the owner's chosen voice is ignored
- File: `src/lib/briefing/tts.ts:29-31,64-78,93-112`. `localSay` shells out to `say -v Paulina` and `afconvert` (macOS only). `Dockerfile:101` is `node:24-bookworm-slim` with neither binary, so in the container the fallback always throws and returns `{audio_url:null, mock:true}` (:111; `mock` is never read by any caller: grep shows only `tts.ts` uses `TtsResult.mock`).
- Also: `hasElevenLabsTts()` requires BOTH `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` (:30); with the key set and the voice id blank (the agent code defaults the voice, `src/lib/voice/elevenlabs.ts:25,462`, so the platform "works"), briefings get no audio, logged only at debug (:102). The TTS voice is the single env voice, not the business's selected `voice_id` that the live agent uses.
- Reach: PROD. Landing copy promises "a short voice briefing each evening" (`src/lib/i18n/catalog/publicPages.ts`, land.step3.d, land.f5.d).
- Impact: owner sees a transcript with a missing/disabled player; no warning; briefing voice differs from the agent voice.
- Real implementation: ElevenLabs TTS with the same default voice fallback as the agent and per-business voice; surface "audio unavailable" in the UI; drop or dev-gate `say`. README says macOS `say` is "real audio" (`README.md:352`), true only on a Mac dev box.
- Size: S. Decision: no.

### P-09. Website extraction: no-LLM state is a hard failure in code but `.env.example` and the landing page say otherwise; the prompt invites invented services
- Files: `src/lib/extraction/index.ts:298-314` (throws `no_llm`/`llm_failed`; good), `.env.example:107` ("fall back to templates instead of failing", stale), prompt rule `src/lib/extraction/index.ts:114` ("If unclear, include the most plausible generic services for its trade and set confidence to low"), `sanitize` keeps those services (:193-205) and only requires `services.length > 0` (:318).
- Reach: PROD. `deploy.sh` does not require an LLM key, so a deployment can ship with onboarding's "Paste your website" step (the landing page's headline promise, `land.h1.*`, `land.step1.d`) returning 422 "LLM API key is not configured" for every new user.
- Impact: either a dead core feature (no key) or LLM-fabricated "plausible" services with low confidence (shown to the owner for review; prices stay null per :113).
- Real implementation: LLM key (OpenAI or Anthropic) and either require it in deploy.sh or hide the URL step when `hasLlm()` is false; remove the "most plausible" instruction or mark such services `inferred` in the UI.
- Size: S. Decision: yes (is the LLM mandatory for the product?).

### P-10. Pay page / mock checkout default business name `Miami Cool Air Conditioning`
- File: `src/app/pay/[id]/page.tsx:33,126`. Reached only for `mock_*` ids outside production (`isMockId && !isProd`, :122).
- Reach: DEV/DEMO only (production 404s). Listed because the literal is demo data in a product file. Cross-slice: billing/payments (18b).
- Size: S. Decision: no (delete after seed data is moved, see P-12).

### P-11. Plan price on the marketing and onboarding pages is a free-text env string, not read from Stripe
- Files: `src/app/site-config.ts:15-23` (`NEXT_PUBLIC_PLAN_PRICE_DISPLAY[_ES]`, `_ANNUAL`), default text "Simple monthly pricing, with a free trial" (`publicPages.ts`, site.priceDefault); trial length separately `BILLING_TRIAL_DAYS`.
- Reach: PROD. Inlined at build time (`docs/known-limitations.md` notes a rebuild is needed).
- Impact: the displayed price can silently diverge from `STRIPE_PRICE_ID`'s real amount; nothing validates it. Default shows no price at all.
- Real implementation: read the Price object from Stripe at build/boot (or in a cached server fetch) and render amount/interval/trial; fall back to text only when Stripe is unreachable.
- Size: S-M. Decision: yes (show price publicly? currencies/annual wording).

### P-12. Demo dataset is a product-path dependency (reset route, seed script, deploy `--seed`)
- Files: `src/lib/demo/seed-data.ts` (Miami Cool Air business `biz_miami_cool_air`, `+13055550142` / owner `+13055550199`, fake `example.com` URLs, fake SMS `providerId: 'SM_demo_*'`, "Maria" prompt), `scripts/seed.ts:22-60`, `src/app/api/demo/reset/route.ts:21-53`, `compose.production.yaml:88-98`, `deploy.sh:255-259`.
- Reach: DEV/DEMO for `reset`/`simulate-call` (`DEMO_MODE=true`, refused by deploy.sh:114). BUT `./deploy.sh --seed --i-know-this-wipes-data` is a supported PRODUCTION command (README.md:130) that truncates every table and inserts a fake `status: 'live'`, `billingStatus: 'active'`, `plan: 'demo'` business with a verified owner phone (`seed-data.ts:250-256`), then calls the live provision endpoint (`scripts/seed.ts:68-121`), which can purchase a real Twilio number and register a real agent for a fictional business. The flag guard is only the confirmation flag.
- Impact: a mistaken or lazy production seed destroys data and creates a comped, "live" fake tenant billed to nobody that also texts `+1305555...` numbers.
- Real implementation: remove `--seed` from deploy.sh/compose (keep seed for dev DB only), or make the seeded business `provisioned: false` and never call provision when `NODE_ENV=production`.
- Size: S. Decision: yes (is a production demo tenant ever wanted, e.g. for sales demos?).

### P-13. Post-verification-email send failure is invisible to the user
- File: `src/app/api/auth/signup/route.ts:95` (`afterResponse('signup.verification', () => sendVerificationEmail(created.user))` after already answering `accepted()`).
- Not a mock: the account is created and "check your inbox" is shown even if Resend rejects the send (logged only). There is a resend-verification route and form (`src/components/auth/resend-form.tsx`), so recovery exists.
- Reach: PROD (provider outage). Impact low-medium. Real implementation: a "didn't get it?" prompt on the verify-email-sent page with a status; alert on repeated failures.
- Size: S. Decision: no.

---

## Deliberate dev/demo/test-only items (classified, no action unless noted)

| ID | File:line | What | Reach | Notes |
|---|---|---|---|---|
| D-01 | `src/lib/email/index.ts:55-66,101-105` | `EMAIL_PROVIDER=log` writes message and link to the app log; unset provider defaults to `log` | DEV only | Production throws `EmailConfigError`; `deploy.sh:82-88` refuses. Correct. |
| D-02 | `src/lib/signup-config.ts:17` | signup open with no captcha outside production | DEV only | Production needs Turnstile pair or explicit `SIGNUP_ALLOW_WITHOUT_CAPTCHA=true` (loud warning at boot and deploy). Correct; the waiver is a deliberate owner decision. |
| D-03 | `src/lib/auth.ts:96,233`, `src/lib/session.ts:14` | `ALLOW_INSECURE_DEV` open admin; `DEMO_MODE` | DEV only | Both forced off by `compose.production.yaml:216,219` and deploy.sh:114. |
| D-04 | `src/app/api/demo/simulate-call/route.ts:154-205,221-343` | Canned call scripts (3 transcripts, hard-coded `$150/$189/$129`, caller `+13055550123`, address `1200 Brickell Ave`, duration `168`) driving the real tools in-process, bypassing tool-secret and agent-id binding; `simulated` flag is `!booking` (misnamed: a successful booking is still a fake call) | DEMO_MODE | Admin-guarded. The in-process path skips real auth by design. |
| D-05 | `src/app/api/demo/reset/route.ts:21-53` | Wipes all tables (`clearAll`) and reseeds | DEMO_MODE | Admin + `DEMO_MODE`; leaves one audit row. |
| D-06 | `src/app/api/billing/mock-activate/route.ts:18`, `src/app/api/pay/mock-complete/route.ts:15` | Mock Stripe checkout activation and mock "Pay" | DEMO_MODE, non-production, no Stripe key | Double-gated (`NODE_ENV`, key, `DEMO_MODE`). Cross-slice (18b). |
| D-07 | `scripts/smoke.ts`, `scripts/ws1-test.ts`, `ws1-fixture-test.ts`, `ws3-test.ts`, `ws4-test.ts`, `ws5-test.ts` | Ad-hoc scripts that write real rows, use `bk_demo_*` ids, `pay.example.com`, accept `sent` or `mock` statuses, re-seed afterwards | TEST | All call `assertSafeDatabase` (`scripts/_safe-db.ts:156-173`); smoke refuses non-local servers. `scripts/ws1-test.ts:74` leaves test rows. Candidates to fold into `tests/` or delete (they overlap `bun test`). Not shipped in the runner image. |
| D-08 | `tests/helpers/env.ts`, `tests/helpers/fake-elevenlabs.ts`, `fake-google.ts`, `virtual-authenticator.ts` | Provider doubles; keys stripped and `fetch` guarded | TEST | Fine. `docs/known-limitations.md` states no test places a real call/SMS/email. |
| D-09 | `scripts/seed.ts`, `scripts/db-reset.ts`, `scripts/create-user.ts` | Dev seed/reset; create-user takes no password argv, marks email verified | DEV (create-user is a real operator tool) | seed guarded by `_safe-db`; in compose seed profile `--force-i-know` overrides it (see P-12). |

## Verified NOT mocked in this slice

- Email: Resend (`src/lib/email/index.ts:107-126`) and SMTP (:128-150) are real adapters with timeouts and typed errors; no fake success path.
- Turnstile verification calls Cloudflare siteverify and fails closed (`src/lib/signup.ts:58-82`); the widget (`src/components/auth/turnstile.tsx`) renders nothing without a key and signup availability is computed server-side.
- Login, 2FA, passkeys, sessions, invites, reset flows: no demo accounts, no hard-coded credentials found in `src/lib/auth.ts`, `session.ts`, `password.ts`, `totp.ts`, `webauthn.ts`.
- `/api/health` is a real `SELECT 1` (`src/app/api/health/route.ts:26-33`). It reflects the database only, not providers; nothing fakes readiness, but "healthy" does not mean Twilio/ElevenLabs/LLM/email work (see P-01, P-02, P-09). `scripts/verify-deploy.ts` (post-deploy) skips secrets that are unset and only fails on `--strict`.
- Website fetch is SSRF-guarded and real (`src/lib/extraction/index.ts:56-93`, `src/lib/net/safe-fetch.ts`).
- Dockerfile / compose: production compose sets `DEMO_MODE=false`, `ALLOW_INSECURE_DEV=false`; the `seed` service is profile-gated. `compose.dev.yaml` uses a throwaway dev password bound to loopback.
- LLM adapter has no canned model output of its own: with no key `generateText` throws and `generateJson`/`generateTextSafe` return the caller's fallback with `mocked: true` (`src/lib/providers/llm.ts:158-215`). Callers: extraction (throws on mocked), briefing (ignores `mocked`, P-03), post-call summary (ignores, P-02), demo simulate-call (DEMO only).

## Documentation drift (claims vs code)

- `README.md:100,116,232-240,350-358`: "leave them blank to keep the mocks" and a "What is real vs mocked" table that says Calendar is "Intentionally internal, no OAuth, no external sync" (`README.md:352-362`), but Google two-way sync ships (`src/lib/integrations/google/*`, deploy.sh:92-96). Briefing audio "real audio with macOS say" is Mac-only (P-08). README's mock narrative also conflicts with production fail-closed behaviour.
- `.env.example:107-108` LLM comment says extraction falls back to templates (it throws, `src/lib/extraction/index.ts:298-314`).
- `.env.example:19-24` ships `recepcionista.example.com` as live-looking values for `DOMAIN`/`APP_URL`; deploy.sh does not reject `*.example.com`, so an unedited copy would try to obtain a certificate for it. S, decision no.
- `src/lib/extraction/index.ts:1-7` docstring "never silently fall back to hardcoded template data" is contradicted by `templateResult` use in provision (P-07).

## Summary by class

| Class | Count | IDs |
|---|---|---|
| Prod fake-success / silent degrade | 4 | P-01, P-02, P-03, P-08 |
| Prod misleading or dead UI | 2 | P-04, P-11 |
| Prod hard-coded tenant assumptions | 3 | P-05, P-06, P-07 |
| Prod ops/deploy hazard | 2 | P-12, P-09 (no-LLM deploy) |
| Low / UX | 1 | P-13 |
| Dev/demo-only (deliberate) | 9 | D-01 to D-09, plus P-10 |
| Doc drift | 4 | see section above |

## Owner decisions needed (ask one at a time)

1. Is production allowed to run without an LLM key? If no, deploy.sh requires one and P-02/P-03/P-09 become hard errors; if yes, summaries and briefings must be labelled as non-AI. (P-02, P-03, P-09)
2. Should the assistant's name/persona ("Maria") be configurable per business? (P-05)
3. Time zone: infer from owner phone and confirm, or ask in onboarding; US zones only? (P-06)
4. May the vertical pack's prices and "Miami-Dade County" ever reach a live agent unconfirmed? (P-07)
5. Keep `./deploy.sh --seed` (production demo tenant) or restrict seeding to dev? (P-12)
6. Show a real plan price from Stripe on the public site? (P-11)

Suggested order of work: P-01, P-04, P-12, P-08 (all S, no decision), then P-02/P-03/P-09 after decision 1, then P-06, P-07, P-05, P-11.
