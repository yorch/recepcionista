# 18a - Mock / stub inventory: voice, telephony, messaging, briefing audio

Slice: `src/lib/voice/**`, `src/lib/providers/twilio.ts` (there is no `src/lib/integrations/twilio*`; the Twilio client lives in `providers/`), `src/lib/voice/elevenlabs.ts`, `src/app/api/voice/**`, `src/app/api/calls/**`, `src/app/api/sms/**`, `src/lib/messaging/**`, number provisioning, call-handling modes, briefing audio/TTS.
Method: every item below was confirmed by reading the code path. Line numbers are as of this review. Read-only review (only this file was written).

Reachability key: PROD = reachable in a production build with the stated misconfiguration or default; DEV = only outside production / DEMO_MODE / ALLOW_INSECURE_DEV; TEST = test seam only.
Size: S < 0.5 day, M 0.5-3 days, L > 3 days. DECISION = needs an owner/product decision.

## Classes

- A. Mock fallback that silently activates in PRODUCTION and produces a fake success (highest impact)
- B. Feature that is documented or implied but not implemented / has no producer or consumer
- C. Misleading static text or claim presented as live behaviour
- D. Provider call shapes written but never verified live
- E. Deliberate dev/demo/test doubles (fine, classified)

---

## A. Silent mock fallbacks reachable in production

### A1. SMS "mock" status is treated as delivered everywhere when Twilio is incomplete (CRITICAL)
- Where: `src/lib/providers/twilio.ts:77-84` (`sendSms` returns `{status:'mock'}` whenever `hasTwilio()` is false, with NO production guard; only the console echo is guarded). Consumers that treat `'mock'` as success:
  - `src/lib/voice/tools.ts:478` (`smsDelivered`), `:691` (payment link text) - the voice agent tells the caller "I'm sending your confirmation text now" / that the link is on its way.
  - `src/lib/messaging/actions.ts:71-75` - writes `followup_consent_at` as if the "may text you after your visit" notice was delivered. Consent evidence is recorded for a text that never left.
  - `src/lib/booking-changes.ts:46` (`DELIVERED` = sent|mock) - rescheduled/cancelled notices report `delivered: true`.
  - `src/app/api/sms/inbound/route.ts:67` - gratitude reply matching includes `mock` rows.
  - `src/lib/messaging/index.ts:152,196` - mock sends are metered against the plan SMS cap (only `failed` is refunded), so a box without Twilio burns the customer's SMS allowance.
  - `src/components/calendar/booking-panel.tsx:134` - the dashboard shows tone `ok` for a mock text (copy `resend.mock` says "logged, no provider connected", so that one is honest).
- Contrast: `src/lib/voice/owner-alert.ts:151-152` does it correctly (mock counts as delivered only when `DEMO_MODE=true`). Only the alert path is safe.
- Reach: PROD whenever any of `TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER` is missing or misspelled. Boot log prints `twilio: mock (SID/token/phone incomplete)` (`src/instrumentation.ts:46-50`) but nothing refuses to serve.
- User-visible impact: customers are promised confirmation texts and deposit links that are never sent; owners see "sent" counts in the dashboard (`sms_log.status='mock'`); compliance consent timestamps are fabricated; plan cap consumed.
- Real implementation: in production make `sendSms` return `failed` (error `sms_provider_not_configured`) instead of `mock`; keep `mock` only when `NODE_ENV !== 'production'` or `DEMO_MODE=true`; make all consumers use one helper `smsDelivered(status)`; refund the reservation for mock. No new provider or schema.
- Size: S. DECISION: no (fail-closed is the already-stated policy for numbers and owner alerts).

### A2. Owner-phone and forward-number verification "send" a code that is never sent (CRITICAL, same root cause)
- Where: `src/lib/messaging/index.ts:195-203` (`sendOwnerVerificationCode`), callers `src/app/api/businesses/[id]/owner-phone/verify/start/route.ts:53-62` and `.../forward-number/verify/start/route.ts:50-58`. They reject only `failed` / `blocked`; a `mock` result returns `{ok:true, challenge, expires_at}`.
- Reach: PROD with incomplete Twilio config. In production the code body is not even logged (twilio.ts:82), so nobody can read it either. The owner sees "code sent", waits, and can never verify; every owner alert, owner call-in and forwarding feature that requires a verified phone silently stays off.
- Impact: onboarding dead-end with a success message. Real implementation: same fix as A1 (fail in production). Size: S (same change). DECISION: no.

### A3. Provisioning marks a business `live` with no voice agent when ElevenLabs is not configured (HIGH)
- Where: `src/lib/voice/elevenlabs.ts:592-595` (`syncAgent` with no key returns `{agent_id:'mock_agent_<id>', mock:true}` and no `error`) and `src/app/api/businesses/[id]/provision/route.ts:319-357`: `agentFailure` is set only when `agent.error` exists, so the no-key case falls through to `updateBusiness(id,{status:'live'})` at :354 and a 200 response (`agent_mock:true`). The mock agent id is not stored, the paid Twilio number IS bought.
- Reach: PROD when Twilio is configured but `ELEVENLABS_API_KEY` is absent (the runbook lists it as required, but nothing enforces it before a number is purchased).
- Impact: owner pays for a number, dashboard says live, callers reach nothing (the number is not bound to an agent). `step-provision.tsx:60-73` only shows a "mock number" banner for the PHONE mock flag, not `agent_mock`.
- Real implementation: treat `agent.mock && !agent.error` as a failure when `NODE_ENV==='production'` (503 `voice_provider_not_configured`), check before buying the number; surface `agent_mock` in onboarding UI. Size: S. DECISION: no.

### A4. Briefing audio: macOS `say`/`afconvert` fallback and silent no-audio in production (HIGH)
- Where: `src/lib/briefing/tts.ts:64-78` (`localSay` shells out to macOS-only `say -v Paulina` and `afconvert`; returns `mock:true`), `:80-113` (`synthesizeBriefing`): ElevenLabs path requires BOTH `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` (`:29-31`), on any ElevenLabs error it falls back to `say`, and when that throws (always, in the Linux Docker image) it returns `{audio_url:null, mock:true}` with only a log line.
- Reach: PROD. Docker image is Linux (no `say`). Any ElevenLabs outage or missing `ELEVENLABS_VOICE_ID` yields a briefing row with transcript and `audio_url=null`; the owner is still texted "your briefing is ready" (`jobs`), and the player (`dashboard/page.tsx:129`, `briefings-list.tsx:52`) gets `src=null`.
- Doc/code mismatch: `docs/env-vars.md:112` says `ELEVENLABS_VOICE_ID` is optional with default `PStJ2DzQnh8zxG5PDf1s`; the code has no default in `tts.ts` (and a different default `cgSgspJ2msm6clMCkdW9` for the agent at `elevenlabs.ts:25,462`). PRD line 196 marks audio "Partial".
- Impact: the signature "voice note" feature silently degrades to text only. Not a fake success, but undisclosed.
- Real implementation: default the TTS voice like the agent does (reuse `DEFAULT_VOICE_ID`/business `voice_id`), delete or dev-gate the macOS `say` branch, store `audio_status` (`none|failed|ready`) so the UI can say "audio unavailable", retry failed TTS in the job runner, persist audio outside container disk (see A5). Size: M. DECISION: yes (fallback behaviour: text-only vs. retry vs. alternate TTS provider).

### A5. Briefing audio is stored on local disk (`public/audio`) (MEDIUM)
- Where: `src/lib/briefing/tts.ts:15,55`, `audio-files.ts:126`, served by `src/app/api/briefings/audio/[name]/route.ts` reading `AUDIO_DIR`.
- Reach: PROD. `compose.production.yaml:224` mounts a named volume, so single-host works; multi-instance, serverless or a volume loss gives 404 on every stored `audio_url` while the DB row still points at it. Whole file read into memory per request (`route.ts:58`).
- Real implementation: object storage (S3/R2) or store bytes in Postgres; signed/authenticated fetch. Size: M. DECISION: yes (storage vendor).

### A6. `agent_id` mock ids and `mock:true` flows in the incoming-call route (MEDIUM)
- Where: `src/lib/voice/elevenlabs.ts:593-594, 645, 664, 680` return `mock_agent_<id>` ids with `mock:true` on ANY provider failure (update 5xx, create 4xx, network error). Callers that continue as if fine: `src/app/api/voice/incoming/route.ts:230-248` marks `recording_disclosed:true, consent_status:'disclosed'` when `!hasElevenLabs()`, i.e. "the scripted demo speaks the same text", even though no demo is speaking. In PROD the consent flag is therefore true without any disclosure being played when ElevenLabs is unconfigured and a signed Twilio call arrives (the route then returns JSON, see B1).
- Impact: compliance evidence (`consent_status='disclosed'`) is asserted for a call where nothing was said. Real fix: set disclosed only when `!agentMock` (and in DEV demo). Size: S. DECISION: no.

---

## B. Not implemented / no producer or consumer

### B1. AI conversation on a Twilio "webhook line" does not exist (documented, but a trap)
- Where: `src/app/api/voice/incoming/route.ts:263-272` (and :122, :216, :199) return a JSON "contract for the demo UI" (`ws_url`, `mock`, `fallback_script`) for `route.action==='ai'`. Real Twilio expects TwiML; a signed form POST in AI mode gets JSON and the caller hears "application error". `docs/runbook.md:224-226` and `src/lib/voice/line.ts:9-12` state this openly.
- Reach: PROD if a number is pointed at `/api/voice/incoming` instead of imported into ElevenLabs (the default when `ELEVENLABS_PHONE_NUMBER_ID` is unset: `lineKind()` returns `webhook`, `line.ts:33`).
- Impact: with default config (webhook line) forward/paused work, but normal AI calls fail. Provisioning (Twilio purchase) buys a number that Twilio points nowhere; importing it into ElevenLabs is "an operator step the app does not perform" (known-limitations).
- Real implementation: either (a) automate import: ElevenLabs `POST /convai/phone-numbers` with the Twilio SID/token for the purchased number, store `phone_number_id` per business (schema: `businesses.eleven_phone_number_id`), or (b) return TwiML `<Connect><Stream>`/`<Dial><Sip>` to ElevenLabs from `incoming`. Size: L. DECISION: yes (integration architecture).

### B2. Per-business phone binding is a single shared `ELEVENLABS_PHONE_NUMBER_ID`
- Where: `elevenlabs.ts:726-757` (`bindPhoneNumber`) PATCHes ONE global phone-number id with the latest agent id. With >1 tenant, each provision/incoming call rebinds the same number to the most recently synced business (`incoming/route.ts:237`). The purchased per-tenant Twilio number is never imported.
- Reach: PROD, multi-tenant. Impact: tenant B's sync can repoint tenant A's number. Real implementation: same as B1(a). Size: L (with B1). DECISION: yes.

### B3. `POST /api/voice/transcript-event` has no producer
- Where: `src/app/api/voice/transcript-event/route.ts`; `live-transcript.ts:8` says "a line that pushes its own events (the webhook line)". Repo-wide grep finds no sender (only docs and `verify-deploy` negative test); the webhook line has no AI conversation (B1). Route is live, authenticated, and unused.
- Real implementation: nothing needed unless B1(b) is chosen; otherwise delete. Size: S. DECISION: tied to B1.

### B4. `handoff_to_human` does not hand off; native live transfer is off by default
- Where: `src/lib/voice/tools.ts:907-975` (texts the owner and says they will call back; `transferred:false`). `src/app/api/voice/agent-prompt/route.ts:17` describes it as "Transfer the caller to the owner." Real transfer is `transfer_to_human` behind `NATIVE_TRANSFER=on` (`line.ts:55-56`, default off "until the live test"). `transfer_to_human` has no entry in `TOOL_DESCRIPTIONS` (`agent-prompt/route.ts:10-20`), so its `description` is `undefined` in the agent-prompt JSON.
- Impact: in default config "forward" mode on the AI line plays the paused script (the dashboard says so, `FORWARD_UNAVAILABLE`, line.ts:59 - honest). The static tool description is misleading. Real implementation: fix description, add the missing entry; run the live transfer test (runbook 8) and flip the default. Size: S (text) / M (live validation). DECISION: yes for enabling `NATIVE_TRANSFER` by default.

### B5. Forwarding on the native (ElevenLabs) line
- Same dependency as B4: forward works only via the webhook line (no AI there) or `NATIVE_TRANSFER`. Size/decision: see B1/B4.

### B6. Number provisioning is US-only and fixed to area code 305 by default
- Where: `twilio.ts:224` hard-codes `AvailablePhoneNumbers/US/Local`; `src/lib/phone.ts:80-91` falls back to `TWILIO_AREA_CODE`/305 for non-US owner phones. A Spanish-market or non-US business gets a Miami number. Documented in known-limitations. Real implementation: country on `businesses`, per-country search/regulatory bundles. Size: L. DECISION: yes (markets).

### B7. Review link default is a placeholder
- Where: `src/lib/messaging/templates.ts:183-185`: `REVIEW_URL || 'https://g.page/r/demo/review'`, used by `src/lib/gratitude/reply.ts:32`. In PROD with `REVIEW_URL` unset, 4-5 star customers receive a dead "demo" Google review link under the business's name, and the send is logged as success.
- Real implementation: per-business `review_url` column (Google Place ID link) + settings UI; skip the review request (or ask the owner) when none is set. Size: S-M. DECISION: yes (per-business vs. global).

### B8. Owner SMS inbound / STOP reconciliation with Twilio-level opt-out
- Documented limitation (known-limitations: Twilio Advanced Opt-Out can block a number without forwarding STOP). Not a mock; listed for completeness. No code stub.

---

## C. Static text / claims that are not backed by behaviour

### C1. Fallback briefing narration claims actions the system did not take
- `src/lib/briefing/index.ts` `fallbackScript` (used with no LLM key or when the model output fails the word-count guard): "Aproveché para dejar todo listo para mañana" / "I used the time to get everything ready for tomorrow" (empty day), "A todas les tomé los datos, el problema y la dirección" (asserted if any call has a summary), "el cliente quedó tranquilo y <provider> está enterado" (emergencies; there is no check that the provider was notified), "Te dejé el número en el dashboard". Reach: PROD without `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` (boot log shows `llm: none (templates)`). Fix: remove claims not derived from data (e.g. use `owner_notified` from the call row). Size: S. DECISION: no.

### C2. `agent-prompt` route reports constants
- `src/app/api/voice/agent-prompt/route.ts:57-58` returns `language:'en'`, `language_mode:'auto'` as static literals regardless of business locale/ElevenLabs settings; `voice_id` shows only the env value, not the business's chosen voice (`elevenlabs.ts:462`). Admin/owner-only inspection route; low impact. Size: S.

### C3. Dashboard demo page badges
- `src/app/dashboard/demo/page.tsx:68-77` labels providers live/mock from env presence only (not a connectivity check). DEV/admin console. Size: S.

---

## D. Unverified provider call shapes (real code, never proven live)

All documented by the authors as UNVERIFIED; failures degrade to `mock:true` or a log line (and so feed A3/A6):
- `elevenlabs.ts:384-` transfer `provider_configs` shape and `{{transfer_destination}}` resolution inside a rule.
- `elevenlabs.ts:487-` conversation-initiation webhook (workspace + per-agent override flags) and `initiation-config.ts:5` field names.
- `elevenlabs.ts:776-` detaching the shared phone number before deleting an agent.
- `transfer.ts:95` tool-call result shape (`tool_calls[].tool_name`, `tool_results[].is_error`) used to mark transfer outcome.
- `conversations.ts:4`, `live-transcript.ts:5` - whether `transcript` fills while a conversation is `in-progress` (the live view may show nothing until the call ends).
- `recording-audio.ts:6` - content type and Range support of the audio endpoint (handled by buffering up to 40 MB in memory).
- `voices.ts:6` - `category` values and `preview_url` hosts of `GET /v1/voices` (with no allowlist the owner may see an empty list).
- `screening.ts:7` - whether Twilio `DialCallDuration` excludes the whisper (billing/metering accuracy).
Each needs a real-credentials live test (runbook section 8) rather than code. Size: M overall (test + adjust). DECISION: no.

---

## E. Deliberate dev/demo/test doubles (acceptable; classified)

| id | where | what | reach |
|---|---|---|---|
| E1 | `twilio.ts:160-163, 155-158` | fake `+1<area>555xxxx` number pool; refused in production or whenever any Twilio var set (`fakeNumberAllowed`) | DEV only |
| E2 | `twilio.ts:326-327, 379-382, 396-399` | release of mock-pool numbers succeeds without a call; with NO Twilio vars outside production "released" without a call | DEV only (pool-number match is also true in prod, harmless) |
| E3 | `twilio.ts:37-49` | webhook signature skipped when no `TWILIO_AUTH_TOKEN` and `ALLOW_INSECURE_DEV` | DEV only; fails closed in prod |
| E4 | `elevenlabs.ts:47-60` and `voice/tools/[tool]/route.ts:86`, `ensureInitiationWebhook` | signature/tool-secret skip and client-supplied `business_id` accepted under `ALLOW_INSECURE_DEV` | DEV only |
| E5 | `voice/postcall.ts:75-172` | `ensurePostCallWebhook` returns `mock:true` without key / without `webhooks_write`; provisioning flags `post_call_webhook_pending` | PROD-reachable but surfaced to the admin (not a fake success) |
| E6 | `app/api/demo/simulate-call/route.ts`, `app/api/demo/reset`, `lib/demo/seed-data.ts` | scripted calls (hard-coded "Maria / Miami Cool Air" transcripts, `+13055550123`, 168 s), reset | DEV/DEMO_MODE only; admin guard + `demoModeEnabled()` (404 otherwise) |
| E7 | `voice/incoming/route.ts:33, 180, 199-204` | JSON responses for the unsigned demo UI (`mock:true`) | DEV only for unsigned; signed forms get TwiML for paused/forward |
| E8 | `voice/live-stream.ts:2` | fake clock/source seams | TEST only |
| E9 | `integrations/google/mock.ts` (+ `GOOGLE_OAUTH_MOCK`) | in-memory Google; refused in production (`config.ts:26-32`) | DEV only (outside my slice, listed because it lives under `src/lib/integrations`) |
| E10 | `voice/reconcile.ts:42` | no-op without `ELEVENLABS_API_KEY` | benign; no-op not a fake success |
| E11 | `providers/llm.ts:184-213` `generateJson/generateTextSafe` return `mocked:true` template output with no key | PROD-reachable degraded mode, labelled in boot log (`llm: none (templates)`); affects briefing narration (C1) and call summaries | PROD-reachable (see C1) |

---

## Ranked summary (by user-visible impact)

1. A1 SMS `mock` treated as delivered (customer promises, consent evidence, plan cap) - S, no decision
2. A2 Verification codes "sent" but never delivered; onboarding dead-end - S (same fix)
3. B1/B2 No real AI line for per-tenant purchased numbers; single shared ElevenLabs phone id - L, DECISION
4. A3 Business marked `live` with no agent when ElevenLabs absent - S
5. A6 `consent_status='disclosed'` asserted with no disclosure played (no key) - S
6. A4 Briefing audio silently missing in production, macOS `say` fallback, voice-id default mismatch - M, DECISION
7. B7 Placeholder review link `https://g.page/r/demo/review` - S-M, DECISION
8. B4 `handoff_to_human` described as a transfer; `transfer_to_human` undescribed; native transfer off by default - S/M, DECISION
9. C1 Fallback briefing text asserts unperformed actions - S
10. A5 Briefing audio on local disk - M, DECISION
11. B6 US-only / area code 305 default - L, DECISION
12. D unverified ElevenLabs/Twilio call shapes - M
13. B3 transcript-event route with no producer; C2, C3 static values - S

## Counts by class
- A (silent prod mock fallbacks / fake success): 6 items (A1-A6)
- B (not implemented / no producer-consumer / placeholder data): 8 items (B1-B8; B8 is documentation-only)
- C (static claims): 3 items
- D (unverified provider shapes): 8 shapes (1 grouped item)
- E (deliberate dev/demo/test doubles): 11 items
- Needing an owner DECISION: B1, B2, B4 (enable default), B6, B7, A4, A5 (7)
