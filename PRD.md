# Recepcionista: product requirements (current state)

- **Status date:** 2026-11-23
- **Supersedes:** the v1.0 hackathon PRD (Nov 14, 2026). That plan is in git history.
- **Evidence rule:** every "Shipped" row cites a file that exists in the repo today. Items not in the
  code are marked "Not built". Operator steps (legal, provider consoles) are listed separately.
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
- sends an optional review or gratitude text after a job, if the customer consented.

The owner gets a dashboard with Today, Calls (transcripts), Calendar (bookings), Brain (knowledge base),
Briefings, Team, Billing, Security, Settings, and an admin-only demo console.

## 2. Target market

- **Primary:** owner-operated HVAC, plumbing and electrical businesses, one to five people, in Florida
  (Miami-Dade first). Owners often answer the phone on a job, or miss calls.
- **Language:** English- and Spanish-speaking callers. Bilingual is the wedge; the product itself is not
  Miami-only (nothing in the code restricts the market).
- **Not sized.** No market-size, call-volume or willingness-to-pay data is in this repo. The v1.0 claim that
  "30-50% of calls are lost" had no source and is removed.

## 3. Personas

| Persona | Who | Needs |
| --- | --- | --- |
| **Owner** | Signs up, pays, sets up, reads the daily briefing, gets alerts | Calls answered, jobs booked, no surprises on the bill, legal safety |
| **Staff** | Office or dispatch member invited by the owner | Read-mostly view of calls, bookings, briefings; can send confirmations and gratitude texts |
| **Caller** (customer) | Calls or texts the business | Fast, honest answer in their language; an emergency routed to 911 first |
| **Operator** (us) | Runs deployment, provider accounts, billing and compliance | Logs, audit trail, caps, kill switches, verify-deploy checks |

## 4. User journey

1. **Sign up** at `/signup` (email, password, business name). Honeypot, per-IP and per-address limits,
   optional Turnstile, and a platform-wide signup cap. No session is issued until the email is verified.
2. **Verify email** from the link (the GET page only renders; the button POSTs).
3. **Onboarding** (`/onboarding`), steps: Your business (paste website, AI extracts services, hours,
   prices, FAQs) → Review (edit the knowledge base) → Your phone (verify the owner alert number by SMS code)
   → Plan (Stripe Checkout with trial) → Her number (AI phone number provisioned) → Connect (carrier-specific
   call-forwarding instructions) → Test call (the page polls until the first call arrives).
4. **Billing trial.** Checkout requires a card on file. Trial length defaults to 7 days. One trial per
   person (normalised email and card fingerprint). No number or agent is provisioned before a plan is active
   (production fails closed).
5. **Provision.** The owner (verified email) triggers provisioning. The app buys a Twilio number, creates the
   ElevenLabs agent from the knowledge base and binds the number. See the known bug in section 9.
6. **Forward calls.** The owner forwards their existing line (no answer, busy, unreachable) to the AI number.
7. **Test call.** The owner calls from another phone and hears the disclosure, then tries English and Spanish.
8. **Daily use.** Calls and transcripts appear post-call. Bookings and confirmations are sent. Emergency
   and handoff alerts go to the owner. The owner generates the day's briefing (on demand). Plan caps apply
   each month. Billing status, team and security are managed from the dashboard.

## 5. Feature list and status

Status: **Shipped** = built and in the code path; **Partial** = built with a stated gap; **Not built** = absent.
"Operator" means the feature works only after a manual step in the runbook.

### 5.1 Accounts, access, security

| Feature | Status | Evidence |
| --- | --- | --- |
| Self-signup with email verification (no session until verified) | Shipped | `src/app/api/auth/signup/route.ts`, `src/lib/signup.ts`, `docs/auth.md` |
| Signup abuse controls (honeypot, per-IP/address limits, optional Turnstile, platform cap) | Shipped | `src/lib/signup.ts`, `src/components/auth/turnstile.tsx`, `docs/auth.md` |
| Roles: admin, owner, staff; tenant isolation (404 on cross-tenant) | Shipped | `src/lib/session.ts`, `src/proxy.ts`, `tests/auth-db.test.ts` |
| Password login with per-account and per-IP throttling | Shipped | `src/lib/login-throttle.ts`, `src/app/api/auth/login/route.ts` |
| TOTP 2FA with recovery codes, MFA-pending sessions | Shipped | `src/lib/totp.ts`, `src/lib/mfa.ts`, `src/app/api/auth/2fa/*` |
| Active session list and revoke | Shipped | `src/app/api/auth/sessions/*`, `src/app/dashboard/security/page.tsx` |
| Password reset (1 h token, revokes all sessions) | Shipped | `src/app/api/auth/reset-password/route.ts` |
| Team invites, role change, disable, remove, audit trail | Shipped | `src/app/api/team/*`, `src/app/dashboard/team/`, `src/app/dashboard/team/audit/` |
| Break-glass `ADMIN_TOKEN` (revocable 12 h sessions) | Shipped | `docs/auth.md` |
| Cookie CSRF same-origin checks | Shipped | `src/proxy.ts`, `src/lib/session.ts` |
| Admin can create users; demo console (admin only, `DEMO_MODE`) | Shipped | `src/app/api/admin/users/route.ts`, `src/app/dashboard/demo/page.tsx` |

### 5.2 Billing

| Feature | Status | Evidence |
| --- | --- | --- |
| Stripe subscription Checkout with card on file and trial | Shipped (operator: live keys, price, webhook) | `src/app/api/billing/checkout/route.ts`, `src/lib/providers/stripe-billing.ts`, `docs/billing.md` |
| Trial length `BILLING_TRIAL_DAYS` (default 7, 0-90) | Shipped | `src/lib/providers/stripe-billing.ts` |
| One trial per person (email and card fingerprint, HMAC) | Shipped | `src/lib/billing/trial.ts` |
| Signed Stripe webhook, idempotent | Shipped | `src/app/api/billing/webhook/route.ts`, `src/lib/billing/webhook.ts` |
| Customer portal (manage, cancel at period end) | Shipped | `src/app/api/billing/portal/route.ts` |
| Past-due grace (`BILLING_PAST_DUE_GRACE_DAYS`, default 5) | Shipped | `src/lib/db/usage.ts` |
| Provisioning gated on an active plan (production fails closed) | Shipped | `src/lib/billing/gate.ts`, `src/lib/db/usage.ts` |
| Monthly caps: 500 texts, 300 call minutes (env defaults; per-business overrides) | Shipped | `src/lib/db/usage.ts`, `src/lib/messaging/index.ts` |
| Over-cap behaviour: texts `blocked_cap`, calls get an out-of-service line | Shipped | `src/lib/voice/capacity.ts`, `docs/compliance.md` |
| Grandfathering existing tenants | Shipped (operator script) | `scripts/grandfather-existing.ts`, `docs/billing.md` |
| Mock checkout for local development only (`DEMO_MODE=true`, no Stripe key, never in production) | Shipped | `src/app/api/billing/mock-activate/route.ts`, `src/lib/providers/stripe-billing.ts` |

### 5.3 Onboarding and knowledge base

| Feature | Status | Evidence |
| --- | --- | --- |
| Website to knowledge base (SSRF-guarded fetch, redirect re-validation) | Shipped | `src/app/api/extract/route.ts`, `src/lib/extraction/index.ts`, `src/lib/net/safe-fetch.ts` |
| Template fallback when no LLM key is set | Shipped | `src/lib/extraction/index.ts`, `src/lib/providers/llm.ts` |
| Knowledge base and prompt editor | Shipped | `src/components/dashboard/knowledge-editor.tsx`, `src/app/dashboard/knowledge/page.tsx` |
| Owner alert phone verification (SMS code, rate limited) | Shipped | `src/lib/messaging/owner-verify.ts`, `src/app/api/businesses/[id]/owner-phone/verify/*` |
| Carrier call-forwarding instructions (AT&T, T-Mobile, Verizon, GSM, landline, VoIP) | Shipped | `src/app/onboarding/forwarding.ts` |
| Test-call step (polls until the first call) | Shipped | `src/app/onboarding/step-test.tsx` |
| Minimum content checks (5 services, 3 FAQs) | Not built | v1.0 target; no check in `src/lib/extraction/index.ts` |

### 5.4 Phone and voice

| Feature | Status | Evidence |
| --- | --- | --- |
| AI phone number purchase through Twilio | **Partial.** Buys when Twilio is configured. On any failure it falls back to a fake `+1305555xxxx` mock number and still sets the business `live`. See section 9. | `src/lib/providers/twilio.ts` (`provisionNumberFallback`), `src/app/api/businesses/[id]/provision/route.ts` |
| Number bound to the ElevenLabs agent (inbound voice) | Shipped (operator: verify the binding) | `src/lib/voice/elevenlabs.ts` (`bindPhoneNumber`), `docs/runbook.md` |
| Conversation-initiation webhook: disclosure evidence and cap enforcement | Partial. Request shape verified against vendor docs; the API calls that configure it are unverified (`docs/runbook.md` section 6). | `src/app/api/voice/initiation/route.ts`, `docs/runbook.md` |
| Disclosure at call start, English and Spanish (owner text can extend, not replace) | Shipped | `src/lib/voice/elevenlabs.ts` (`firstMessageFor`), `src/lib/kb/disclosure.ts` |
| Declined recording: sticky `declined`, transcript withheld, provider conversation deleted (best effort) | Shipped | `src/lib/voice/postcall.ts`, `docs/compliance.md` |
| Post-call webhook with HMAC check; one row per call | Shipped | `src/app/api/voice/post-call/route.ts`, `src/app/api/voice/webhook/route.ts`, `src/lib/voice/postcall.ts` |
| Seven voice tools: `check_availability`, `create_booking`, `send_sms`, `create_payment_link`, `flag_emergency`, `get_pricing`, `handoff_to_human` | Shipped | `src/lib/voice/tools.ts`, `src/app/api/voice/tools/[tool]/route.ts` |
| Tool calls authenticated by a shared secret header | Shipped | `src/lib/voice/elevenlabs.ts` (`verifyToolSecret`) |
| Bilingual conversation (English and Spanish) | Partial. Driven by the prompt and the model. No language detection in code, and quality is not measured. | `src/lib/voice/elevenlabs.ts`, `src/lib/kb/index.ts` |
| Booking: local wall-clock time, hours, past times refused, slot conflicts, 2-bookings-per-call cap | Shipped | `src/lib/scheduler.ts`, `src/lib/availability.ts`, `src/lib/voice/tools.ts`, `tests/integration/` |
| Emergency: 911 first for gas, CO, fire, smoke, sparking; then `flag_emergency` | Shipped (prompt and tool). Not a substitute for a human; see risks. | `src/lib/voice/emergency.ts`, `src/lib/kb/index.ts` |
| Live human transfer | Not built. `handoff_to_human` texts the owner and flags a callback; it does not transfer the call. | `src/lib/voice/tools.ts` (`handoffToHuman`) |
| Owner voice reply or correction of the knowledge base by voice | Not built | none |
| Live transcript during a call | Not built. Transcripts arrive after the call. | `src/lib/voice/postcall.ts` |

### 5.5 Messaging and consent

| Feature | Status | Evidence |
| --- | --- | --- |
| Customer SMS (confirmation, payment link, replies) via Twilio, logged in `sms_log` | Shipped | `src/lib/messaging/index.ts`, `src/lib/messaging/templates.ts` |
| "Reply STOP to opt out" footer; 300 characters and 5 segments | Shipped | `src/lib/messaging/policy.ts` |
| STOP/START/HELP keywords, English and Spanish | Shipped. Twilio's own STOP handling can block a number before the webhook sees it. | `src/lib/messaging/keywords.ts`, `src/app/api/sms/inbound/route.ts`, `docs/compliance.md` |
| Owner alerts only to a verified owner phone; no alert otherwise, and the caller is told honestly | Shipped | `src/lib/voice/owner-alert.ts`, `src/lib/messaging/owner.ts` |
| Gratitude and review texts: consent-gated, 9pm-8am quiet hours, 4-5 star routes to review, 1-3 to owner | Shipped as a manual sweep (`POST /api/gratitude/run`). Not scheduled. | `src/lib/gratitude/index.ts`, `src/lib/gratitude/reply.ts`, `src/app/api/gratitude/run/route.ts` |
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
| Refund and dispute policy | Not built | none |

### 5.7 Dashboard and reporting

| Feature | Status | Evidence |
| --- | --- | --- |
| Today, Calls, Calendar, Brain, Briefings, Team, Billing, Security, Settings | Shipped | `src/components/dashboard/shell.tsx`, `src/app/dashboard/*` |
| Calls page: transcript, summary, status | Shipped | `src/app/dashboard/calls/page.tsx` |
| Call recording player | Not built. `recording_url` is stored when consent is `disclosed` (`src/lib/voice/postcall.ts`) but never shown. | `src/app/dashboard/calls/page.tsx` (no reference) |
| Calendar as a grid | Not built. `/dashboard/bookings` is titled "Calendar" and is a list grouped by business day. | `src/app/dashboard/bookings/page.tsx` |
| Daily briefing: content (calls, bookings, revenue, flags) | Shipped | `src/lib/briefing/index.ts`, `src/app/api/briefings/generate/route.ts` |
| Briefing audio (ElevenLabs TTS; text only without a TTS key) | Partial. Audio only with `ELEVENLABS_API_KEY`. Served by an authenticated route. | `src/lib/briefing/tts.ts`, `src/app/api/briefings/audio/[name]/route.ts` |
| 6 PM automatic briefing | Not built. Generation is on demand; no scheduler exists in the app. | `src/instrumentation.ts` (only the retention timer), `src/app/api/briefings/generate/route.ts` |
| Settings: alert phone, call disclosure text, retention window | Shipped. The v1.0 voice and hours settings are not built. | `src/components/dashboard/settings-form.tsx`, `src/app/api/businesses/[id]/settings/route.ts` |
| Settings: voice selection, edit of hours | Not built (not found in the settings UI) | `src/components/dashboard/settings-form.tsx` |

### 5.8 Privacy and retention

| Feature | Status | Evidence |
| --- | --- | --- |
| Export one customer's data (owner or admin) | Shipped (API) | `src/app/api/privacy/export/route.ts`, `src/lib/privacy.ts` |
| Erase one customer's data (calls, SMS log, briefings, bookings anonymised) | Shipped (API) | `src/app/api/privacy/erase/route.ts` |
| Retention purge: per-business `retention_days`, daily | Shipped. **Off by default** (`RETENTION_JOB` must be set). | `src/lib/retention-job.ts`, `src/instrumentation.ts`, `src/app/api/admin/retention/route.ts` |
| Opt-outs are never purged | Shipped | `docs/compliance.md` |
| Privacy policy, terms, DPAs | Not in app. Operator task. | `docs/runbook.md` section 5 |

### 5.9 Operations

| Feature | Status | Evidence |
| --- | --- | --- |
| Docker Compose production stack behind Traefik; Postgres 17 pinned by digest | Shipped | `compose.production.yaml`, `Dockerfile`, `deploy.sh` |
| Health endpoint | Shipped | `src/app/api/health/route.ts` |
| Post-deploy checks (signatures, auth, public pages) | Shipped | `scripts/verify-deploy.ts`, `docs/runbook.md` section 3 |
| Audit log of security and billing events | Shipped | `src/lib/db/audit.ts`, `docs/auth.md`, `docs/billing.md` |
| CI: install, typecheck, lint, build, migrate, `bun test` | Shipped | `.github/workflows/ci.yml` |
| Test suite (around 230 `test()` calls under `tests/`, plus `tests/db` and `tests/integration`) | Shipped. Not re-run for this document. | `tests/`, `docs/testing.md` |

## 6. Non-goals

- Multi-location or franchise accounts. One business per owner account.
- Outbound marketing or outbound calls.
- Dispatching subcontractors or sending technicians.
- Live human transfer or a staffed answering service.
- Google Calendar or other external calendar sync. The internal calendar is the source of truth.
- Card data over the phone or inside the app. Deposits use Stripe-hosted payment links.
- Legal advice, HIPAA, PCI scope, data residency.
- Native mobile app. The dashboard is responsive web.

## 7. Architecture

```
caller ──PSTN──> ElevenLabs agent (bound to Twilio number)
                    │  tool calls (shared-secret header)      ▲ post-call webhook (HMAC)
                    ▼                                          │
owner/staff ──> Next.js 16 app (route handlers + server components)
                    │  proxy.ts: cheap cookie/shape gate; real checks in lib/session.ts
                    ├── Postgres 17 via Prisma (all state, audit, rate-limit buckets, leases)
                    ├── Twilio: number purchase, outbound SMS, inbound SMS webhook
                    ├── ElevenLabs: agents, voice (TTS for briefings), post-call and initiation webhooks
                    ├── Stripe: subscriptions and billing webhook; deposit Payment Links and webhook
                    ├── LLM (OpenAI or Anthropic, whichever key is set): knowledge-base generation
                    └── Email (Resend or SMTP): verification, invites, billing notices
```

Key design points, all in the code:

- **Tenancy.** Every business-scoped handler resolves the business from the principal, not from the request.
- **Webhooks** verify signatures and fail closed in production. Stripe, Twilio and ElevenLabs each have a check.
- **Idempotency.** Processed-event records and DB leases guard webhooks, provisioning and the retention job.
- **Consent evidence.** The app records the disclosure only from server-side evidence, never from what the caller says.
- **Metering.** Usage counters are per business per calendar month, in the business's time zone.
- **Deployment.** Single image set (app, tools for migrate and seed). Migrations run before the app starts.

## 8. Tech stack

| Layer | Choice (verified in `package.json`, `Dockerfile`, `compose.production.yaml`) |
| --- | --- |
| Web framework | Next.js 16.4.6 (App Router), React 19.3.0, Tailwind CSS 4.3.3 |
| Runtime and package manager | Bun 1.4.1 (Docker image `oven/bun`); Node runtime for route handlers |
| Database | PostgreSQL 17 (`postgres:17-alpine`, pinned by digest), Prisma 6.16.2 |
| Voice | ElevenLabs Agents (conversational agent, phone binding), ElevenLabs TTS for briefing audio |
| Telephony and SMS | Twilio (number purchase, SMS, inbound SMS webhook) |
| Payments | Stripe (Billing subscriptions with Checkout and Portal; Payment Links for deposits) |
| LLM | OpenAI (`LLM_MODEL`) or Anthropic (`ANTHROPIC_MODEL`), whichever key is set |
| Email | Resend REST API or SMTP via nodemailer (`EMAIL_PROVIDER`) |
| Bot protection | Cloudflare Turnstile (optional, signup) |
| Other libraries | `libphonenumber-js` (E.164), `cheerio` (page extraction), `qrcode` (2FA setup), `date-fns`, `sonner` |
| Deployment | Docker Compose behind Traefik (`compose.production.yaml`), `deploy.sh` |
| Not used | Supabase. The `SUPABASE_*` variables in v1.0 are not read anywhere in the code. |

## 9. Risks and mitigations

| Risk | Likelihood / impact | Current mitigation | Gap or action |
| --- | --- | --- | --- |
| **Recording consent (Florida all-party consent, Fla. Stat. 934.03; other states differ)** | High / High | Disclosure at call start in English and Spanish; declined calls keep metadata only; provider conversation deleted on decline (best effort) | Counsel must review wording and consent bases per state. Provider-side audio retention must be set by the operator. |
| **TCPA, 10DLC and texting consent** | Medium / High | STOP/HELP handling; gratitude texts need recorded consent; quiet hours; per-business rate limits | 10DLC registration is not in the app. Counsel review of the consent basis. Twilio may block a number before the webhook sees a STOP. |
| **Personal data (caller phone, names, addresses, transcripts, recordings)** | Medium / High | Export and erase endpoints; E.164 matching; audit trail; opt-outs never purged | Retention purge is **off by default**. Turn on only after each business's window is reviewed. No DPA or privacy policy in the repo. |
| **Life safety (gas, CO, fire) during a call** | Low / Severe | 911-first instruction in every production prompt; `flag_emergency` speaks the 911 advice | The agent is not an emergency service. Human-transfer gap (section 5.4) means emergencies depend on owner response. Alerts only reach a verified phone. |
| **Cost abuse (signup spam, SMS pumping, call-minute drain)** | Medium / High | Plan gate; per-business monthly caps (texts and minutes); signup cap and per-IP limits; alert-phone verification; owner-alert rate limits | Caps count messages, not SMS segments, so a long text can cost more than one unit. The number-purchase fallback (below) can create unpaid numbers. |
| **Number purchase fallback creates a fake live line** | Medium / High | Production billing gate before provisioning | **Known bug:** a failed Twilio purchase assigns a fake `+1305555xxxx` number and sets the business `live` (`src/app/api/businesses/[id]/provision/route.ts`, `src/lib/providers/twilio.ts`). Fix: refuse `live` when the number is mock. |
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
| Cap hits | Businesses that hit the text or minute cap in a month | Pricing and cap tuning |
| Cost per call and per business-month | Provider spend per answered call and per active business | Unit economics (see `docs/product/monetization.md`) |
| Churn | Cancellations within 60 days of paid start | Retention |

## 11. Open roadmap (not built, verified against the code)

Ordered by what most blocks a paying launch:

1. **Fix the mock-number fallback**: never set `live` for a mock number in production.
2. **Automatic briefing at a set time** (the v1.0 6 PM briefing). Needs a scheduler. None exists today.
3. **Scheduled gratitude sweep.** `POST /api/gratitude/run` exists but nothing calls it.
4. **Live human transfer** for emergencies and requested humans, instead of a callback flag.
5. **Count SMS segments** in the cap, not only messages.
6. **Recording player** on the call page (the URL is stored but not shown).
7. **Calendar grid** view (the page is a list).
8. **Owner voice correction** of the knowledge base, and an owner voice reply to the briefing (stretch from v1.0).
9. **Live transcript** during calls (stretch from v1.0).
10. **Refund and dispute policy** and deposit support text.
11. **Minimum content checks** on extraction (5 services, 3 FAQs) before go-live.
12. **Operator-independent compliance:** 10DLC registration support and a per-state disclosure setting.

Not planned: Google Calendar sync, multi-location, outbound calls.

## 12. Changes from v1.0

| v1.0 claim | Now |
| --- | --- |
| Supabase schema and client | Removed. Postgres 17 with Prisma. |
| Next.js 14 | Next.js 16.4.6. |
| "30-50% of calls lost" and "Miami market is underserved" | Removed. No source. |
| Demo number `+1-305-555-0199` | Removed. Demo numbers are mock numbers. |
| Owner dashboard with settings for voice and hours | Partial. Alert phone, disclosure, retention. |
| 6 PM auto-briefing | Not built. |
| Live human transfer | Not built. Callback flag only. |
| Spanglish detection | Partial. Prompt-driven, no detection code. |
| Stripe test mode only | Operator setting. No code check that the keys are test-mode keys. |
| Recording and consent disclosure: absent in v1.0 | Shipped (section 5.4). |
| Stretch: gratitude, KB voice correction, live transcript | Gratitude sweep shipped but manual. Others not built. |
