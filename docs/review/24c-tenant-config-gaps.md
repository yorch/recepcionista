# 24c. Per-tenant and platform-default config coverage (read-only assessment)

Scope: every business setting in the schema, who can edit it (tenant dashboard, admin), and every platform policy that is only a code constant or an env variable but would naturally be per-tenant or admin-adjustable. All claims verified by reading code (file:line). No repo files were edited; this report is the only file written.

Legend: **UI** = a dashboard control exists. **API** = a route exists but no UI control. **Admin** = the platform admin can edit it for a tenant. Admin rank is 3 (`src/lib/session.ts:45`) and passes every `authenticate(req,{role:'owner'})` route via `requireBusinessAccess`, so an admin can call any owner API for any tenant (and in the UI by picking the tenant in the switcher, `shell.tsx:217`, `dashboard-context.ts:47-57`). That is "support edit via the owner screens", not a purpose-built admin surface. Where only the admin can edit a field, it is API-only today (`/api/admin/billing`).

## 0. Headline

1. **Tenant side is well covered for owner-facing business settings** (16 of ~30 Business columns have a dashboard control). The gaps are: `closed_dates` (no UI/API write at all), `hours`/`service_area`/`name`/`url`/`owner_name` (edit UI is the Knowledge page, not Settings; fine), and all **admin-only** columns (billing state, caps, plan, status, provider ids), which have **no UI** and a single JSON endpoint.
2. **There is no settings/policy table.** `prisma/schema.prisma` has 28 models (lines 14-908) and none is a platform-config model, so every platform default below is an env var (~75 distinct names) or a code constant (~250 `export const X = <number>` under `src/lib`).
3. **Plans do not exist as data.** There is one implicit plan: `plan` is a free string (`schema.prisma:47`; `admin/billing/route.ts:51` accepts any <=60 char string), the Stripe plan label comes from `BILLING_PLAN_NAME` (`providers/stripe-billing.ts:68`, default `standard`), caps come from a single set of env values (`db/usage.ts:61-78`), and the only plan-aware code is the comp-plan list `COMP_PLANS = ['legacy','grandfathered']` (`billing/release.ts:34`). No feature is gated by plan; "feature availability per plan" is impossible without new schema.
4. **Highest-value moves** (details in section 5): (a) a `platform_settings` key/value table with a typed registry and an admin UI; (b) a `plans` table (key, name, stripe price ids, caps, trial days, feature flags); (c) a tenant detail admin page that edits billing/caps/status/limits; (d) an editor for `closed_dates` for the tenant; (e) move quiet hours, briefing hour and the deposit/scheduling platform maxima to settings.

Correction to `24b-admin-surface-today.md` section 7/10 item 9: `business.status='paused'` **is** set, by tenant release (`src/lib/db/index.ts:594`, "data.status = 'paused'" when the phone is cleared). What is true is that no admin route sets it as a suspend action.

## 1. Business columns (`prisma/schema.prisma:14-144`) versus dashboard and admin

| Column (schema line) | Tenant dashboard | Evidence | Admin can edit for tenant | Verdict |
|---|---|---|---|---|
| `name` (16) | UI (Knowledge page business card) | `PATCHABLE.name` `api/businesses/[id]/route.ts:26` | yes via same API | ok |
| `url` (17) | UI | `route.ts:27` | yes | ok |
| `phone` (18, unique) | read only; set by provisioning (`provision/route.ts:~320`) / cleared by release | no PATCH field | only via provision (`force`) or release | **gap**: no admin "assign/replace number" without provisioning; repair-numbers is API only |
| `phone_key`, `phone_e164`, `owner_phone_e164` (21,42,43) | derived | db layer | n/a | derived, fine |
| `timezone` (26) | UI | `TimezoneSettings` (`settings/page.tsx:127`), route `timezone/route.ts` | yes | ok |
| `owner_phone` (27) | UI + SMS verify (`set.alert`, onboarding verify) | `PATCHABLE.owner_phone` `route.ts:29`, `owner-phone/verify` | yes, but admin verification path differs (`verify-limits.ts` `isAdmin` skips "verified elsewhere") | ok |
| `owner_name` (28) | UI (Knowledge) | `route.ts:28` | yes | ok |
| `hours` (29) | UI (Knowledge form `knowledge-form.tsx:96-102`) | `PATCHABLE.hours` `route.ts:32` | yes | ok |
| `service_area` (30) | UI (Knowledge) | `route.ts:30` | yes | ok |
| `status` (31) | none | no setter except release (`db/index.ts:594`) and provision | **no** | **gap**: no suspend/reactivate; `paused` is a side effect of release only |
| `agent_id` (35) | none (stripped from API output `route.ts:13`) | provision | provision `force` only | gap: admin cannot see/bind agent id; only resync-agents (API) |
| `retention_days` (37, default 365) | UI (`SettingsForm`, `settings/page.tsx:150-159`) 1..3650 | `settings/route.ts:60` | yes | ok. Platform min/max/default (1..3650, 365) are code (see 3.8) |
| `recording_disclosure_text` (39) | UI | `settings/route.ts:63-69`, `kb/disclosure.ts:9` | yes | ok; but the mandatory-notice rule (`hasMandatoryNotice`, `disclosure.ts:30`) and default text are code, not admin-editable, and not jurisdiction-aware |
| `billing_status` (46), `plan` (47), `trial_ends_at` (50), `current_period_end` (51), `cancel_at_period_end` (52), `past_due_since` (54) | read only on Billing page (`billing/page.tsx`) | `billingSummary` | admin: `POST /api/admin/billing` (`billing/route.ts:33`) sets status, plan, trial_ends_at, current_period_end; **cancel_at_period_end and past_due_since not settable** | **gap: no UI**; list/filter of comped, trial-ending, past_due tenants missing |
| `stripe_customer_id` (48), `stripe_subscription_id` (49) | none | n/a | none (admin route "does not touch Stripe ids", `billing/route.ts:27-31`) | gap: cannot re-link a customer or fix an orphan |
| `sms_cap_override` (56), `call_minutes_cap_override` (57) | read only (usage bars) | `summary.ts` | admin API only | **gap: no UI**; no override for voicemail / forward caps at all (only env, see 3.1) |
| `owner_phone_verified_at` (59) | set by verify flow | | none (cannot clear/force) | gap (support) |
| `call_mode` (62) | UI (`CallHandlingSettings`, `settings/page.tsx:79-87`), step-up | `call-mode/route.ts:35` | yes | ok |
| `forward_number` (65), `forward_number_verified_at` (68) | UI + SMS verify | `forward-number/route.ts:55` | yes | ok |
| `forward_during_hours` (70) | UI | `call-mode/route.ts:42` | yes | ok |
| `locale_default` (73) | UI (`LanguageSettings`) | `settings/route.ts:70` | yes | ok; locales fixed to en/es (3.9) |
| `vertical` (75) | UI (`VerticalSettings`) step-up when live | `route.ts:25,115-125` | yes | ok; vertical list is code (3.9) |
| `voice_id`, `voice_name` (77-78) | UI (`VoiceSettingsCard`) | `voice/route.ts` | yes | ok; allowed voices = env `ELEVENLABS_VOICE_ALLOWLIST` (`voice/voices.ts:43`) |
| `refund_policy`, `refund_policy_text` (80-81) | UI | `refund-policy/route.ts:33` | yes | ok; notice windows are code (`refunds.ts:15`) |
| `billing_interval` (83) | read only; changed via Stripe portal/checkout | `billing/page.tsx:121-123` | via webhook only | acceptable |
| `closed_dates` (85) | **read-only list** on Knowledge page (`knowledge/page.tsx:113-116`) | not in `PATCHABLE` (`route.ts:23-41`), not in knowledge PUT (`knowledge/route.ts:32-36`); only the owner voice/SMS channel (`voice/owner/ops.ts:202-220`) and `kb-patch.ts:11` write it | **no UI or API write for owner or admin** | **GAP (real)**: holidays can only be set by calling/texting the owner line. Schema CHECK allows 366 dates |
| `elevenlabs_phone_number_id`, `twilio_phone_sid` (90-91) | none | stored by provisioning only | none (repair-numbers reads them, `repair-numbers/route.ts:94,99,133`) | gap: no admin view or manual bind |
| `review_url` (93) | UI | `review-url/route.ts:27` | yes | ok |
| `assistant_name` (95) | UI (`LineSettingsCard`) | `line/route.ts:65` | yes | ok; platform default `Maria` is code (`voice/assistant-name.ts:7`) |
| `deposit_enabled/mode/fixed/percent/min/max` (97-103) | UI (`DepositPolicySettings`) | `deposit-policy/route.ts:42` | yes | ok; platform min/max in code (3.4) |
| `slot_minutes`, `min_lead_minutes`, `horizon_days`, `buffer_minutes`, `crews` (106-110) | UI (`SchedulingSettings`) | `scheduling/route.ts:32` | yes | ok; platform maxima in code (3.4) |
| `content_confirmed_at/hash` (113-114) | UI go-live confirm | `content-confirmation/route.ts:34` | yes (owner route) | ok |
| `native_transfer_enabled` (116) | UI, step-up | `line/route.ts:59-65` | yes, but gated by env capability `NATIVE_TRANSFER` (`voice/transfer.ts:30`, `line.ts:86`) | platform capability is env |

Other config-bearing models:

| Model | Config | Tenant UI | Admin | Verdict |
|---|---|---|---|---|
| `KnowledgeBase` (146) services, faqs, pricing_notes, call_script, system_prompt | Knowledge page | `knowledge/route.ts` (system_prompt is rebuilt, owner cannot edit raw) | yes via owner API | ok. Limits: PUT truncates to **20 services / 15 FAQs** (`knowledge/route.ts:32-33`) while `KB_LIMITS` allows **200 / 200** (`kb-patch.ts:18`): two different hidden platform limits |
| `User.locale` (466 area, line 24 of the model) | Language card | | | ok |
| `CalendarConnection.blockOnBusy` (693) | Google Calendar card | | | ok. Whether Google is offered at all = env `GOOGLE_CLIENT_ID/SECRET` |
| `Briefing`/gratitude/review request | **no per-tenant on/off or time**: briefing at fixed 18:00 local (`jobs/schedule.ts:10`), gratitude/review follow-ups are always on for every tenant (no column in `businesses`) | none | none | **gap** (opt-out of marketing-type texts is only per customer via STOP) |
| `UsageCounter` (585) | state, not config | | | |
| `TrialFingerprint` (655) | anti-abuse state | | no view/clear | gap (support cannot release a fingerprint for a legit re-signup) |

Missing columns that are naturally per tenant (do not exist anywhere): per-tenant quiet hours (global 21-8, `messaging/policy.ts:26-27`), per-tenant briefing on/off and hour, per-tenant gratitude/review-request toggle and delay (`gratitude/index.ts:16-17` fixed 20-48 h window), per-tenant SMS opt-in footer text, per-tenant booking default duration (`availability.ts:11` 60 min), per-tenant holiday calendars by country, tenant "admin notes / support tags", tenant-level feature overrides, tenant-level rate-limit/budget overrides (forward/voicemail per hour), per-tenant max recording length.

## 2. Admin ability to edit a tenant (support)

- Works only by impersonation through the switcher with full owner rights, unaudited reads (see 24b section 3/4). Fields that **only** an admin should change and that have **no UI**: billing status/plan/trial/period end, SMS and AI-minute caps, tenant status (suspend), provider ids, Stripe ids, cancel_at_period_end, owner phone verification, trial fingerprint.
- Fields no one can change by any path (UI or API): `closed_dates` (except voice/SMS owner line), `status`, `stripe_*`, `agent_id`, `elevenlabs_phone_number_id`, `twilio_phone_sid`, `phone` (outside provisioning), `owner_phone_verified_at`.
- `admin/billing` audit omits cap and date values (`billing/route.ts:71-81`), see 24b.

## 3. Platform policy: env-only or code-only (candidates for an admin-tunable setting)

Notation: **Env** = read from `process.env`; **Const** = hard-coded. "Admin?" = recommendation: **Yes** (admin-tunable in a settings UI), **Keep env** (bootstrap/secret/infra), **Const ok** (safety invariant, leave in code).

### 3.1 Plan, trial and usage caps (should be `plans` + settings)

| Knob | Where | Current | Admin? |
|---|---|---|---|
| Trial length days | `BILLING_TRIAL_DAYS` env, `providers/stripe-billing.ts:61-65`, default `DEFAULT_TRIAL_DAYS = 7` (`:15`), 0..90 | 7 | **Yes** (per plan) |
| Plan name label | `BILLING_PLAN_NAME`, `stripe-billing.ts:68` | `standard` | **Yes** (plan table) |
| Stripe price ids monthly / annual | `STRIPE_PRICE_ID` (`stripe-billing.ts:52,145`, `billing/price.ts:99`, `billing/status.ts:49`), `STRIPE_PRICE_ID_ANNUAL` (`status.ts:47`, `stripe-billing.ts:20`) | env | **Yes** (price ids are not secrets; per plan) |
| Marketing price display text (EN/ES, monthly/annual) | `NEXT_PUBLIC_PLAN_PRICE_DISPLAY[_ANNUAL][_ES]`, `app/site-config.ts:17,22` (NEXT_PUBLIC = inlined at **build** time) | env | **Yes** (and stop baking at build) |
| Promo codes allowed | `BILLING_ALLOW_PROMO_CODES`, `stripe-billing.ts:164` | env | Yes |
| Billing enforced | `BILLING_ENFORCED`, `db/usage.ts:46` (fail closed in prod) | env | Keep env or Yes with confirm (kill switch for launch) |
| Past-due grace days | `BILLING_PAST_DUE_GRACE_DAYS`, `db/usage.ts:51`, default 5 (`:28`) | 5 | **Yes** |
| SMS segments cap per month | `PLAN_SMS_CAP`, `db/usage.ts:61`, default 500 (`:24`) | 500 | **Yes** (per plan) |
| AI call minutes cap per month | `PLAN_CALL_MINUTES_CAP`, `db/usage.ts:68`, default 300 (`:25`) | 300 | **Yes** (per plan) |
| Trial SMS / AI caps | `TRIAL_SMS_CAP` (`:62`, 50), `TRIAL_CALL_MINUTES_CAP` (`:69`, 30) | 50 / 30 | **Yes** |
| Voicemail minutes cap | `VOICEMAIL_MINUTES_CAP`, `db/usage.ts:73`, default 60 | 60 | **Yes**; no per-tenant override column exists |
| Forward minutes cap, trial forward cap | `FORWARD_MINUTES_CAP` (`:77`, 600), `TRIAL_FORWARD_MINUTES_CAP` (`:78`, 30) | 600 / 30 | **Yes**; no per-tenant override column |
| Warning thresholds | `WARN_LEVELS = [80,100]`, `billing/warnings.ts:31` | 80/100 | Const ok / Yes (cheap) |
| Trial banner days | `TRIAL_BANNER_DAYS = 3`, `billing/banner-state.ts:29` | 3 | Yes (low) |
| Release grace / notice days | `DEFAULT_GRACE_DAYS = 30`, `DEFAULT_NOTIFY_DAYS = 7`, `billing/release.ts:26-27`; `RECENT_CALL_DAYS 7`, `RECENT_CALL_MIN_SECONDS 15` (`:28,30`); stuck `5` / `7 d` (`:314,316`) | consts | **Yes** (data-retention policy after cancellation) |
| Comp plan names | `COMP_PLANS = ['legacy','grandfathered']`, `release.ts:34` | const | Yes (derive from plans table `is_comped`) |
| Release job mode and caps | `TENANT_RELEASE_JOB` env (`jobs/tenants.ts:26`), `MAX_RELEASES_PER_RUN = 10` (`:31`), `MAX_RELEASE_ERRORS_PER_RUN = 3` (`:33`), `GRANDFATHER_BEFORE` (`:122`) | | **Yes** (job switches, section 3.6) |
| Max businesses per user | `MAX_BUSINESSES_PER_USER`, `db/locations.ts:15`, default 10 (`:11`), 1..100 | 10 | **Yes** (per plan) |
| Features per plan | none exist | | **needs schema** |

### 3.2 Messaging / SMS policy

| Knob | Where | Current | Admin? |
|---|---|---|---|
| SMS allowed country codes | `SMS_ALLOWED_COUNTRY_CODES`, `messaging/recipient.ts:8` (default "1"); also drives owner-phone validation (`api/businesses/[id]/route.ts:70`) and forward numbers (`voice/forward-number.ts:62-63`) | `1` | **Yes** ("supported countries") |
| Forward allowed countries | `FORWARD_ALLOWED_COUNTRY_CODES`, `forward-number.ts:62` | falls back to SMS list | **Yes** |
| Forward deny area codes | const list `DEFAULT_DENY_AREA_CODES` `forward-number.ts:~24-31` + env `FORWARD_DENY_AREA_CODES` (`:33`) | ~35 codes | **Yes** (list editor; fraud policy) |
| Non-geographic NANP sets | `NANP_NON_GEOGRAPHIC` (`forward-number.ts:49`), `NON_GEOGRAPHIC_AREA_CODES` (`phone.ts:56`), blocked prefixes (`forward-number.ts:~54`) | consts | Const ok |
| Default phone country | `DEFAULT_PHONE_COUNTRY`, `phone.ts:12` | US | **Yes** (per tenant would be better: add `businesses.country`) |
| Default area code for new numbers | `TWILIO_AREA_CODE` env (`phone.ts:81`), `DEFAULT_AREA_CODE = '305'` (`phone.ts:53`) | 305 | **Yes** (area codes list / default, per vertical or tenant) |
| Quiet hours | `QUIET_START_HOUR 21`, `QUIET_END_HOUR 8`, `messaging/policy.ts:26-27` (used in policy, inbox, booking-changes, jobs schedule) | 21:00-08:00 local | **Yes**, platform default plus a **per-tenant** override (legal differs by state) |
| Marketing consent bases | `MARKETING_CONSENT_BASES`, `policy.ts:24` | 3 values | Const ok (compliance) |
| STOP footer text | `STOP_FOOTER = 'Reply STOP to opt out'`, `policy.ts:22` (English only) | const | Yes (text per locale) |
| SMS length limits | `SMS_LIMIT 300` (`templates.ts:20`), `MANUAL_TEXT_MAX 320` (`manual-limits.ts:2`), `OWNER_ALERT_MAX_CHARS 320` (`owner-alert.ts:31`), `INBOUND_BODY_MAX 1600` (`business-config.ts:28`) | consts | Const ok |
| Manual-send limits | `MANUAL_BUSINESS_HOURLY_LIMIT 40`, `MANUAL_RECIPIENT_HOURLY_LIMIT 6` (`messaging/manual.ts:27-28`) | 40 / 6 | **Yes** |
| Inbox auto-reply budgets | `INBOX_SENDER_HOURLY_LIMIT 10`, `INBOX_BUSINESS_HOURLY_LIMIT 300` (`messaging/inbox.ts:37-38`), `INBOX_FORWARD_HOURLY_LIMIT` env default 10 (`:39,45`), `INBOX_SENDER_FORWARD_HOURLY_LIMIT 2` (`:41`) | | **Yes** (anti-pumping budgets) |
| Owner-alert hourly limit | `OWNER_ALERT_HOURLY_LIMIT`, `voice/owner-alert.ts:39`, default 6 (`:32`) | 6 | **Yes** |
| Missed-call alerts per hour | `MISSED_CALL_ALERTS_PER_HOUR = 6`, `voice/capacity.ts:37` (burst 1 per 10 min inline `:48`) | 6 | Yes |
| Owner phone verification budgets | `FREE_VERIFY_TEXTS 3`, `VERIFIED_ELSEWHERE_DAYS 30` (`messaging/verify-limits.ts:21-22`); inline 5 per number/day, 15 per business/day (`:75-76`); `OWNER_VERIFY_GLOBAL_PER_DAY` default 2000 (`:77`), `_PER_HOUR` (`:58`); code TTL 10 min, 6 digits (`owner-verify.ts:16-17`) | | **Yes** for global budgets (SMS spend control), const for the rest |
| Change-notice SMS per hour | `CHANGE_NOTICES_PER_HOUR = 6`, `voice/call-handling-changes.ts:25` | 6 | Yes (low) |
| Sender / messaging service | `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_MESSAGING_SERVICE_PIN_SENDER` (`providers/twilio.ts:93,98`), `messaging/sender-config.ts:7,19`; `SHARED_SENDER_REPLY_DAYS 30`, `UNRESOLVED_SENDER_DAYS 3` (`messaging/sender.ts:32,34`) | | Yes (Twilio config block) |
| Allow unverified booking SMS | `ALLOW_UNVERIFIED_BOOKING_SMS`, `voice/tools.ts:238` | false | **Yes** (policy toggle) |

### 3.3 Voice / call policy and voicemail

| Knob | Where | Current | Admin? |
|---|---|---|---|
| Line kind (native vs webhook) | `VOICE_LINE_KIND` (`voice/line.ts:26,58,71`), `ELEVENLABS_TENANT_LINES` (`line.ts:42`), `ELEVENLABS_PHONE_NUMBER_ID` shared fallback (`line.ts:64`, `db/business-line.ts:64`), `ELEVENLABS_REGISTER_CALL` (`api/voice/incoming/route.ts:308`) | env | **Yes** (a "voice line" panel; the id is not a secret) |
| Native transfer capability | `NATIVE_TRANSFER`, `voice/transfer.ts:30` | env | Yes |
| Forward ring seconds | `FORWARD_RING_SECONDS` env 10-40, `voice/twiml.ts:20-24` default 20 | 20 | Yes (per tenant ideally) |
| Voicemail max length | `VOICEMAIL_MAX_SECONDS = 90`, `twiml.ts:27` | 90 | **Yes** |
| Forward max call, concurrency, min answered | `FORWARD_MAX_CALL_SECONDS` 3600, `FORWARD_MAX_CONCURRENT` 3, `FORWARD_MIN_ANSWERED_SECONDS` 6 (`forward-metering.ts:34,40,45`); `FORWARD_MIN_REMAINING_SECONDS 30` (`:47`); lease grace 180 s (`db/forward-leases.ts:13`) | | **Yes** (first three) |
| Call budgets per hour | `FORWARD_CALLS_PER_HOUR` 60, `VOICEMAIL_PER_HOUR` 60 (`caller-limits.ts:135`), per caller 3 / 2 (`:50`), withheld 5 / 3 (`:52`), unknown share 75% (`:53`, `:39`), pressure 80% (`:41`), known-customer window `KNOWN_CUSTOMER_DAYS 90` (`:37`) | | **Yes** (anti-toll-fraud budgets; per tenant override column would help) |
| STIR trust | `STIR_TRUST`, `caller-limits.ts:66` | on | Yes |
| Withheld caller id list | `WITHHELD` set, `caller-limits.ts:56` | const | Const ok |
| Out-of-service call length | `OUT_OF_SERVICE_MAX_SECONDS = 60`, `capacity.ts:35` | 60 | Yes (low) |
| Paused prompt override, initiation webhook | `ELEVENLABS_PAUSED_PROMPT_OVERRIDE` (`capacity.ts:110`, `initiation-config.ts:15`), `ELEVENLABS_INITIATION_WEBHOOK` (`initiation-config.ts:7`) | env | Yes |
| Language detection | `LANGUAGE_DETECTION`, `voice/elevenlabs.ts:383` | env | Yes ("languages") |
| Default voice | `ELEVENLABS_VOICE_ID` env (`elevenlabs.ts:468`), `DEFAULT_VOICE_ID` const (`:28`); voice allowlist `ELEVENLABS_VOICE_ALLOWLIST` (`voices.ts:43`), `MAX_VOICES 30` (`:17`) | | **Yes** (platform default voice + curated list editor) |
| Default assistant name | `DEFAULT_ASSISTANT_NAME = 'Maria'`, `voice/assistant-name.ts:7` | const | Yes |
| Max bookings/moves per call | `MAX_BOOKINGS_PER_CALL 2` (`voice/tools.ts:272`), `MAX_VOICE_MOVES 3` (`tools-bookings.ts:186`), `MAX_PRICE_CENTS` $100k (`tools.ts:366`, `booking-manual.ts:21`) | | Const ok (abuse brakes) / Yes (low) |
| Emergency text 911 | `CALL_911_EN/ES`, `voice/emergency.ts:5-6` | const | Const ok (safety), but copy is jurisdictional (US only) |
| Live listening limits | `LIVE_MAX_PER_BUSINESS`, `LIVE_MAX_PER_USER` (`live-stream.ts:124`), `LIVE_MAX_POLLS_PER_CALL` (`live-transcript.ts:33`, default 600) | env | Yes (low) |
| Recording cache / download | `MAX_BYTES 40 MB`, `CACHE_MAX_BYTES 64 MB`, `MAX_CONCURRENT_DOWNLOADS 4` (`recording-audio.ts:20-24`) | | Const ok |
| Reconcile | `RECONCILE_AFTER_MINUTES` 20, `RECONCILE_MAX_ATTEMPTS` 5 (`voice/reconcile.ts:22-23`) | | Yes (ops) |

### 3.4 Business-config platform limits (the maxima every tenant is clamped by)

| Knob | Where | Current | Admin? |
|---|---|---|---|
| Deposit platform min / max | `DEPOSIT_MIN_CENTS 100`, `DEPOSIT_MAX_CENTS 100_000`, `business-config.ts:21-22` (also DB CHECKs, migration 20261208120000) | $1 .. $1,000 | **Yes** (needs CHECK removal/relaxation), `AI_DEPOSIT_CAP_CENTS 50_000` (`payments/deposit.ts:13`) | 
| Slot choices | `SLOT_MINUTES_CHOICES [15,30,60]` (`business-config.ts:24`); `availability.ts` `SLOT_STEP_MIN 60`, `DEFAULT_DURATION_MIN 60`, `MIN 15`, `MAX 720` (`:11-14`) | | Const ok |
| Scheduling maxima | `MIN_LEAD_MAX 10080`, `HORIZON_DAYS_MAX 180`, `BUFFER_MAX 240` (`business-config.ts:25-27`), `MAX_CREWS 20` (`crews.ts:6`) | | Yes (low) |
| Scheduling defaults for new tenants | `DEFAULT_SCHEDULING` (`business-config.ts:162`): slot 60, lead 60, horizon 14, buffer 0, crews 1 (mirrored by schema defaults `schema.prisma:106-110`) | | **Yes** (new-tenant defaults per vertical) |
| Other new-tenant defaults | `retention_days` 365 (`schema.prisma:37`), `refund_policy` `full_24h` (`:80`), `timezone` `America/New_York` (`:26`), `vertical` `hvac` (`:75`), `call_mode` `ai`, `locale_default` `en`, `billing_interval` `month` | schema defaults | **Yes** (a "new tenant defaults" settings group; schema defaults cannot be changed without migration) |
| Retention bounds | 1..3650 (`api/businesses/[id]/settings/route.ts:60`), default 365 | | Yes (min/max/default; legal minimum per jurisdiction) |
| Retention job | `RETENTION_JOB` env (`retention-job.ts:26`, `jobs/index.ts:472,577,605`) | off until set | **Yes** (toggle with confirm) |
| Briefing audio keep days | `BRIEFING_AUDIO_KEEP_DAYS`, `db/briefing-audio.ts:97` | env | Yes |
| Briefing audio limits | `BRIEFING_AUDIO_MAX_BYTES 5 MB`, `BRIEFING_AUDIO_TYPES` (`business-config.ts:29-30`), `MIN_WORDS 90`, `MAX_WORDS 160` (`briefing/index.ts:22-23`), `MAX_TEXT_CHARS 2500` (`briefing/tts.ts:17`) | | Const ok |
| Briefing hour | `BRIEFING_HOUR = 18`, `jobs/schedule.ts:10` | 18:00 local | **Yes**, platform default plus per-tenant column |
| Gratitude timing | `MIN_AGE_MS 20 h`, `MAX_AGE_MS 48 h`, `gratitude/index.ts:16-17`; `MAX_GRATITUDE_PER_TICK 25`, `MAX_BRIEFINGS_PER_TICK 10` (`jobs/index.ts:60-61`) | | Yes (delay), const for per-tick |
| Review link max | `REVIEW_URL_MAX 120` (`business-config.ts:18`), `ASSISTANT_NAME_MAX 40` | | Const ok |
| Refund notice windows | `POLICY_NOTICE_HOURS` `{none:Infinity, full_24h:24, full_48h:48, full_always:0}`, `refunds.ts:15` (also the policy list in the schema CHECK) | | **Yes** (custom windows) |
| Refund reconcile | `REFUND_RECONCILE_AFTER_HOURS` env (`refund-service.ts:149`), `REFUND_CHECK_MIN_AGE_MS 30 min` (`:146`) | | Yes (ops) |
| KB limits | `KB_LIMITS {services 200, faqs 200, text 20000, ...}` (`kb-patch.ts:18`) vs inline 20 / 15 (`api/businesses/[id]/knowledge/route.ts:32-33`) | **inconsistent** | Yes (one source of truth, per plan) |
| KB readiness thresholds | `MIN_PRICED_SERVICES 3`, `RECOMMENDED 5`, `MIN_FAQS 1`, `RECOMMENDED_FAQS 3` (`kb/readiness.ts:21-24`) | | Yes (low), per vertical |
| Extraction caps | `PAGE_CAP 12000`, `EXTRA_PAGE_CAP 4000` (`extraction/index.ts:26-27`), `/api/extract` 10/min (`api/extract/route.ts:15`) | | Const ok |
| Disclosure | default EN/ES text and max 300 (`kb/disclosure.ts:9-16`), mandatory-notice regexes (`:25-28`) | const | Platform default text: **Yes** (editable, per jurisdiction); the mandatory rule: Const ok |

### 3.5 Auth, accounts, signup

| Knob | Where | Current | Admin? |
|---|---|---|---|
| Signup open/closed, captcha | `signupAvailability` env `TURNSTILE_*`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (`signup-config.ts:5-19`), `SIGNUP_ALLOW_WITHOUT_CAPTCHA` | env | **Yes** (invite-only switch); secret key stays env; site key is public config |
| Signup global cap | `SIGNUP_MAX_PER_HOUR`, `signup.ts:86` default 60 (`:19`), `SIGNUP_SOFT_FRACTION 0.7`, client share 0.2, untrusted 0.5 (`:91-95`) | | **Yes** |
| 2FA required for admins | `REQUIRE_2FA_FOR_ADMINS`, `session.ts:141` | env | **Yes** (also a tenant-wide "require 2FA for owners" policy: none exists) |
| Session lifetimes | `SESSION_MAX_AGE_S 12 h` (`auth.ts:13`), `SESSION_TTL_MS 7 d`, `ADMIN_SESSION_TTL_MS 12 h` (`db/users.ts:12,14`), `RECENT_AUTH_MS 5 min` (`session.ts:277`) | consts | **Yes** (security policy) |
| Password policy | `MIN_PASSWORD_CHARS 12`, `MAX 256` (`user-policy.ts:2-3`) | | Yes (min) |
| Login throttles | `IP_ATTEMPTS 60`, `IP_WINDOW_MS 5 min`, `FREE_FAILURES 3`, `MAX_BACKOFF_S 900`, untrusted variants (`login-throttle.ts:26-36`) | | Const ok |
| MFA / passkeys | `MFA_PENDING_TTL_MS 10 min` (`mfa.ts:12`), `MAX_PASSKEYS_PER_USER 20` (`db/passkeys.ts:12`), `RECOVERY_CODE_COUNT 10` (`totp.ts:139`) | | Const ok |
| Trial abuse | `trial_fingerprints` (email/card) | state only | Yes (admin view/clear) |
| WebAuthn RP | `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `webauthn.ts:44-45` | env | Keep env (bound to domain) |
| Demo mode | `DEMO_MODE` (`auth.ts:235`) | env | Keep env |

### 3.6 Jobs and schedulers

| Knob | Where | Current | Admin? |
|---|---|---|---|
| Runner on/off, tick | `JOBS`, `JOBS_TICK_SECONDS`, `jobs/schedule.ts:29,37`; consts `DEFAULT_TICK_SECONDS 60`, min 5, max 3600 (`:13-15`) | env | **Yes** (per-job enable/pause without redeploy; the runner reads env once at boot) |
| Per-job intervals | `CLEANUP_EVERY_MS 1 h`, `RETENTION_EVERY_MS 24 h`, `USAGE_WARNINGS_EVERY_MS 10 min`, `TENANT_RELEASE_EVERY_MS 24 h` (`jobs/index.ts:66-69`), calendar `POLL_EVERY_MS 15 min`, `MAX_CONNECTIONS_PER_TICK 20`, `MAX_BACKOFF_MS 6 h` (`jobs/calendar.ts:19-21`), reconcile full sweep 24 h (`jobs/reconcile.ts:61`) | consts | Yes (schedule editor) |
| Processed-events retention | `PROCESSED_EVENTS_RETENTION_MS 30 d` (`db/events.ts:7`) | | Yes (low) |
| Agent resync retries | `AGENT_RESYNC_MAX_ATTEMPTS 8`, backoff 2 min..60 min (`voice/agent-resync.ts:21-23`) | | Const ok |
| Recording deletion | `RECORDING_DELETE_ALERT_ATTEMPTS 5`, backoff 1 min..6 h (`voice/recording-deletion.ts:21-24`) | | Const ok |

### 3.7 Owner call-in and owner SMS replies (feature flags and budgets)

| Knob | Where | Current | Admin? |
|---|---|---|---|
| Owner call-in on/off | `OWNER_CALLIN_ENABLED`, `voice/owner/config.ts:7` (also `initiation-config.ts:15`) | on | **Yes** (feature flag, ideally per plan/tenant) |
| Owner call max seconds | `OWNER_CALL_MAX_SECONDS`, `owner/config.ts:12`, default and ceiling 300 (`:9`) | 300 | **Yes** |
| Sessions/day, proposals, confirm SMS/hr, lockouts | `OWNER_SESSIONS_PER_DAY 10`, `OWNER_PROPOSALS_PER_CALL 5`, `OWNER_CONFIRM_SMS_PER_HOUR 6`, `OWNER_BAD_PROPOSALS_LOCKOUT 5`, `OWNER_LOCKOUT_MS 1 h`, `OWNER_BAD_CODES_LOCKOUT 5`, `OWNER_CODE_TTL_MS 30 min`, `OWNER_PREVIEW_TTL_MS 10 min` (`owner/config.ts:14-27`); SMS command attempts 10 / 15 min (`owner/sms.ts:19-20`) | consts | Yes for budgets (abuse tuning), const for lockouts |
| Owner reply | `OWNER_REPLY_ENABLED` (`reply-config.ts:9`), `OWNER_REPLY_DAILY_LIMIT` default 10 (`:15`), `OWNER_REPLY_REQUIRE_ATTESTATION` (`:20`); consts `MAX_CHARS 120`, `MAX_SEGMENTS 4`, `TTL 30 min`, lead window 7 d, leads shown 5, drafts/call 5, per customer/hour 2, lists/hour 6, disclosed/day `{verified 30, unverified 10}`, handled/day `{30, 5}`, handled/call 3 (`:23-47`) | | **Yes** (flag + daily limits), consts ok for the rest |
| Owner phone grandfathering | `OWNER_PHONE_GRANDFATHER`, `_ACK`, `_BEFORE`, `_UNTIL` (`messaging/owner.ts:29-49`) | env | Yes (migration switch; or retire) |

### 3.8 Providers, email, integrations (what must stay env vs what is admin config)

| Item | Where | Verdict |
|---|---|---|
| Secrets: `ADMIN_TOKEN`, `APP_SECRET_KEY` (`totp.ts:181`), `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_BILLING_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN`, `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET`, `ELEVENLABS_TOOL_SECRET`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_WEBHOOK_SECRET`, `TURNSTILE_SECRET_KEY`, `SMTP_PASS`, `RESEND_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | **Keep env** (or encrypted-at-rest settings with the `APP_SECRET_KEY` envelope already in `totp.ts:195`; a "rotate key" UI is a stretch) |
| Non-secret identifiers: `TWILIO_ACCOUNT_SID`, `TWILIO_PHONE_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`, `ELEVENLABS_AGENT_ID` (`elevenlabs.ts:122`), `ELEVENLABS_PHONE_NUMBER_ID`, `ELEVENLABS_TOOL_SECRET_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_OAUTH_REDIRECT_URI`, `EMAIL_FROM`, `SMTP_HOST/PORT/SECURE/USER`, `EMAIL_PROVIDER` (`email/index.ts:57`), `APP_URL`/`PUBLIC_BASE_URL` | **Yes** for admin UI (provider config panel with live "test" buttons); `APP_URL` stays env (bootstrap, CSP) |
| LLM provider and model | `LLM_MODEL` default `gpt-4o-mini` (`providers/llm.ts:124`), `ANTHROPIC_MODEL` default `claude-sonnet-4-5` (`:146`), `LLM_TIMEOUT_MS 30000` (`:8`), retry set/delay (`:60-61`); selection by which key exists (`:19,162-164`) | **Yes** (provider choice, model name, timeout: model names go stale and need redeploys) |
| ElevenLabs/Twilio timeouts | `TWILIO_TIMEOUT_MS 15000`, `RECONCILE_DELAYS_MS` (`twilio.ts:32,424`), Stripe `TIMEOUT_MS 15000`, email `SEND_TIMEOUT_MS 10000` | Const ok |
| Webhook signature tolerance | `SIGNATURE_TOLERANCE_SECS 1800` (`elevenlabs.ts:36`), `SIGNATURE_TOLERANCE_S 300` (`billing/signature.ts:9`) | Const ok |
| Dev/mock flags | `GOOGLE_OAUTH_MOCK`, `STRIPE_ALLOW_UNSIGNED`, `ALLOW_INSECURE_DEV` | **Keep env** |
| Infra/log | `TRUSTED_PROXY`, `TRUSTED_PROXY_HOPS` (`auth.ts:215-251`), `CSP_*` (`csp.ts:47-97`), `LOG_LEVEL`, `LOG_PII`, `PRISMA_LOG` | **Keep env** |
| Limits for marketing in CSP etc. | `NEXT_PUBLIC_*` | build-time; avoid for anything the admin should change |

### 3.9 Enumerations and content that are code-only

| Item | Where | Notes / Admin? |
|---|---|---|
| Verticals | `VERTICALS` (`types.ts:123`), packs `src/lib/verticals/packs/{hvac,plumbing,electrical,cleaning,landscaping,dental,general}.ts`, aliases (`verticals/aliases.ts`); DB CHECK on `businesses.vertical` (schema comment `:74`) | Adding a vertical needs code + migration. **Yes** (pack content as data: services, FAQ, prompt, emergency triage; at least admin-editable copy) |
| Languages | `LOCALES = ['en','es']` (`types.ts:121`, `i18n/core.ts:13`), DB CHECK on `locale_default` | Const (code translation required); enable/disable per platform could be a setting |
| Refund policy enum | `RefundPolicy` + schema CHECK | with 3.4 |
| SMS templates | `messaging/templates.ts` (EN/ES in code) | Yes (template editor) at least STOP footer, review request, gratitude |
| Email templates | `email/templates.ts` | Yes (low) |
| i18n catalog | `src/lib/i18n/catalog/*` | Const |
| Marketing/site | `app/site-config.ts` | Yes (price strings) |

### 3.10 Rate limits on routes (hard-coded budgets in `limitRequest` calls)

34 `limitRequest(...)` call sites, all literal numbers, e.g. `provision` 5/min (global 100) (`businesses/[id]/provision/route.ts:94`), `extract` 10/min (global 300) (`extract/route.ts:15`), `sms/send` 10/min (global 500) (`sms/send/route.ts:22`), `bookings/create` 30 (`bookings/route.ts:89`), `billing/checkout` 10 (`checkout/route.ts:23`), admin routes 6-30 (`admin/*/route.ts`). Platform-wide ceilings (`globalLimit`) are cost brakes (LLM, SMS) and are the best candidates (**Yes**: `extract`, `sms/send`, `sms/payment-link`, `provision`); per-route per-minute client limits are **Const ok**. Limiter windows: `MAX_WINDOW_MS 1 h`, `CLEANUP_HORIZON_MS 3 h` (`ratelimit.ts:24-25`).

## 4. What is already admin-adjustable (for completeness)

Only: billing status/plan/trial end/period end/two caps per tenant (`admin/billing/route.ts:33`), job runs (dry-run first), tenant release, number repair, agent resync, create tenant users, retention purge (all API-only). Everything in sections 3.1-3.10 is env or code; **none of it is adjustable without a redeploy**, and NEXT_PUBLIC values need a rebuild.

## 5. Recommended implementation shape (concise)

1. **`platform_settings(key text pk, value jsonb, updated_by, updated_at)`** plus a typed registry in code (`key -> {type, min, max, default, env fallback, description, restart_required}`) so the existing env readers (`usage.ts`, `caller-limits.ts`, `forward-metering.ts`, etc.) become `setting('plan.sms_cap')` with env as fallback: no behaviour change on day one. Cache 30-60 s; audit every change with old/new values (fixes the gap noted in 24b about `billing.admin_override`).
2. **`plans` table** (key, name, stripe_price_id, stripe_price_id_annual, trial_days, sms_cap, call_minutes_cap, voicemail/forward caps, max_locations, feature flags JSON, is_comped, public flag) and `businesses.plan` as a foreign key. Replaces `BILLING_PLAN_NAME`, `STRIPE_PRICE_ID*`, `PLAN_*`, `TRIAL_*`, `COMP_PLANS`, `MAX_BUSINESSES_PER_USER`, `OWNER_CALLIN_ENABLED` as a feature flag.
3. **Admin tenant page** (`/dashboard/admin/tenants/[id]`): status (suspend/reactivate: new write path for `businesses.status`), billing/comp with expiry, caps incl. voicemail/forward overrides (new columns), provider ids, owner-phone verification clear, trial fingerprint clear, all settings from section 1 in read/edit mode with audit.
4. **Tenant `closed_dates` editor** (Settings or Knowledge) via a new `PATCHABLE.closed_dates` using `normalizeClosedDates` (`kb-patch.ts`).
5. **Per-tenant overrides** for quiet hours, briefing on/off + hour, gratitude/review follow-up toggle, forward/voicemail budgets (nullable columns, null = platform default).
6. **Provider panel**: non-secret ids, email provider/from, LLM provider/model with test buttons; secrets stay env.
7. Keep env for: secrets, `DATABASE_URL`, `APP_URL`/`PUBLIC_BASE_URL`, `TRUSTED_PROXY*`, `ADMIN_TOKEN` (break-glass), `APP_SECRET_KEY`, WebAuthn RP, `NODE_ENV`, CSP, dev/mock switches.

## 6. Adversarial notes (things that look configurable but are not, or that conflict)

- **Two truncation limits for the same data**: Knowledge PUT silently cuts to 20 services / 15 FAQs (`knowledge/route.ts:32-33`), the owner-change path allows 200 (`kb-patch.ts:18`); the DB has neither. A tenant that edits via voice then saves in the dashboard loses services 21-200 with no error.
- **`closed_dates` is written by the owner voice/SMS channel but not editable or removable in the dashboard**: a stale holiday cannot be fixed without calling in.
- **Admin cap overrides cannot lower voicemail/forward minutes**: `usage_counters` has `voicemail_seconds`/`forward_seconds` (`schema.prisma:593-596`) but `businesses` has only SMS and AI-minute override columns.
- **Trial cap applies only while `billing_status='trialing'`** (`usage.ts:62,69,78`); a comped tenant with `active` status and no override silently gets full plan caps, and a longer admin trial extension (`trial_ends_at`) is the only trial lever.
- **`BILLING_TRIAL_DAYS` is read at checkout creation** (`stripe-billing.ts:61`), so changing it affects only new checkouts, not existing trialing tenants; a settings UI must say so.
- **`NEXT_PUBLIC_PLAN_PRICE_DISPLAY*` are build-time**, so an admin editing the price text would need a rebuild; the Stripe price (`planPrices`, `billing/price.ts:98`, cached 10 min `:26`) is the live source and should be primary.
- **Country policy is split across three env/code places** (SMS list, forward list falling back to SMS list, `DEFAULT_PHONE_COUNTRY`, `owner_phone` check `route.ts:70`): admin UI must edit them as one "supported countries" object, otherwise a tenant can verify a number the platform cannot text.
- **DB CHECKs duplicate code constants** (deposit 100..100000, scheduling choices, review URL 300 vs code 120 `business-config.ts:16-18`): making these admin-tunable requires a migration that drops or widens the CHECKs, otherwise the setting is capped by the database.
