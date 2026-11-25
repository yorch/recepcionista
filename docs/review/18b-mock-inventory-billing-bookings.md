# 18b. Mock / stub / placeholder inventory: billing, bookings, scheduler, calendar, Google, jobs

Slice: Stripe checkout / portal / webhooks / deposits / `/pay` / refunds / plans, bookings, scheduler and availability, calendar UI,
`src/lib/integrations/google/*`, background jobs. Method: read the code paths (not name greps). Read-only review; no repo files were edited.

Classes: **PROD** = reachable in a production build with normal config; **PROD-MISCONFIG** = reachable in production only when a provider key is missing / flag set;
**DEV** = non-production or explicit demo flag only; **TEST** = tests only.

Overall: the slice is unusually clean. Stripe billing, deposit webhooks, refunds, Google Calendar (OAuth, push, sync, watch) and the jobs are real implementations
with fail-closed production gates. The real defects are (1) a silent "mock" SMS success that is trusted as delivery in production, (2) a fake card form rendered
at `/pay/<bookingId>` in production, (3) missing owner-facing UI for features that exist as APIs, and (4) hard-coded product constants presented as policy.

---

## A. Ranked findings

### M1. Mock SMS counts as "delivered" in production when Twilio env is incomplete (PROD-MISCONFIG, HIGH)
- Where: `src/lib/providers/twilio.ts:76-84` (`sendSms` returns `{status:'mock'}` whenever `!hasTwilio()`, with NO `NODE_ENV` check; only the console echo is gated).
  Consumers that treat `mock` as delivered: `src/lib/booking-changes.ts:46` (`DELIVERED` -> `markCustomerNotified`, so `customer_notified_at` is stamped though nothing was sent),
  `src/lib/voice/tools.ts:478` (voice agent says "I'm sending your confirmation text now"), `src/lib/voice/tools.ts:691` (agent says "I'm sending you a secure link for the deposit right now" although no text went out),
  `src/lib/messaging/actions.ts:71`, `src/components/calendar/booking-panel.tsx:134` (owner sees a green "ok" tone, copy `resend.mock`: "Confirmation text logged (no SMS provider is connected)"),
  `src/app/api/sms/inbound/route.ts:67`.
  Contrast: `src/lib/voice/owner-alert.ts:151-152` correctly counts `mock` as delivered only when `DEMO_MODE=true`. Boot only prints `twilio: mock (...)` (`src/instrumentation.ts:50`); it does not refuse to start.
- User-visible impact: a production deployment with a Twilio typo/missing var tells callers a confirmation / deposit link was texted, stamps customers as notified, cancel/reschedule notices "delivered", and the owner UI shows success. Customers never receive anything; deposits are lost.
- Real implementation: treat `mock` as non-delivery outside DEMO_MODE/non-prod (shared helper `smsDelivered(status)` used by all 7 sites), make `sendSms` return `failed` (or throw `TwilioConfigError`) in production like Stripe/email do, and fail boot/health in production when Twilio is incomplete. No new provider/credentials.
- Size: S. Decision: no (it matches the fail-closed posture already used for Stripe, email, Google).

### M2. `/pay/<bookingId>` renders the fake "Demo checkout" card form in production (PROD, MEDIUM)
- Where: `src/app/pay/[id]/page.tsx:73-74,94-105,131-142` (a non-`mock_` id is treated as a booking id; a booking with `deposit_amount>0` renders `<Checkout>`, with no `isProd` guard on that branch),
  `src/app/pay/[id]/checkout.tsx` (entire file: card/expiry/CVC/ZIP inputs that are never sent anywhere, hard-coded `setTimeout(900)` "so the press reads as a real network call", "Demo checkout" badge `pay.demoBadge`, `pay.demoNote` "No card is charged").
  `src/app/pay/[id]/received.tsx` uses `last4="----"` (page.tsx:114) for an already-paid booking.
- Reachable: anyone who has/guesses a booking UUID that has a deposit amount (in production real links are `https://buy.stripe.com/...`, so the page is not linked, but it exists). The "Pay" button posts to `/api/pay/mock-complete`, which answers 404 unless `DEMO_MODE=true`, so the customer sees "Demo payments are not enabled" (`pay.err.demoOff`). Not a money bypass (deploy.sh refuses `DEMO_MODE=true`, docs/env-vars.md:35), but it is a fake payment page on a production domain.
- Real implementation: in production `/pay/[id]` should either 404 or redirect to the booking's stored Stripe Payment Link (`getBookingPaymentLinkId`) and show the real "paid" receipt (amount, date, last4 from the PaymentIntent via `payment_intent` -> `payment_method.card.last4`, or omit last4). Keep the mock form behind `!isProd`.
- Size: S-M. Decision: small (what to show an old/expired link: redirect vs. "link no longer valid, contact <business>").

### M3. No owner UI to create or send a deposit request / payment link (UNWIRED, MEDIUM)
- Where: `POST /api/payments/create-link` (`src/app/api/payments/create-link/route.ts`) and `POST /api/sms/payment-link` (`src/app/api/sms/payment-link/route.ts`) have NO caller in `src/**/*.tsx`.
  The only trigger is the voice tool `create_payment_link` (`src/lib/voice/tools.ts:628`). The booking panel (`src/components/calendar/booking-panel.tsx`) offers resend-confirmation, reschedule, complete, cancel, notify, refund, but not "request / resend deposit".
- Impact: an owner cannot ask for a deposit on a phone-less/manual booking or resend a lost link without calling the API. Also there is no dashboard way to mark a deposit as paid by cash/Zelle.
- Real implementation: "Request deposit" / "Resend link" button in the booking panel calling `/api/sms/payment-link` (amount input with the 100..50000 cents bounds), show link state and cancel-deactivation; optional "mark paid manually" (needs audit + refund-guard decision since no Stripe PI exists).
- Size: M. Decision: yes (manual-paid semantics).

### M4. No way to create a booking from the dashboard (UNWIRED, MEDIUM)
- Where: `src/app/api/bookings/route.ts` exports GET only; `src/app/dashboard/bookings/page.tsx` and `src/components/calendar/*` have no "New booking" action. Bookings are created only by the voice tool `create_booking` (`src/lib/voice/tools.ts:~400-470`) and the demo simulator.
- Impact: walk-ins / phone bookings the owner takes themselves cannot go on the calendar; calendar shows only AI bookings (plus Google busy blocks).
- Real implementation: POST `/api/bookings` (owner role; reuse `createBooking` + `validateSlot` + overlap lock + `emitBookingChanged`), a "New booking" dialog reusing the slot picker of `reschedule-dialog.tsx`. Also `PATCH` currently only supports status changes (booking-panel.tsx:91): no edit of service/duration/address/notes (docs/known-limitations.md admits reschedule does not change service or length).
- Size: M-L. Decision: yes (is the dashboard meant to be a scheduler or read-only AI log?).

### M5. Stripe Payment Link hard-codes USD, card-only, $1..$500 (HARD-CODED POLICY, MEDIUM)
- Where: `src/lib/providers/stripe.ts:53-56` (`currency` `'usd'`, `payment_method_types[] = card`), `src/app/pay/[id]/money.ts:6` (USD), `src/app/api/payments/create-link/route.ts:12-13` and `src/app/api/sms/payment-link/route.ts:105` (100/50000 cents, duplicated literals), `src/lib/voice/tools.ts:620` (`DEPOSIT_CAP_CENTS = 50_000`), `src/lib/verticals/index.ts:49` ("capped at $500" quoted into the agent prompt).
- Impact: not configurable per business; non-USD businesses (a `countryForBusiness` concept exists) cannot be charged in their currency; owner cannot set cap or a fixed deposit.
- Deposit amount is whatever the voice LLM requests (clamped). There is no business-level "deposit %/fixed amount per service" setting; `pack.deposits.defaultOn` (`src/lib/verticals/packs/*.ts`) only changes a sentence in the prompt.
- Real implementation: `businesses.deposit_mode/amount/cap_cents/currency` columns + Settings UI, use them in tools + `createPaymentLink` + pay page; Stripe `automatic_payment_methods`/wallets.
- Size: M. Decision: YES (deposit model, currency scope).

### M6. Plan price and "what's included" are static marketing strings detached from Stripe (STATIC, MEDIUM)
- Where: `src/app/site-config.ts:15-22` (price shown = `NEXT_PUBLIC_PLAN_PRICE_DISPLAY[_ES|_ANNUAL]` free text, build-time inlined; default `site.priceDefault` = "Simple monthly pricing, with a free trial", `src/lib/i18n/catalog/publicPages.ts:5`),
  consumers: `src/app/dashboard/billing/page.tsx:126`, `src/app/onboarding/page.tsx:48-50`, `src/app/page.tsx:35`. Included features `plan.inc.0-3` (`src/lib/i18n/catalog/onboarding.ts:78-81`) are hard-coded copy and do not mention the real caps (SMS 500 segments, 300 AI minutes, 600 forward minutes, trial 50/30: `src/lib/db/usage.ts:24-31`, env-overridable).
- Impact: the price the customer sees can disagree with `STRIPE_PRICE_ID`'s real amount (no check at boot or checkout). There is no price/plan list (single plan only), no tiering.
- Real implementation: fetch price (`GET /v1/prices/{id}`, cache) to render amount/interval, or at least a boot-time/`verify-deploy` check that the display text matches; show caps from `smsCapFor/callMinutesCapFor`.
- Size: S (display check) / L (multi-plan). Decision: yes if multiple plans are wanted.

### M7. Billing enforcement is optional and defaults vary by env (CONFIG, MEDIUM; documented)
- Where: `src/lib/db/usage.ts:16-17`, `src/lib/billing/gate.ts:23`, `src/instrumentation.ts:57-64`, billing page `bill.notEnforced` (page.tsx:121) and onboarding `plan.noPayment` (`step-plan.tsx`).
  Outside production nothing is capped unless `BILLING_ENFORCED=true`; in production enforced unless `=false`.
- Impact: dev/staging users see "no payment needed" states; legacy tenants run un-capped when opted out. Not a mock per se. Real gap: `scripts/grandfather-existing.ts` and `scripts/release-canceled-tenants.ts` (`src/lib/billing/release.ts`) are manual operator scripts; docs/known-limitations.md: "Run it on a schedule: nothing releases on its own." Not part of `JOB_NAMES` (`src/lib/jobs/schedule.ts:22`).
- Real implementation: add `tenant_release` job (calls `processBusiness`) behind an env flag, or document cron. Size: S-M. Decision: yes (auto-releasing numbers/agents is destructive).

### M8. Daily briefing audio: macOS-only `say` fallback and local-disk files (DEV-ish, LOW-MEDIUM)
- Where: `src/lib/briefing/tts.ts:1-4,64-78,85-111` (without ElevenLabs creds or on ElevenLabs failure falls back to `say -v Paulina` + `afconvert`, macOS binaries; on Linux (prod) both throw and it returns `{audio_url:null, mock:true}`; the `mock` flag is dropped in `src/lib/briefing/index.ts:~337`). Files are written to `public/audio/` on local disk (`audio-files.ts`).
- Impact: in prod, TTS failure is silent (briefing row with transcript but no audio; only a `log.error`), the owner gets a "briefing ready" text. Audio on container-local disk is lost on redeploy/multi-instance. Narration without an LLM key uses the deterministic template (`src/lib/briefing/index.ts:92-250`, `generateTextSafe` `mocked:true`), which is real data in canned phrasing: acceptable, but the owner is not told it is the template.
- Real implementation: drop macOS fallback in prod, surface `audio_status` on the briefing and the dashboard list, store audio in object storage (S3/R2) or serve via a DB blob. Size: M. Decision: storage choice.

### M9. Mock billing checkout dead-ends without `DEMO_MODE` (DEV, LOW)
- Where: `src/lib/providers/stripe-billing.ts:49-57` `billingMode()` returns `'mock'` when no key and non-prod; `src/app/api/billing/checkout/route.ts:43-47` returns `{url: .../api/billing/mock-activate}`; `src/app/api/billing/mock-activate/route.ts:18` answers 404 unless `DEMO_MODE=true`. So a dev box with neither key nor DEMO_MODE gets a "Start trial" button that navigates to a 404. In mock mode the portal returns 409 (`portal/route.ts:26`), the annual price option appears if `STRIPE_PRICE_ID_ANNUAL` is set (`annualAvailable`).
- Real implementation: have checkout return 503 `billing_not_configured` unless DEMO_MODE, or fold mock-activate gating into `billingMode()`. Size: S. No decision.

### M10. Google Calendar: mock is correctly production-gated (DEV, informational)
- `src/lib/integrations/google/mock.ts` (in-memory fake Google, 69 lines), `src/lib/integrations/google/http.ts:12` (`googleFetch` routes to mock when `googleMockEnabled()`), `src/lib/integrations/google/oauth.ts:46` (`client_id` falls back to `'mock-client'`, harmless), `src/app/api/integrations/google/connect/route.ts:17-26` (mock redirects straight to callback with `code=mock-code`), `src/app/api/integrations/google/mock-event/route.ts` (404 unless mock), `google-calendar-card.tsx:60` (`gcal.mock` banner),
  `src/lib/integrations/google/config.ts:95-101` (`googleMockEnabled` = flag AND `NODE_ENV !== 'production'`; `googleMockRefused` makes connect/callback return 503 and boot logs an error). Verified no production path reaches the mock.
- Real code verified: OAuth (`oauth.ts`), token refresh/encryption (`tokens.ts`), event push with etag/If-Match (`push.ts`), incremental sync (`sync.ts`), push channels (`watch.ts`, `webhook/route.ts`), busy blocks feeding availability (`scheduler.ts:25,45` via `calendarBusyIntervals`), job `google_calendar`.
- Minor: stale comment `src/lib/scheduler.ts:2-3` says "Internal calendar by design - no external calendar API in the MVP" but Google busy is merged into availability. Doc drift only (S).
- Needs real-provider verification, not code: Google OAuth consent screen verification for `calendar.events`/`calendarlist.readonly` (restricted-scope review may apply), production redirect URI.

### M11. Stripe deposit/refund "mock" paths (DEV)
- Deposit links: `src/lib/providers/stripe.ts:25-32,45-47,87-90` `mockLink()` returns `/pay/<bookingId>`; in production a missing key or Stripe error THROWS. In NON-production a real Stripe error silently falls back to the mock link (`link.fallback_to_mock`), which can hide a bad key on staging that is built with `NODE_ENV!=production`. Class: DEV. Real fix: only mock when no key (never on a Stripe error); S.
- Refunds: `src/lib/providers/stripe-refunds.ts:82-88` fake `re_mock_*` refund `status:'succeeded'` when no key and non-prod; `refundsAvailable()` true in dev; `refund-service.ts:121` audits `mock: refund.mock`; `reconcileStuckRefunds` skipped without key (`refund-service.ts:274`). Production fails closed. DEV.
- Deposit "paid" without Stripe: `src/app/api/pay/mock-complete/route.ts` (DEMO_MODE only, amount read from DB, unauthenticated). Production protection is deploy.sh refusing `DEMO_MODE=true` and compose forcing false (docs/env-vars.md:35), NOT a `NODE_ENV` check in the route (unlike `mock-activate`, which checks `NODE_ENV`). Hardening: add `NODE_ENV === 'production'` -> 404 in `mock-complete` (S). A booking "paid" by mock-complete has no `stripe_payment_intent_id`, so a later production refund fails with `no_payment_reference` (correct).
- Mock SMS body echo and mock phone numbers belong to other slices.

### M12. Slot grid and booking rules are fixed constants (HARD-CODED, LOW)
- `src/lib/availability.ts:13` `SLOT_STEP_MIN = 60` (slots only on the hour; docs/known-limitations.md says so), `DEFAULT_DURATION_MIN = 60`, `MIN/MAX_DURATION`, `src/lib/scheduler.ts:35` `leadMin: 60` for `nextAvailable`, 14-day horizon (`scheduler.ts:33`), `MAX_BOOKINGS_PER_CALL` and 3-reschedule cap are not owner settings. No per-service duration/buffer, no staff/resource capacity (one booking per interval business-wide), no overnight hours. Real implementation: per-business `slot_step`, `buffer`, `lead_time`, `horizon`, capacity; Settings UI. Size: M-L. Decision: yes (single-provider vs. multi-crew).

### M13. Refund policy / pay-page copy (LOW)
- `src/app/pay/[id]/page.tsx:30-33` `DEFAULT_AMOUNT_CENTS = 18_900` and `DEFAULT_BUSINESS = 'Miami Cool Air Conditioning'` demo fallbacks: only used for `mock_` ids in non-prod (`isMockId && !isProd`), verified unreachable in production. DEV.
- Refunds are one per booking, owner-initiated, never automatic (docs/refunds.md, known-limitations.md); partial second refund must be done in Stripe. Documented limitation, not a mock.

---

## B. Verified NOT mocked (so nobody re-checks)
- Billing webhook `/api/billing/webhook` (signature, dedupe via `claimEvent`, `processBillingEvent`), deposit webhook `/api/payments/webhook` (signature mandatory; unsigned only with `STRIPE_ALLOW_UNSIGNED` AND non-prod).
- Stripe customer, checkout session, portal, retrieve subscription, card-fingerprint trial rule, `endTrialNow` (`stripe-billing.ts`), billing emails (`EMAIL_PROVIDER=log` refused in production, `src/lib/email/index.ts:59-66`), usage meters and warnings, past_due grace.
- Booking state machine, cancel with link deactivation queue (`payments/link-store.ts`, drained by `reconcile` job), reschedule with locking, refund service with idempotency keys and reconcile.
- Calendar UI: all buttons in `src/components/calendar/*` call real routes (`bookings/[id]` PATCH, `notify`, `resend-confirmation`, `reschedule`, `slots`, `refund`, `refund/check`, `integrations/google/busy`). No inert controls found.
- Jobs: daily_briefing, gratitude_sweep, cleanup, retention (off by default via `RETENTION_JOB`, documented), recording_deletions, reconcile, usage_warnings, google_calendar. Real leases/claims. `JOBS` defaults on in production, off in dev (`schedule.ts:34`), so in dev nothing runs unless `JOBS=on`.

## C. Counts (this slice)
| Class | Count | IDs |
|---|---|---|
| PROD-reachable defect / silent fake success | 2 | M1, M2 |
| Unwired / missing UI for existing or expected feature | 2 | M3, M4 |
| Hard-coded / static presented as live or configurable | 4 | M5, M6, M8 (copy), M12 |
| Config / operations gap (manual or opt-in) | 1 | M7 |
| DEV-only mock (correctly gated) | 4 | M9, M10, M11, M13 |
| TEST-only doubles | 1 | `tests/helpers/fake-google.ts` (and Stripe/Twilio injected `fetchImpl` in tests) |

Product decisions needed from the owner: M3 (manual-paid semantics), M4 (is the dashboard a scheduler?), M5 (deposit model and currency), M6 (multi-plan?), M7 (auto-release tenants?), M8 (audio storage), M12 (capacity model).
Quick wins with no decision: M1, M2 (prod guard), M9, M10 comment, M11 (`mock-complete` NODE_ENV guard and no mock fallback on Stripe error).
