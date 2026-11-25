# Recepcionista: product requirements (current state)

- **Status date:** 2026-11-24
- **Supersedes:** the v1.0 hackathon PRD (Nov 14, 2026). That plan is in git history.
- **Evidence rule:** every "Shipped" row cites a file that exists in the repo today. Items not in the
  code are marked "Not built". Operator steps (legal, provider consoles) are listed separately.
- **Known limitations:** `docs/known-limitations.md` is the authoritative list of accepted gaps. This PRD
  summarises it; where they differ, that file wins.
- **Not legal advice.** Legal items below are engineering notes for counsel to review.

---

## 1. Product

Recepcionista is a self-serve SaaS that gives a small home-service business a bilingual (English and
Spanish) AI receptionist on its existing business phone. The owner signs up, pastes the business website,
reviews the generated knowledge base, verifies an alert phone, subscribes through a Stripe trial, gets an
AI phone number, forwards their business line to it, and checks it with a test call.

Once live, the receptionist:

- answers calls, discloses that it is an AI and that the call may be recorded (English and Spanish);
- answers prices and service questions from the knowledge base (it is told not to invent prices);
- books appointments against the business's hours and existing bookings, in local time;
- texts a booking confirmation with STOP/HELP wording;
- sends a Stripe payment link by text for an emergency deposit (capped at $500);
- sends an emergency or handoff alert to the owner's verified phone;
- tells callers in an emergency to hang up and call 911 first (gas, carbon monoxide, fire, smoke, sparking);
- takes a message when the owner has paused calls, and keeps voicemails for the owner to play back;
- sends an optional review or gratitude text after a job, if the customer consented.

The owner gets a dashboard with Today, Calls (transcripts and voicemails), Calendar (week, day and month
views), Brain (knowledge base), Briefings, Team, Billing, Security, Settings, and an admin-only demo console.
A background job runner texts the owner a briefing link at 18:00 local time and sends gratitude texts hourly.

## 2. Target market

- **Primary:** owner-operated HVAC, plumbing and electrical businesses, one to five people, in Florida
  (Miami-Dade first). Cleaning, landscaping, dental and general service businesses are supported by vertical
  templates (`docs/verticals.md`); HVAC remains the default and the best-exercised pack. Owners often answer the phone on a job, or miss calls.
- **Language:** English- and Spanish-speaking callers. Bilingual is the wedge; the product itself is not
  Miami-only (nothing in the code restricts the market). Numbers are US-only (see section 5.4).
- **Not sized.** No market-size, call-volume or willingness-to-pay data is in this repo. The v1.0 claim that
  "30-50% of calls are lost" had no source and is removed.

## 3. Personas

| Persona | Who | Needs |
| --- | --- | --- |
| **Owner** | Signs up, pays, sets up, reads the daily briefing, gets alerts | Calls answered, jobs booked, no surprises on the bill, legal safety |
| **Staff** | Office or dispatch member invited by the owner | Read-mostly view of calls, bookings, briefings; can send confirmations and gratitude texts |
| **Caller** (customer) | Calls or texts the business | Fast, honest answer in their language; an emergency routed to 911 first |
| **Operator** (us) | Runs deployment, provider accounts, billing and compliance | Logs, audit trail, caps, kill switches, verify-deploy checks, job controls |

## 4. User journey

1. **Sign up** at `/signup` (email, password, business name). Honeypot, per-IP and per-address limits,
   Turnstile, and a platform-wide signup cap. In production, public signup needs the Turnstile pair (or the
   explicit `SIGNUP_ALLOW_WITHOUT_CAPTCHA=true`); otherwise it is invite-only. No session is issued until the
   email is verified.
2. **Verify email** from the link (the GET page only renders; the button POSTs).
3. **Onboarding** (`/onboarding`), steps: Your business (paste website, AI extracts services, hours,
   prices, FAQs) → Review (edit the knowledge base) → Your phone (verify the owner alert number by SMS code)
   → Plan (Stripe Checkout with trial) → Her number (AI phone number provisioned) → Connect (carrier-specific
   call-forwarding instructions) → Test call (the page polls until the first call arrives).
4. **Billing trial.** Checkout requires a card on file. Trial length defaults to 7 days. One trial per
   person (normalised email and card fingerprint). No number or agent is provisioned before a plan is active
   (production fails closed).
5. **Provision.** The owner (verified email) triggers provisioning. The app buys a Twilio number, creates the
   ElevenLabs agent from the knowledge base and binds the number. If a step fails, the response is a 502 or
   503, the business stays `onboarding`, and a retry resumes where it stopped. No fake number is issued.
6. **Forward calls.** The owner forwards their existing line (no answer, busy, unreachable) to the AI number,
   or uses the Pause mode. On the production (native ElevenLabs) line, the Forward mode is disabled: callers
   hear the paused message (see section 5.4).
7. **Test call.** The owner calls from another phone and hears the disclosure, then tries English and Spanish.
8. **Daily use.** Calls and transcripts appear post-call. Bookings and confirmations are sent. Emergency
   and handoff alerts go to the owner. The day's briefing is generated at 18:00 local time and the owner is
   texted a link (or generated on demand). Plan caps apply each month. Billing status, team and security are
   managed from the dashboard; changes to call handling need a recent password re-check.

## 5. Feature list and status

Status: **Shipped** = built and in the code path; **Partial** = built with a stated gap; **Not built** = absent.
"Operator" means the feature works only after a manual step in the runbook.

### 5.1 Accounts, access, security

| Feature | Status | Evidence |
| --- | --- | --- |
| Self-signup with email verification (no session until verified) | Shipped | `src/app/api/auth/signup/route.ts`, `src/lib/signup.ts`, `docs/auth.md` |
| Signup abuse controls: honeypot, per-IP/address limits, platform cap, Turnstile required in production (or `SIGNUP_ALLOW_WITHOUT_CAPTCHA=true` waiver, otherwise invite-only) | Shipped | `src/lib/signup-config.ts`, `src/lib/signup.ts`, `src/instrumentation.ts` (startup warning), `src/components/auth/turnstile.tsx`, `docs/auth.md` |
| Roles: admin, owner, staff; tenant isolation (404 on cross-tenant) | Shipped | `src/lib/session.ts`, `src/proxy.ts`, `tests/auth-db.test.ts` |
| Password login with per-account and per-IP throttling | Shipped | `src/lib/login-throttle.ts`, `src/app/api/auth/login/route.ts` |
| TOTP 2FA with recovery codes, MFA-pending sessions | Shipped | `src/lib/totp.ts`, `src/lib/mfa.ts`, `src/app/api/auth/2fa/*` |
| Step-up re-authentication (password or 2FA code, 5-minute window) for call-handling and forwarding changes | Shipped. Pre-existing sessions have no recent-auth stamp and are asked once. The break-glass admin token is exempt. | `src/lib/session.ts`, `src/app/api/auth/reauth/route.ts`, `src/components/dashboard/reauth.tsx` |
| Change notices: owner is told by email and text when call handling or the forwarding number changes (rate limited) | Shipped | `src/lib/voice/call-handling-changes.ts`, `src/lib/account-flows.ts` |
| Active session list and revoke | Shipped | `src/app/api/auth/sessions/*`, `src/app/dashboard/security/page.tsx` |
| Password reset (1 h token, revokes all sessions) | Shipped | `src/app/api/auth/reset-password/route.ts` |
| Team invites, role change, disable, remove, audit trail | Shipped | `src/app/api/team/*`, `src/app/dashboard/team/`, `src/app/dashboard/team/audit/` |
| Break-glass `ADMIN_TOKEN` (revocable 12 h sessions) | Shipped | `docs/auth.md` |
| Cookie CSRF same-origin checks | Shipped | `src/proxy.ts`, `src/lib/session.ts` |
| Admin can create users; demo console (admin only; the page and nav exist only with `DEMO_MODE=true`, never in production) | Shipped | `src/app/api/admin/users/route.ts`, `src/app/dashboard/demo/page.tsx` |

### 5.2 Billing and usage limits

| Feature | Status | Evidence |
| --- | --- | --- |
| Stripe subscription Checkout with card on file and trial | Shipped (operator: live keys, price, webhook) | `src/app/api/billing/checkout/route.ts`, `src/lib/providers/stripe-billing.ts`, `docs/billing.md` |
| Trial length `BILLING_TRIAL_DAYS` (default 7, 0-90) | Shipped | `src/lib/providers/stripe-billing.ts` |
| One trial per person (email and card fingerprint, HMAC) | Shipped | `src/lib/billing/trial.ts` |
| Signed Stripe webhook, idempotent | Shipped | `src/app/api/billing/webhook/route.ts`, `src/lib/billing/webhook.ts` |
| Customer portal (manage, cancel at period end) | Shipped | `src/app/api/billing/portal/route.ts` |
| Past-due grace (`BILLING_PAST_DUE_GRACE_DAYS`, default 5) | Shipped | `src/lib/db/usage.ts` |
| Provisioning gated on an active or trialing plan (production fails closed) | Shipped | `src/lib/billing/gate.ts`, `src/lib/db/usage.ts` |
| Monthly caps: texts (counted in SMS segments, reserved atomically before send) and call minutes; env defaults 500 segments and 300 minutes; per-business overrides | Shipped | `src/lib/db/usage.ts` (`reserveSms`, `checkSmsAllowed`), `src/lib/messaging/index.ts`, `src/lib/messaging/policy.ts` (`smsSegments`) |
| Trial caps while trialing: min(`TRIAL_SMS_CAP` 50, plan) texts and min(`TRIAL_CALL_MINUTES_CAP` 30, plan) minutes (applied only while billing is enforced) | Shipped | `src/lib/db/usage.ts` (`DEFAULT_TRIAL_SMS_CAP`, `DEFAULT_TRIAL_CALL_MINUTES_CAP`) |
| Over-cap behaviour: customer texts `blocked_cap`; owner alerts are exempt from the plan cap and have their own hourly budget; calls get an out-of-service line | Shipped | `src/lib/messaging/index.ts`, `src/lib/voice/owner-alert.ts`, `src/lib/voice/capacity.ts`, `docs/compliance.md` |
| Dashboard banner when a cap is reached | Shipped. No warning before the cap (for example at 80%) is built. | `src/lib/billing/banner-state.ts` |
| Forwarded-call minutes metered from Twilio callbacks and counted against the same caps | Shipped | `src/lib/voice/forward-metering.ts` |
| Usage from AI calls is added by the post-call webhook | Partial. A call whose post-call never arrives is not metered. | `src/app/api/voice/post-call/route.ts`, `docs/known-limitations.md` |
| Grandfathering existing tenants | Shipped (operator script) | `scripts/grandfather-existing.ts`, `docs/billing.md` |
| Release of canceled tenants: Twilio number and ElevenLabs agent released after a grace period (default 30 days) and a heads-up mail (default 7 days); comped plans and shared resources never released | Shipped (operator script or admin API; not automatic) | `scripts/release-canceled-tenants.ts`, `src/lib/billing/release.ts`, `src/app/api/admin/release-tenant/route.ts` |
| Mock checkout for local development only (`DEMO_MODE=true`, no Stripe key, never in production) | Shipped | `src/app/api/billing/mock-activate/route.ts`, `src/lib/providers/stripe-billing.ts` |

### 5.3 Onboarding and knowledge base

| Feature | Status | Evidence |
| --- | --- | --- |
| Website to knowledge base (SSRF-guarded fetch, redirect re-validation) | Shipped | `src/app/api/extract/route.ts`, `src/lib/extraction/index.ts`, `src/lib/net/safe-fetch.ts` |
| Template fallback when no LLM key is set | Partial. Call summaries and briefings fall back to templates. Website extraction REFUSES without a key (422); a business with no website gets the vertical's template knowledge base (starting prices to be reviewed). | `src/lib/extraction/index.ts`, `src/lib/providers/llm.ts` |
| Knowledge base and prompt editor (includes business hours) | Shipped | `src/components/dashboard/knowledge-editor.tsx`, `src/app/dashboard/knowledge/page.tsx` |
| Owner alert phone verification (SMS code, rate limited) | Shipped | `src/lib/messaging/owner-verify.ts`, `src/app/api/businesses/[id]/owner-phone/verify/*` |
| Carrier call-forwarding instructions (AT&T, T-Mobile, Verizon, GSM, landline, VoIP) | Shipped | `src/app/onboarding/forwarding.ts` |
| Test-call step (polls until the first call) | Shipped | `src/app/onboarding/step-test.tsx` |
| Vertical templates: seven trade packs (prompt, emergency rules, services, FAQs, SMS wording, deposit default), chosen in onboarding and Settings, owner-only change with step-up that never overwrites edited knowledge | Shipped | `src/lib/verticals/`, `docs/verticals.md`, `src/app/api/businesses/[id]/route.ts`, `tests/verticals-pure.test.ts`, `tests/integration/verticals.test.ts` |
| Minimum content checks (5 services, 3 FAQs) | Shipped (gate: 3 priced services, hours, 1 FAQ; 5 and 3 recommended) | `src/lib/kb/readiness.ts`, provision 422 `kb_incomplete`, checklist on Brain and onboarding |

### 5.4 Phone and voice

| Feature | Status | Evidence |
| --- | --- | --- |
| AI phone number purchase through Twilio (US numbers; area code from the owner phone, else `TWILIO_AREA_CODE`, default 305) | Shipped (operator: Twilio credentials). Fails closed: a failed step returns 502/503, the business stays `onboarding`, a retry resumes, and no fake number is issued once Twilio is configured or in production. Mock-pool numbers exist only outside production without Twilio credentials. | `src/app/api/businesses/[id]/provision/route.ts`, `src/lib/providers/twilio.ts` (`fakeNumberAllowed`), `src/lib/phone.ts` |
| Number bound to the ElevenLabs agent (inbound voice) | Shipped (operator: verify the binding). One configured `ELEVENLABS_PHONE_NUMBER_ID`. | `src/lib/voice/elevenlabs.ts` (`bindPhoneNumber`), `docs/runbook.md` |
| Conversation-initiation webhook: disclosure evidence and cap enforcement | Partial. Request shape verified against vendor docs; the API calls that configure it are unverified (`docs/runbook.md` section 6). | `src/app/api/voice/initiation/route.ts`, `docs/runbook.md` |
| Disclosure at call start, English and Spanish (owner text can extend, not replace) | Shipped | `src/lib/voice/elevenlabs.ts` (`firstMessageFor`), `src/lib/kb/disclosure.ts` |
| Declined recording: sticky `declined`, transcript withheld, provider conversation deleted (best effort) | Shipped | `src/lib/voice/postcall.ts`, `docs/compliance.md` |
| Post-call webhook with HMAC check; one row per call | Shipped | `src/app/api/voice/post-call/route.ts`, `src/app/api/voice/webhook/route.ts`, `src/lib/voice/postcall.ts` |
| Core voice tools: `check_availability`, `create_booking`, `send_sms`, `create_payment_link`, `flag_emergency`, `get_pricing`, `handoff_to_human`; plus `reschedule_booking`, `cancel_booking`, `transfer_to_human` (`NATIVE_TRANSFER=on`) and the owner call-in tools | Shipped | `src/lib/voice/tools.ts`, `src/app/api/voice/tools/[tool]/route.ts` |
| Tool calls authenticated by a shared secret header | Shipped | `src/lib/voice/elevenlabs.ts` (`verifyToolSecret`) |
| Pause mode: the assistant takes no bookings, texts or payments; callers are told so and can leave a message (name and number on the AI line; a recorded voicemail on a webhook line) | Shipped | `src/lib/voice/call-mode.ts`, `src/lib/voice/non-ai.ts`, `src/app/api/businesses/[id]/call-mode/route.ts`, `src/components/dashboard/call-mode.tsx` |
| Forward mode: calls are bridged to the owner's verified number | Partial. Works only on a webhook line (`VOICE_LINE_KIND=webhook`, Twilio Voice URL `/api/voice/incoming`) or through the owner's own carrier forwarding. On the native ElevenLabs line (the production setup) it is disabled: the dashboard says so, `PATCH call-mode {mode:'forward'}` returns 422, and callers hear the paused message. | `src/lib/voice/line.ts` (`FORWARD_UNAVAILABLE`), `src/lib/voice/call-mode.ts`, `src/app/api/voice/incoming/route.ts`, `docs/known-limitations.md` |
| Forwarding-number controls: verified by SMS code, step-up re-auth, may not be any assistant line (any tenant or the platform number), re-checked at dial time | Shipped | `src/lib/voice/forward-vet.ts`, `src/lib/voice/forward-number.ts`, `src/app/api/businesses/[id]/forward-number/*` |
| Voicemail capture on a paused or forwarded webhook line; Voicemails tab in Calls; audio played through an authenticated proxy (the Twilio URL and credentials never reach the browser) | Shipped | `src/lib/voice/voicemail.ts`, `src/app/api/voice/voicemail/route.ts`, `src/app/api/calls/[id]/voicemail/route.ts`, `src/components/dashboard/voicemail-list.tsx`, `src/app/dashboard/calls/page.tsx` |
| Booking: local wall-clock time, hours, past times refused, slot conflicts, 2-bookings-per-call cap | Shipped | `src/lib/scheduler.ts`, `src/lib/availability.ts`, `src/lib/voice/tools.ts`, `tests/integration/` |
| Emergency: 911 first for gas, CO, fire, smoke, sparking; then `flag_emergency`; owner alerts have an hourly budget (`OWNER_ALERT_HOURLY_LIMIT`, default 6) | Shipped (prompt, tool and budget). Not a substitute for a human; see risks. | `src/lib/voice/emergency.ts`, `src/lib/kb/index.ts`, `src/lib/voice/owner-alert.ts` |
| Live human transfer | Shipped behind `NATIVE_TRANSFER` (default off, live behaviour unverified: docs/known-limitations.md); `handoff_to_human` still texts the owner. | `src/lib/voice/transfer.ts`, `src/lib/voice/elevenlabs.ts` (`transferToolConfig`) |
| Owner correction of the knowledge base by voice | Shipped as owner call-in (SMS-confirmed, undoable; hours, closed dates, service area, services, FAQs). Owner voice REPLY shipped too: the owner hears recent leads and has one customer texted back, only after an SMS YES code, no undo (`OWNER_REPLY_ENABLED`). | `docs/owner-call-in.md`, `src/lib/voice/owner/`, `src/lib/messaging/owner-reply.ts` |
| Live transcript during a call | Shipped (SSE + polling fallback, consent-gated; provider field UNVERIFIED) | `src/lib/voice/live-transcript.ts`, `src/app/api/calls/[id]/live/route.ts` |
| Dashboard, onboarding, auth, public pages, emails and owner texts in English and Spanish; per-user language, business default | Shipped (Spanish copy not natively reviewed; model/caller-written content stays as written) | `docs/i18n.md`, `src/lib/i18n/` |
| Bilingual conversation (English and Spanish) | Partial. Driven by the prompt and the model, plus ElevenLabs language detection (`LANGUAGE_DETECTION`, on by default). Quality is not measured. | `src/lib/voice/elevenlabs.ts`, `src/lib/kb/index.ts` |

### 5.5 Messaging and consent

| Feature | Status | Evidence |
| --- | --- | --- |
| Customer SMS (confirmation, payment link, replies) via Twilio, logged in `sms_log` | Shipped | `src/lib/messaging/index.ts`, `src/lib/messaging/templates.ts` |
| "Reply STOP to opt out" footer; 300 characters and 5 segments | Shipped | `src/lib/messaging/policy.ts` (`withStopFooter`) |
| STOP/START/HELP keywords, English and Spanish | Shipped. Twilio's own STOP handling can block a number before the webhook sees it. | `src/lib/messaging/keywords.ts`, `src/app/api/sms/inbound/route.ts`, `docs/compliance.md` |
| Owner alerts only to a verified owner phone; no alert otherwise, and the caller is told honestly | Shipped | `src/lib/voice/owner-alert.ts`, `src/lib/messaging/owner.ts` |
| Gratitude and review texts: consent-gated, 9pm-8am quiet hours, 4-5 star routes to review, 1-3 to owner | Shipped. Runs hourly through the job runner for each live business; a manual `POST /api/gratitude/run` also exists. | `src/lib/gratitude/index.ts`, `src/lib/gratitude/reply.ts`, `src/lib/jobs/index.ts` (`runGratitudeJob`), `src/app/api/gratitude/run/route.ts` |
| Consent recorded from the confirmation text ("We may text you after your visit") | Shipped | `src/lib/messaging/actions.ts`, `docs/compliance.md` |
| Free-text SMS by the owner (`manual`) | Shipped. The caller cannot choose the consent basis. | `src/app/api/sms/send/route.ts` |
| 10DLC / A2P brand and campaign registration | Not built in app. Operator task before US texting. | `docs/runbook.md` section 5 |

### 5.6 Payments (customer deposits)

| Feature | Status | Evidence |
| --- | --- | --- |
| Stripe Payment Link for a deposit, texted to the caller's own number | Shipped (operator: Stripe keys) | `src/lib/providers/stripe.ts`, `src/app/api/payments/create-link/route.ts`, `src/app/api/sms/payment-link/route.ts` |
| $500 deposit cap in three places | Shipped | `src/lib/voice/tools.ts` (`DEPOSIT_CAP_CENTS`), `src/app/api/payments/create-link/route.ts` (`MAX_CENTS`) |
| Production fails closed if Stripe errors (no mock link) | Shipped | `src/lib/providers/stripe.ts` |
| Signed deposit webhook confirms the booking and records the deposit | Shipped | `src/app/api/payments/webhook/route.ts` |
| Cancelling a booking with a paid deposit: the owner is told to refund it in Stripe; nothing is refunded or texted automatically | Shipped as a notice. No automatic refund. | `src/components/calendar/booking-panel.tsx`, `src/app/api/bookings/[id]/route.ts` |
| Refund and dispute policy (written policy, linked from Checkout) | Shipped; operator must review the wording | per-business policy, `/refunds`, owner-initiated refunds with step-up, dispute alert (`docs/refunds.md`) |

### 5.7 Dashboard and reporting

| Feature | Status | Evidence |
| --- | --- | --- |
| Today, Calls, Calendar, Brain, Briefings, Team, Billing, Security, Settings | Shipped | `src/components/dashboard/shell.tsx`, `src/app/dashboard/*` |
| Calls page: transcript, summary, status, and a Voicemails tab | Shipped | `src/app/dashboard/calls/page.tsx`, `src/components/dashboard/calls-list.tsx` |
| Call recording player | Shipped: consent-gated proxy with Range | `src/app/api/calls/[id]/audio/route.ts`, `src/components/dashboard/recording-player.tsx` |
| Calendar grid: week, day and month views; owner can cancel, mark completed and resend the confirmation. Reschedule is built (dashboard dialog and the voice `reschedule_booking` tool). | Shipped | `src/app/dashboard/bookings/page.tsx`, `src/components/calendar/calendar.tsx`, `src/components/calendar/time-grid.tsx`, `src/components/calendar/month-grid.tsx`, `src/components/calendar/booking-panel.tsx` |
| Daily briefing: content (calls, bookings, revenue, flags) | Shipped | `src/lib/briefing/index.ts`, `src/app/api/briefings/generate/route.ts` |
| 6 PM automatic briefing, per business time zone (catch-up until local midnight); owner texted a link when verified, outside quiet hours and within the SMS cap | Shipped. Runs in the job runner (`JOBS`, on by default in production). | `src/lib/jobs/index.ts` (`runDailyBriefings`), `src/lib/jobs/schedule.ts` (`briefingSlot`), `src/instrumentation.ts` |
| Briefing audio (ElevenLabs TTS; text only without a TTS key) | Partial. Audio with `ELEVENLABS_API_KEY`; without it only a development Mac (`say`) can produce audio. Served by an authenticated route. | `src/lib/briefing/tts.ts`, `src/app/api/briefings/audio/[name]/route.ts` |
| Settings: alert phone, call disclosure text, retention window, call mode and forwarding number | Shipped. Hours are edited in Brain, not Settings. | `src/components/dashboard/settings-form.tsx`, `src/app/api/businesses/[id]/settings/route.ts`, `src/components/dashboard/call-mode.tsx` |
| Settings: voice selection | Shipped (allowlist / premade voices, re-sync) | `src/components/dashboard/voice-settings.tsx`, `src/app/api/businesses/[id]/voice/route.ts` |

### 5.8 Privacy and retention

| Feature | Status | Evidence |
| --- | --- | --- |
| Export one customer's data (owner or admin); voicemail is listed with its playback path | Shipped (API) | `src/app/api/privacy/export/route.ts`, `src/lib/privacy.ts` |
| Erase one customer's data (calls, SMS log, briefings, bookings anonymised, Twilio voicemail audio deleted best effort) | Shipped (API) | `src/app/api/privacy/erase/route.ts`, `src/lib/db/compliance.ts` |
| Retention purge: per-business `retention_days`, daily through the job runner. **Off by default** (`RETENTION_JOB=on` required). | Shipped | `src/lib/retention-job.ts`, `src/lib/jobs/index.ts`, `src/app/api/admin/retention/route.ts` |
| Opt-outs are never purged | Shipped | `docs/compliance.md` |
| Privacy policy, terms, DPAs | Not in app. Operator task. | `docs/runbook.md` section 5 |

### 5.9 Operations

| Feature | Status | Evidence |
| --- | --- | --- |
| Background job runner: daily briefing, gratitude sweep (hourly), cleanup (hourly), retention (daily, opt-in). Per-business Postgres leases and idempotency claims, so several instances do each unit of work once. `JOBS=on\|off`, `JOBS_TICK_SECONDS`. | Shipped | `src/lib/jobs/index.ts`, `src/lib/jobs/schedule.ts`, `src/instrumentation.ts` |
| Admin manual job run (dry run by default; bypasses only the 18:00 gate) | Shipped | `src/app/api/admin/jobs/run/route.ts` |
| Docker Compose production stack behind Traefik; Postgres 17 pinned by digest | Shipped | `compose.production.yaml`, `Dockerfile`, `deploy.sh` |
| Health endpoint | Shipped | `src/app/api/health/route.ts` |
| Post-deploy checks (signatures, auth, public pages) | Shipped | `scripts/verify-deploy.ts`, `docs/runbook.md` section 3 |
| Audit log of security, billing, provisioning and job events | Shipped | `src/lib/db/audit.ts`, `docs/auth.md`, `docs/billing.md` |
| Typed, paginated database layer (Prisma; list queries return a `Page`) | Shipped | `src/lib/db/paging.ts`, `src/lib/db/index.ts` (`listCallsPage`) |
| CI: install, Prisma generate, typecheck, lint, build, migrate, `bun test` against Postgres 17 (same major as production) with `TEST_DATABASE_URL` set | Shipped | `.github/workflows/ci.yml` |
| Test suite: about 1,500 `test()`/`it()` cases in about 95 files (`bun test` reports the exact count) under `tests/`, including `tests/db` and `tests/integration` (DB-backed suites need `TEST_DATABASE_URL`) | Shipped. Not re-run for this document. | `tests/`, `docs/testing.md` |
| Hardening changelog (every review finding mapped to its current state) and point-in-time reviews | Shipped | `docs/changelog-hardening.md`, `docs/review/` |

## 6. Non-goals

- Multi-location or franchise accounts. One business per owner account.
- Outbound marketing or outbound calls.
- Dispatching subcontractors or sending technicians.
- A staffed answering service. (Live human transfer exists behind `NATIVE_TRANSFER`, off by default.)
- Replacing the internal calendar: it stays the source of truth; Google Calendar sync is an optional two-way mirror.
- Card data over the phone or inside the app. Deposits use Stripe-hosted payment links.
- Legal advice, HIPAA (the dental template is not a HIPAA-compliant product), PCI scope, data residency.
- Native mobile app. The dashboard is responsive web.

## 7. Architecture

```
caller ──PSTN──> ElevenLabs agent (bound to Twilio number)
                    │  tool calls (shared-secret header)      ▲ post-call webhook (HMAC)
                    ▼                                          │
owner/staff ──> Next.js 16 app (route handlers + server components)
                    │  proxy.ts: cheap cookie/shape gate; real checks in lib/session.ts
                    ├── Postgres 17 via Prisma (all state, audit, rate-limit buckets, leases, job claims)
                    ├── Job runner (in each app process; leases and claims keep it to one run per unit)
                    ├── Twilio: number purchase, outbound SMS, inbound SMS, voicemail and forwarded-call webhooks
                    ├── ElevenLabs: agents, voice (TTS for briefings), post-call and initiation webhooks
                    ├── Stripe: subscriptions and billing webhook; deposit Payment Links and webhook
                    ├── LLM (OpenAI or Anthropic, whichever key is set): knowledge-base generation
                    └── Email (Resend or SMTP): verification, invites, billing and change notices
```

Key design points, all in the code:

- **Tenancy.** Every business-scoped handler resolves the business from the principal, not from the request.
- **Webhooks** verify signatures and fail closed in production. Stripe, Twilio and ElevenLabs each have a check.
- **Idempotency.** Processed-event records and DB leases guard webhooks, provisioning, the job runner and the retention job.
- **Consent evidence.** The app records the disclosure only from server-side evidence, never from what the caller says.
- **Metering.** Usage counters are per business per calendar month, in the business's time zone. Texts count SMS segments.
- **Deployment.** Single image set (app, tools for migrate and seed). Migrations run before the app starts.

## 8. Tech stack

| Layer | Choice (verified in `package.json`, `Dockerfile`, `compose.production.yaml`) |
| --- | --- |
| Web framework | Next.js 16.4.6 (App Router), React 19.3.0, Tailwind CSS 4.3.3 |
| Runtime and package manager | Bun 1.4.1 (Docker image `oven/bun`); Node runtime for route handlers |
| Database | PostgreSQL 17 (`postgres:17-alpine`, pinned by digest), Prisma 6.16.2. CI tests use PostgreSQL 16. |
| Voice | ElevenLabs Agents (conversational agent, phone binding), ElevenLabs TTS for briefing audio |
| Telephony and SMS | Twilio (number purchase, SMS, inbound SMS webhook, voicemail and forwarding callbacks) |
| Payments | Stripe (Billing subscriptions with Checkout and Portal; Payment Links for deposits) |
| LLM | OpenAI (`LLM_MODEL`) or Anthropic (`ANTHROPIC_MODEL`), whichever key is set |
| Email | Resend REST API or SMTP via nodemailer (`EMAIL_PROVIDER`) |
| Bot protection | Cloudflare Turnstile (required for public signup in production, or the explicit waiver) |
| Other libraries | `libphonenumber-js` (E.164), `cheerio` (page extraction), `qrcode` (2FA setup), `date-fns`, `sonner` |
| Deployment | Docker Compose behind Traefik (`compose.production.yaml`), `deploy.sh` |
| Not used | Supabase. The `SUPABASE_*` variables in v1.0 are not read anywhere in the code. |

## 9. Risks and mitigations

| Risk | Likelihood / impact | Current mitigation | Gap or action |
| --- | --- | --- | --- |
| **Recording consent (Florida all-party consent, Fla. Stat. 934.03; other states differ)** | High / High | Disclosure at call start in English and Spanish; declined calls keep metadata only; provider conversation deleted on decline (best effort) | Counsel must review wording and consent bases per state. Provider-side audio retention must be set by the operator. |
| **TCPA, 10DLC and texting consent** | Medium / High | STOP/HELP handling; gratitude texts need recorded consent; quiet hours; per-business rate limits | 10DLC registration is not in the app. Counsel review of the consent basis. Twilio may block a number before the webhook sees a STOP. |
| **Personal data (caller phone, names, addresses, transcripts, recordings, voicemails)** | Medium / High | Export and erase endpoints (erasure also deletes Twilio voicemail audio, best effort); E.164 matching; audit trail; opt-outs never purged | Retention purge is **off by default**; turn on (`RETENTION_JOB=on`) only after each business's window is reviewed. No DPA or privacy policy in the repo. |
| **Life safety (gas, CO, fire) during a call** | Low / Severe | 911-first instruction in every production prompt; `flag_emergency` speaks the 911 advice; owner-alert budget | The agent is not an emergency service. No live transfer (section 5.4), so emergencies depend on owner response. Alerts only reach a verified phone. |
| **Cost abuse (signup spam, SMS pumping, call-minute drain)** | Medium / High | Plan gate; monthly caps in segments and minutes with trial caps; reserved-before-send SMS counting; Turnstile; per-IP and platform signup caps; alert-phone verification; owner-alert budget | No warning before a cap is reached. Missed post-call metering under-counts calls. Forwarded-call callbacks that never arrive are not counted. |
| **Business line redirected by a hijacked session** | Low / High | Step-up re-check (password or 2FA code) for call-handling and forwarding changes; forwarding number verified by SMS code; change notices by email and text; audit row per mode change | Pre-existing sessions ask for the password once. Break-glass admin token is exempt from re-check. |
| **Number provisioning fails or buys a number that is not adopted** | Low / Medium | Fails closed (502/503, stays `onboarding`); resumable; a purchase whose answer was lost is adopted only if tagged with this attempt | A purchase Twilio completed but never confirmed can be left unadopted (see `provision.number_failed` audit row and `docs/known-limitations.md`). US numbers only. |
| **Background jobs silently stop** | Medium / Medium | Jobs run in every app instance under leases; `JOBS=off` is explicit; boot log states the job setting; manual run via admin API | If every instance is down at 18:00 the briefing is caught up only until local midnight. Operator should check the boot log after each deploy. |
| **Provider dependency (ElevenLabs, Twilio, Stripe, LLM, email)** | High / High | Each provider has a mock path outside production; Stripe and webhooks fail closed in production | Voice binding and the initiation webhook use ElevenLabs API calls whose shape is not fully verified (runbook section 6). Re-test after each vendor change. Voice depends on one vendor. |
| **Prompt injection and bad answers** (caller or website text reaches the agent prompt) | Medium / Medium | Tool allow-list; no free-text recipient for voice SMS; prices must come from `get_pricing` | Bilingual quality and hallucination rate are not measured. Add call-quality review before scaling. |
| **Double booking and time zones** | Low / Medium | Local wall-clock handling; overlap tests including a 20-way race (`tests/integration/`) | Re-run the integration suite on every booking change. |
| **Operator skips a legal or provider step** | Medium / High | `verify-deploy` script; runbook checklists; deploy refuses unset required variables | Checklist items in runbook section 5 are not enforced by code. |

## 10. Success metrics (proposed, no baseline yet)

These are targets to set after the first paying cohort. None is measured today.

| Metric | Definition | Why it matters |
| --- | --- | --- |
| Activation | Signed-up owners who complete onboarding and receive a first call | Shows whether the URL-to-agent flow works |
| Time to first call | Minutes from signup to first inbound call | Tests the "set up in minutes" claim |
| Trial to paid | Trials that convert to an active subscription | Core revenue health |
| Missed-call recovery | Calls answered by the agent that end in a booking, a deposit or a callback | Core value |
| Disclosure coverage | Share of calls with `consent_status = disclosed` before the post-call | Legal and product quality gate (target: all calls outside declined) |
| Opt-out rate | STOP replies per 100 texts sent | Texting health and compliance |
| Cap hits | Businesses that hit the text (segment) or minute cap in a month | Pricing and cap tuning |
| Cost per call and per business-month | Provider spend per answered call and per active business | Unit economics (see `docs/product/monetization.md`) |
| Churn | Cancellations within 60 days of paid start | Retention |

## 11. Roadmap (genuinely not built)

Ordered by what most blocks a paying launch:

1. **Live human transfer** on by default: built behind `NATIVE_TRANSFER` (off) pending a live test, instead of a callback flag.
2. **Forwarding on the production AI line.** No supported API exists for a per-call transfer override on the native ElevenLabs path (see `docs/known-limitations.md`). Forwarding works today only on a webhook line or through carrier forwarding.
3. ~~Minimum content checks~~ Done: provisioning is gated on 3 priced services, opening hours and 1 FAQ (5 and 3 recommended).
4. ~~Refund and dispute policy~~ Done (`docs/refunds.md`): policy, `/refunds`, customer text on cancel, owner-initiated refunds. Still manual by design: the app never refunds without an owner action.
5. **Warning before a cap** (for example at 80%) by email or text, and reconciliation for calls whose post-call webhook never arrives.
6. ~~Recording player~~ Done (consent-gated proxy).
7. **Operator-independent compliance:** 10DLC registration support and a per-state disclosure setting.
8. ~~Voice selection~~ Done (allowlist).
9. ~~Calendar reschedule~~ Done (dashboard and voice).

Built (not roadmap): voice correction of the knowledge base, owner voice REPLY (`OWNER_REPLY_ENABLED`, follows `OWNER_CALLIN_ENABLED`), the live transcript and Google Calendar sync (docs/changelog-hardening.md "Phase: features").

Not planned: multi-location, outbound calls.

Engineering debt (no behaviour change): extract `provisionBusiness` from the provision route; replace the remaining raw hex colours with design tokens; add an automated accessibility audit to CI.

## 12. Changes from v1.0

| v1.0 claim | Now |
| --- | --- |
| Supabase schema and client | Removed. Postgres 17 with Prisma. |
| Next.js 14 | Next.js 16.4.6. |
| "30-50% of calls lost" and "Miami market is underserved" | Removed. No source. |
| Demo number `+1-305-555-0199` | Removed. Demo numbers are mock numbers. |
| Owner dashboard with settings for voice and hours | Partial. Alert phone, disclosure, retention and call mode in Settings; hours in Brain. Voice selection shipped. |
| 6 PM auto-briefing | Shipped (job runner, per business time zone). |
| Live human transfer | Shipped behind `NATIVE_TRANSFER` (off by default). |
| Spanglish detection | Partial. Prompt-driven, no detection code. |
| Stripe test mode only | Operator setting. No code check that the keys are test-mode keys. |
| Recording and consent disclosure: absent in v1.0 | Shipped (section 5.4). |
| Calendar as a list | Calendar grid (week, day, month) shipped. |
| Stretch: gratitude, KB voice correction, live transcript | Gratitude sweep shipped and scheduled hourly. KB voice correction and live transcript are built. |
