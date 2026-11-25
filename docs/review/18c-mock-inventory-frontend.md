# 18c. Mock inventory: frontend (src/app non-api, src/components)

Scope: every page and component under `src/app` (non-api) and `src/components`, read in full or in the relevant parts. Backend mock providers are covered by 18a/18b; they appear here only where the UI exposes them. Paths are relative to `src/`. Reach: PROD = reachable with production config, DEV = only outside `NODE_ENV=production` or with `DEMO_MODE=true`, TEST = tests only.

Checked and found real (no finding): billing page and actions, team panel, security panel (2FA, passkeys, sessions), calls list, voicemail list, live call (SSE with polling fallback), calendar and booking panel, Google Calendar card, voice picker, refund policy and settings forms, knowledge editor, onboarding verify, plan and connect steps. Every non-test `t()` key has an `es` counterpart (the `defineArea` generic enforces this at compile time), and no Spanish string is a copied English one. There are no `href="#"`, no empty `onClick` handlers, no hard-coded sample customers or bookings in any dashboard page. The landing page is static copy by design.

## Ranked findings

### F-01 Fake card checkout reachable in PROD (HIGH)
- File: `app/pay/[id]/page.tsx:71-128`, `app/pay/[id]/checkout.tsx:13-75,110,143-145`.
- What is mocked: `/pay/<bookingId>` renders a "Demo checkout" card form (card number, expiry, CVC, ZIP) for any unpaid booking with `deposit_amount > 0`. The page only gates the `mock_` ids and query-param amounts on `NODE_ENV`. The booking-id path has no gate, so it renders the mock in production too. It is a public route (`/pay/` is in `PUBLIC_PAGE_PREFIX`, `lib/auth.ts:55`).
- Behaviour: Pay runs client validation, waits an artificial 900 ms ("so the button press reads as a real network call", `checkout.tsx:59-60`), then calls `/api/pay/mock-complete`, which returns 404 unless `DEMO_MODE=true`. The customer sees "Demo payments are not enabled on this server." The page also shows the label "Secure payment" next to the demo badge. If `DEMO_MODE=true` leaks into prod, the deposit is marked paid with no money moved.
- Real payment links are Stripe-hosted (`lib/providers/stripe.ts`), and in prod `createPaymentLink` throws when `STRIPE_SECRET_KEY` is unset. So a customer only lands here with a booking id, but the page discloses business name, service and deposit amount to anyone holding the id.
- Real implementation: in production, `/pay/<bookingId>` should never render the card form. Either `notFound()` or redirect to the booking's real Stripe Payment Link. That needs the link URL stored on the booking, and the schema may not have it. Check `setBookingStripeRefs`. Alternatively, build a real Stripe Elements or Checkout Session flow.
- Size: S for the gate, M for redirect-to-Stripe (store `payment_link_url`). Decision: yes. Gate with `demoModeEnabled()` instead of `NODE_ENV`, or build a real hosted page?

### F-02 Payment receipt page claims texts that are never sent (HIGH)
- File: `app/pay/[id]/received.tsx:32,41`, copy `lib/i18n/catalog/publicPages.ts:95,102`, caller `app/pay/[id]/page.tsx:106-118`.
- What is faked: an already-paid booking at `/pay/<bookingId>` shows "Your tech is confirmed. We texted you the details." and "A receipt is on its way by text from {business}." The Stripe webhook (`app/api/payments/webhook/route.ts:117-146`) texts only the OWNER ("Deposit $X paid by ..."). No customer receipt SMS exists anywhere in `lib` or `app/api`.
- Other static values: `last4="----"` placeholder (line 114, hidden by `knownCard`), the reference is the raw booking id, and "tech" is HVAC wording shown to every vertical.
- Reach: PROD (any paid booking id). The same claims appear in the mock success state (DEV).
- Real implementation: either send a customer receipt SMS from the webhook through the normal SMS policy path (consent, opt-out, quiet hours, caps), or remove the claim and use the Stripe-hosted receipt email. Make the wording vertical-neutral.
- Size: S for rewording, M for the receipt SMS. Decision: yes (send a receipt text, or drop the promise?).

### F-03 Demo console and nav visible in PROD, its buttons fail (MEDIUM)
- File: `components/dashboard/shell.tsx:30` (`gate: 'admin'` only), `app/dashboard/demo/page.tsx:16-85`, `components/dashboard/demo-tools.tsx:36-60`, `app/onboarding/step-test.tsx:66-70`.
- What is mocked: the admin sidebar always shows "Demo". The page never checks `demoModeEnabled()`. "Call her" and "Reset" call `/api/demo/simulate-call` and `/api/demo/reset`, which 404 unless `DEMO_MODE=true`. The admin gets an error toast on a nav item that looks like a feature. Onboarding's test step also links admins to it when the number is a mock number.
- Mock content inside: fixed caller names "Rosa Delgado" / "Marcus Lee", random `+1305555xxxx` caller numbers, three hard-coded HVAC scripts ("My AC is blowing warm air"). They are HVAC-only and ignore the business's vertical. The "Reset" button wipes data and re-seeds from `lib/demo/seed-data.ts` (Miami content).
- Reach: nav item and page in PROD (admin only). Functionality DEV (`DEMO_MODE=true`).
- Real implementation: hide the nav item and `notFound()` the page when demo mode is off. If the demo is wanted as a product feature, make the scripts vertical-aware (`lib/verticals`).
- Size: S. Decision: no (hide in prod), unless the owner wants demo as a sales feature.

### F-04 Timer-driven progress steps that are not real progress (MEDIUM)
- File: `app/onboarding/step-info.tsx:75`, `app/onboarding/step-provision.tsx:29`, `app/pay/[id]/checkout.tsx:60`.
- What is faked: a `setInterval` advances the checklist labels ("Reading your website", "Finding your services and prices", "Learning your hours...", "Choosing a local phone number", "Setting up her voice and script", "Final checks") every 2.5 s or 3.5 s. This happens regardless of what the server is doing. In `step-info` the ticker stops at phase 2 and jumps to "Saving" when `/api/extract` returns. In `step-provision` it parks on "Final checks" for the rest of the 120 s timeout. The labels can claim steps that have not run or have already failed.
- Reach: PROD.
- Real implementation: stream or poll real stage events (an NDJSON or SSE response from `/api/extract` and `/provision`, or persist a `stage` column and poll the existing `onboarding-status`). Alternatively, show an honest indeterminate spinner with a single label. The provision route already has distinct internal steps (KB, number purchase, agent create).
- Size: S for the honest spinner, M for real stage reporting. Decision: yes (honest spinner, or invest in real stages?).

### F-05 Briefing audio depends on a macOS-only fallback and ignores the chosen voice (MEDIUM)
- File: `lib/briefing/tts.ts:1-4,60-78,106-112` (backend, but it drives `components/ui/audio.tsx` and `app/dashboard/page.tsx:149`, `components/dashboard/briefings-list.tsx:50`).
- What is mocked: without `ELEVENLABS_API_KEY` AND `ELEVENLABS_VOICE_ID`, or when ElevenLabs fails, the code falls back to macOS `say -v Paulina` plus `afconvert` and tags it `mock: true`. On a Linux host both binaries are absent, so `audio_url` is `null`. The player then shows a disabled button and "audio pending" forever, with no explanation and no retry.
- Voice choice: briefings always use the global `ELEVENLABS_VOICE_ID`, not the per-business voice the owner picks in Settings, which affects only the agent.
- Storage: files are written to `public/audio` on local disk, so they are lost on serverless or ephemeral hosts and not shared between instances.
- Reach: PROD (the fallback is silent). It is flagged only in logs.
- Real implementation: require ElevenLabs for TTS in prod (fail visibly, or show "audio unavailable, read the transcript"). Pass the business `voice_id`. Store audio in object storage (S3 or R2) or a DB blob.
- Size: M. Decision: yes (is the evening briefing audio a core promise on the plan page and landing? Where should audio be stored?).

### F-06 Waveform on the voice player is decoration (LOW)
- File: `components/ui/audio.tsx:69-86`.
- What is faked: the 42 bar heights are a deterministic pseudo-random sine hash, not the audio waveform. Only the highlighted prefix follows playback progress. It looks like a rendered waveform for the call, briefing or voicemail.
- Reach: PROD. Impact: cosmetic.
- Real implementation: precompute peaks, or use WebAudio `decodeAudioData`, or change the design to a plain progress bar.
- Size: S to M. Decision: no.

### F-07 Features and endpoints with no UI (LOW to MEDIUM, "claimed but not wired")
All have working API routes and docs, but no page or button reaches them. Found by grepping every `app/api` route against `app/` and `components/`.
- `privacy/erase` and `privacy/export` (customer data erasure and export): documented in `docs/compliance.md:149-154`, no UI. An owner cannot honour a deletion request without calling the API by hand.
- `sms/send`, `sms/confirmation`, `sms/payment-link`, `payments/create-link`: no dashboard "text a customer" or "send a deposit link" action. The dashboard shows only the 2 most recent SMS plus a total (`app/dashboard/page.tsx:213-225`), and there is no SMS log page.
- `gratitude/run`, `admin/jobs`, `admin/jobs/run`: no admin UI. `voice/agent-prompt`, `team/audit` (the audit page reads the DB directly): no UI use.
- Real implementation: a Settings "Privacy" card (phone input, Export, Erase with a confirm and re-auth), an SMS log page, a "Text customer" action on the booking panel.
- Size: M each. Decision: yes (which of these are launch requirements? The privacy pair is likely compliance-required).

### F-08 Hard-coded Miami and HVAC defaults leaking into product paths (LOW)
- `lib/extraction/index.ts:42-55` `templateResult()` hard-codes `service_area: ['Miami-Dade County']` and the default name 'This Business'. It is used by `app/api/businesses/[id]/provision/route.ts:207` for any business created without a URL (and as the LLM fallback input), so a non-Miami business can get a Miami service area written to its KB. `draftFromPack` (the UI path) correctly uses `[]`. This is the same default but is not reconciled.
- `app/onboarding/step-info.tsx:48` and `app/dashboard/settings/page.tsx:61` default the vertical to `'hvac'` (and the API does too). A business whose vertical is null shows as HVAC.
- `components/knowledge/model.ts:39,46` pre-fills hours 08:00 to 18:00, closed Sunday, for every new business in the manual path. The pack hours override this, but the fallback is silent. Example placeholders ("miamicoolair.com", "305 555 0142", "Miami-Dade County, Broward County" in `kb.form.areaPlaceholder`) are cosmetic.
- `app/pay/[id]/page.tsx:30-33` `DEFAULT_AMOUNT_CENTS = $189` and `DEFAULT_BUSINESS = 'Miami Cool Air Conditioning'` are DEV only (bare `mock_` link), clamped.
- `app/dashboard/page.tsx:201` shows "EN" when a call's language is null (unknown shown as English).
- Size: S. Decision: no, except whether unknown vertical should be forced to an explicit choice.

### F-09 Mock provider notices (informational: correct, explicit, DEV or unconfigured only)
These are honest, visible banners, not silent fakes. Classified for completeness.
- `onboarding/step-provision.tsx:60-76` "demo number ... cannot receive real calls", `step-connect.tsx:45-50`, `step-test.tsx:66-71`. The number comes from the mock pool (`+1<area>555xxxx`) when Twilio is not configured (`provision/route.ts:233-285`). Reach: DEV and unconfigured prod. In prod without Twilio keys, check that provisioning refuses rather than issuing a mock number (18a).
- `components/dashboard/google-calendar-card.tsx:60` shows "Mock mode: no real Google account is used" when `st.mock` (`googleMockEnabled`). Backend flag. Reach: DEV.
- `components/calendar/booking-panel.tsx:34,134` "Confirmation text logged (no SMS provider is connected)" is treated as success (tone `ok`) when the SMS provider is mock. If Twilio is unconfigured in prod, the owner is told "ok" while no text went out. Confirm in 18a that mock SMS is refused in prod.
- `app/dashboard/billing/page.tsx:112` "Plans are not enforced on this installation yet" appears when billing enforcement is off. This is a config mode, and it shows the plan step without payment (`step-plan.tsx:119-123` `plan.noPayment`, `plan.adminSkip`).
- `components/dashboard/voice-settings.tsx:49-51` voice picker is disabled with a reason when ElevenLabs is not connected. Correct.

### F-10 Landing and plan copy: claims versus implementation (LOW)
- `land.f2.d` "texts the customer a confirmation", `land.f4.d` "secure payment link", `land.f5.d` "short evening briefing" (see F-05), `land.f6.d` "see your week on a calendar and read every call". All have real code paths.
- `land.pricing` shows only free text from `NEXT_PUBLIC_PLAN_PRICE_DISPLAY[_ES]` or the generic default "Simple monthly pricing, with a free trial" (`site.priceDefault`). If the env var is unset, the landing page and plan step show no actual price. Config, not code. Decision: the owner must set the price text.
- Phone forwarding guide (`app/onboarding/forwarding.ts`) is static carrier data, US-centric (AT&T, T-Mobile, Verizon star codes). It is accurate-looking standard GSM and landline codes, but UNVERIFIED against live carriers, and the UI itself says carriers differ. Not a mock.

## Counts by class
- Reachable in PROD, user-visible fake or false claim: 3 (F-01, F-02, F-05) plus the fake progress (F-04) = 4.
- Admin-visible dead feature in PROD (F-03): 1.
- Unwired features, API without UI (F-07): about 9 endpoints, 3 product gaps (privacy, SMS log, manual text).
- Cosmetic fakes (F-06, F-08 defaults): 2 groups.
- Explicit dev, demo or unconfigured notices (F-09): 5, all honest.
- TEST-only doubles in this slice: none found (no mock data inside components).
- i18n gaps hiding missing features: none.

## Decisions needed from the owner
1. F-01: gate the booking-id pay page in prod with `notFound()`, or build a real hosted or Elements checkout page.
2. F-02: send a customer receipt SMS, or remove the claim from the receipt page.
3. F-04: honest spinner now, or real stage reporting (needs an API change).
4. F-05: is audio briefing core? Where should audio live (object storage), and should it use the per-business voice?
5. F-07: which API-only features must get UI for launch (privacy export and erase first).
