# Mock replacement: data contracts (Phase 1 output)

Everything Phase 2 builds on. Phase 1 owns `prisma/**`, `src/lib/db/**` additions, `src/lib/types.ts`, `src/lib/business-config.ts`,
`src/lib/crews.ts`, `src/lib/tz-infer.ts`. Phase 2 adds BEHAVIOUR (routes, UI, jobs, provider calls) only and must not change the schema without
a new migration owned by the same person. Migrations: `prisma/migrations/20261208120000_mock_replacement_schema` (columns, tables, NOT VALID checks; short locks) and `20261209120000_review19_fixes` (validation of those checks, `briefing_audio.text_hash`, the `sms_log (to_e164, created_at)` index and the per-crew overlap rebuild, last); hand written, re-runnable,
additive, zero drift; upgrade test `tests/db/mock-replacement-migration.test.ts`.

Conventions kept: money is integer cents; all times are timestamptz (JS `Date` / ISO strings in the domain types); every helper that takes a
`businessId` is tenant scoped (a row of another business is "not found"); invalid values given to `updateBusiness` are ignored (never written),
dedicated helpers return `{ ok: false, reason }`.

## 1. Columns

### businesses

| column (domain field) | type / default | rule |
|---|---|---|
| `elevenlabs_phone_number_id` | text null, UNIQUE | `phnum_...`; 1..100 chars. The tenant's own AI line. Env `ELEVENLABS_PHONE_NUMBER_ID` is a fallback only (`resolveElevenLabsPhoneNumberId`). |
| `twilio_phone_sid` | text null, UNIQUE | `PN...`; 1..64 chars. |
| `review_url` | text null | https only, no whitespace, <= 120 chars in the API (the CHECK still allows 300 for links saved before: the text builder never cuts a link). |
| `assistant_name` | text null | 1..40 chars after trim (CHECK); in the API one to three words of letters (`'` and `-` inside a word), never a sentence; a stored value without that shape is read as the default. NULL = platform default name. |
| `deposit_enabled` | bool, false | false = NO policy = the legacy behaviour (amount is whatever the agent / owner asks). |
| `deposit_mode` | text, `'fixed'` | `fixed` or `percent`. |
| `deposit_fixed_cents` | int null | 100..100000. |
| `deposit_percent` | int null | 1..100 of `price_estimate`. |
| `deposit_min_cents` / `deposit_max_cents` | int null | 100..100000, min <= max; fixed must lie inside them. |
| | | CHECK: enabled + fixed needs `fixed_cents`; enabled + percent needs `percent`. |
| `slot_minutes` | int, 60 | 15, 30 or 60. |
| `min_lead_minutes` | int, 60 | 0..10080. |
| `horizon_days` | int, 14 | 1..180. |
| `buffer_minutes` | int, 0 | 0..240. |
| `crews` | smallint, 1 | 1..20. |
| `content_confirmed_at` / `content_confirmed_hash` | timestamptz null / text null | both null or both set (CHECK). |
| `native_transfer_enabled` | bool, false | opt-in. |
| `timezone` | existing | new CHECK: `UTC` or an `Area/Location` shaped name. Legacy non-IANA values are mapped by the migration to their IANA zone (`PST8PDT` to Los Angeles, `GMT` to UTC, `Japan` to Tokyo ...; unknown names fall back to `America/New_York`, what `tzOf` does on read) and every repair is audited `business.timezone_repaired` (reviews 22 L2). |

Defaults reproduce the code that existed before: hourly grid (`SLOT_STEP_MIN = 60`), 60 minutes lead (`nextAvailable` used `leadMin: 60`),
14 days (`nextAvailable` looked 14 days ahead), no buffer, a single resource. NOTE: `slotsForDate` and booking validation (`validateSlot`) used
lead 0 before; wiring `min_lead_minutes` into them is a Phase 2 decision (default 60 would hide the next hour from the owner's own dashboard
bookings; consider applying the lead to AI / public offers only).

### bookings

| column | type / default | rule |
|---|---|---|
| `crew` | smallint, 1 | 1..20. The overlap EXCLUSION constraint `bookings_no_overlap` is now `(business_id =, crew =, tsrange(scheduled_at, scheduled_at + duration) &&) WHERE status <> 'cancelled'`. |
| `deposit_source` | text null | `stripe` \| `manual` \| NULL. Backfill: paid deposits with a Stripe payment-intent / checkout-session id are `stripe`; mock/demo paid deposits stay NULL. |
| `deposit_marked_by` / `deposit_marked_at` | text null / timestamptz null | who (user id or `admin_token`) / when marked manually. CHECK: `manual` requires `deposit_marked_at`. |
| `created_via` | text, `'ai'` | `ai` \| `dashboard` \| `sms` \| `api` \| `system`. Existing rows are `ai` (provenance was not recorded; do not infer more). |

### sms_log.kind (CHECK list)

`confirmation, payment_link, gratitude, review_request, owner_alert, manual, owner_inbox_reply, inbox_autoreply, other` (`SMS_KINDS` in types).
`manual` = an owner-typed text; `owner_inbox_reply` = the owner's reply to an inbox message; `inbox_autoreply` = the automatic acknowledgement.

## 2. New tables

### inbound_messages (the owner's inbox)

`id, business_id (FK cascade), from_e164 (CHECK E.164), from_phone, body (<= 1600), twilio_message_sid UNIQUE (global), received_at, status
new|handled|ignored, handled_at, handled_by, forwarded_to_owner_at, auto_replied_at, booking_id (FK set null)`.
CHECK: `new` has no `handled_at`; `handled`/`ignored` require it. Indexes: `(business, received_at)`, `(business, status, received_at)`, `(business, from_e164)`, `(booking_id)`.
Rules: STOP/START-class keywords are NOT stored (they stay with `messaging/inbound.ts`); everything else is. Dedupe is the sid: a redelivery is
`created: false`. A sid owned by another business is refused. Retention follows `businesses.retention_days` (`purgeExpiredData`, counted in
`inbound_messages`). Erasure by phone deletes rows by `from_e164`; `exportCustomerData` returns `inbound_messages`. `clearAll` wipes it.

### briefing_audio

`id, briefing_id (FK cascade, UNIQUE), content_type (audio/mpeg|mp4|aac|wav|ogg), bytes bytea (CHECK 1..5 MiB), voice_id, text_hash (SHA-256 of the transcript it was made from; migration 20261209120000), created_at`.
`briefings.audio_url` semantics preserved: legacy rows keep `/audio/<file>`; stored audio uses `briefingAudioUrl(id)` = `/api/briefings/<id>/audio`
(`saveBriefingAudio` sets it in the same transaction; `isStoredBriefingAudioUrl` tells them apart). Cascades with its briefing (retention purge,
erasure, business delete). `pruneBriefingAudio({keepDays})` removes older clips and nulls the pointer; `BRIEFING_AUDIO_KEEP_DAYS` (default 30)
is the env knob (`briefingAudioKeepDays()`); the job that calls `pruneBriefingAudio` (hourly cleanup) is Phase 2.
The route must be authenticated and tenant scoped (use `getBriefingAudio(businessId, briefingId)`), send `content-type` from the row and `private` caching.

### Release job state

No table (decision L). The tenant release job stays audit-only: use `recordAudit` with action `tenant.released` / `tenant.release_failed`,
`business_id`, and `meta` listing what was released (no secrets).

## 3. Helpers (all exported from `@/lib/db`, pure ones from their module)

| area | file | functions |
|---|---|---|
| inbox | `db/inbound-messages.ts` | `recordInboundMessage`, `getInboundMessage`, `getInboundMessageBySid`, `listInboundMessagesPage`, `countInboundByStatus`, `setInboundStatus`, `markInboundForwarded`, `markInboundAutoReplied`, `linkInboundToBooking`, `latestInboundFrom`, `toInboundMessage` |
| briefing audio | `db/briefing-audio.ts` | `saveBriefingAudio`, `getBriefingAudio`, `getBriefingAudioMeta`, `deleteBriefingAudio`, `pruneBriefingAudio`, `briefingAudioKeepDays`, `briefingAudioUrl`, `isStoredBriefingAudioUrl` |
| tenant line | `db/business-line.ts` | `setBusinessLine`, `getBusinessIdByElevenLabsPhoneNumberId`, `getBusinessIdByTwilioPhoneSid`, `resolveElevenLabsPhoneNumberId` |
| deposits | `db/deposit-policy.ts` | `getDepositPolicy`, `setDepositPolicy`, `markDepositPaidManually`, `unmarkManualDeposit` (+ pure `validateDepositPolicy`, `computeDepositCents`, `depositPolicyOf` in `lib/business-config.ts`) |
| scheduling | `db/scheduling-config.ts` | `getSchedulingConfig`, `setSchedulingConfig`, `setBusinessTimeZone`, `listBlockingIntervalsByCrew`, `firstFreeCrewFor` (+ pure `firstFreeCrew`, `hasFreeCrew`, `normalizeCrews` in `lib/crews.ts`; `schedulingOf`, `DEFAULT_SCHEDULING`, `validateSchedulingPatch` in `lib/business-config.ts`) |
| content | `db/content-confirmation.ts` | `getContentConfirmation`, `confirmContent`, `clearContentConfirmation` (+ pure `contentFingerprint`, `contentConfirmationState`) |
| time zone | `lib/tz-infer.ts` | `isIanaTimeZone`, `inferTimeZoneFromPhone`, `timeZoneForAreaCode`, `AREA_CODE_TIME_ZONES` |
| validators | `lib/business-config.ts` | `validateReviewUrl`, `validateAssistantName`, `validateTimeZone`, `validateElevenLabsPhoneNumberId`, `validateTwilioPhoneSid`, limits (`DEPOSIT_MIN_CENTS`...) |

`createBooking` / `rescheduleBooking` are now crew aware: with `crews = 1` they behave exactly as before. `createBooking` accepts `crew` (explicit; refused
`invalid_crew` outside 1..crews, `slot_taken` when busy) and `created_via`; without `crew` it assigns the first free crew. `rescheduleBooking` keeps the
booking's crew when free, else the first free crew, else `slot_taken`. `markDepositPaid` (Stripe/demo) stamps `deposit_source = 'stripe'` (the demo checkout: NULL) and REPLACES a manual mark, even for the same amount; it returns `replaced_manual` so the webhook can tell the owner the customer paid twice, and it resets a manual refund recorded on that row (the manual record stays in the audit trail). `setDepositAmountIfUnpaid` is the only writer of a requested amount (conditional on `deposit_paid = false`).
`updateBusiness` accepts (validated, invalid ignored): `elevenlabs_phone_number_id`, `twilio_phone_sid` (P2002 if owned elsewhere; prefer `setBusinessLine`),
`review_url`, `assistant_name`, `native_transfer_enabled`, `timezone` (IANA only), and the five scheduling fields. The deposit policy is NOT patchable through
`updateBusiness` (it must be validated as a whole): use `setDepositPolicy`.

## 4. Semantic rules

* **Time zone.** Editable through `setBusinessTimeZone` (IANA only; `EST`, `+01:00`, `GMT+2` refused in code and by CHECK). Bookings are instants and do not move; `hours` and
  `closed_dates` are wall-clock in the new zone, so the UI should ask the owner to re-check them. `inferTimeZoneFromPhone(ownerPhone)` is a PRE-FILL hint at signup only
  (ambiguous codes such as 850 and 308 give `null`; the default stays `America/New_York`).
* **Deposit policy.** `computeDepositCents(policy, price_estimate)`: fixed returns `fixed_cents`; percent returns `round(price * percent / 100)` clamped to
  `[min ?? 100, max ?? 100000]` and never above the price; `null` = no deposit (policy off, or percent without an estimate). The call script's own $500 cap for
  AI-requested deposits (`MAX_CENTS` in `payments/create-link`) is separate and unchanged; the owner policy limit is $1000.
* **Manual deposits.** `markDepositPaidManually` refuses cancelled bookings, bookings already paid by anything but an identical manual mark, and non-positive amounts;
  audits `booking.deposit_marked_manual`. `unmarkManualDeposit` only undoes a manual mark that has no refund recorded; audits `booking.deposit_unmarked_manual`.
  PHASE 2 MUST: never call Stripe to refund a `deposit_source = 'manual'` booking (use `markRefundNotApplicable` / tell the owner to refund off-platform), and show the source in the UI.
* **Crews.** One crew = old behaviour. `setSchedulingConfig` refuses to lower `crews` while a non-cancelled upcoming booking sits above the new count (`crew_in_use`); it takes the
  same advisory lock as `createBooking`. The buffer is NOT stored in the constraint: slot offering extends each busy interval by `buffer_minutes` in code (Phase 2), the DB only
  guarantees raw non-overlap per crew. A slot is available while `hasFreeCrew(crews, slot, listBlockingIntervalsByCrew(...))`.
* **Content confirmation.** `confirmContent` stores the time and a SHA-256 fingerprint of (services name/price/duration/description, FAQ questions and answers, pricing notes, service area). No writer has to reset
  anything: `contentConfirmationState` is `unconfirmed` (never), `confirmed` (fingerprint matches) or `stale` (any of those changed). `confirmContent(..., { expected_hash })` refuses (`{ changed: true }`) when the stored content is no longer what the owner saw. Go-live gating (refuse `status = 'live'` unless `confirmed`, or show "re-confirm" on `stale`) is Phase 2. Switching vertical template should call `clearContentConfirmation`.
* **Native transfer.** `native_transfer_enabled` is only a flag; with it false (default) behaviour is unchanged. Phase 2 wires the provider call and keeps the Twilio dial leg as the default.
* **Inbox.** `markInboundForwarded` / `markInboundAutoReplied` are first-stamp-wins (return `true` once): use them as the "do it exactly once" gate before sending the owner alert / auto reply.
  Outbound replies are logged with `logSms({ kind: 'owner_inbox_reply' | 'inbox_autoreply' })` and still go through opt-out / quiet-hours / cap checks (`sendAndLog`), and are sent FROM the tenant's own number (`messaging/sender.ts`; the shared sender is the fallback). The owner-forward `owner_alert` row stores a redacted line, never the customer's words (`sendAndLog({ log_body })`).
* **Retention / erasure / export.** `PurgeCounts.inbound_messages`, `EraseCounts.inbound_messages` and `CustomerExport.inbound_messages` are new fields. `clearAll()` wipes `inbound_messages` and `briefing_audio`
  (`tests/db/clear-all.test.ts` fills both).

## 5. Env vars

| var | meaning |
|---|---|
| `ELEVENLABS_PHONE_NUMBER_ID` | now a FALLBACK for tenants without `businesses.elevenlabs_phone_number_id`. Never reassign it away from a tenant that is using it. |
| `BRIEFING_AUDIO_KEEP_DAYS` | new, default 30 (see `pruneBriefingAudio`). Documented in `docs/env-vars.md` and `.env.example`. |

## 6. Who owns what in Phase 2

* **Voice / provisioning agent:** per-tenant line: use `resolveElevenLabsPhoneNumberId`, `setBusinessLine`, assistant name in the agent prompt, `native_transfer_enabled`, release job audit events.
* **Messaging agent:** inbound webhook writes `recordInboundMessage`, owner alert / auto reply gates, owner reply route, `review_url` in review-request texts, inbox UI and counts.
* **Scheduling agent:** `scheduler.ts` / `availability` / booking validation read `schedulingOf(business)`; crew-aware slots (`listBlockingIntervalsByCrew`); settings UI for slot / lead / horizon / buffer / crews / timezone.
* **Payments agent:** `computeDepositCents` in the booking flow, deposit policy settings, manual mark / unmark routes and UI, refund path for manual deposits.
* **Briefing agent:** `saveBriefingAudio` in `briefing/tts.ts`, `GET /api/briefings/[id]/audio`, prune job, remove the on-disk path once nothing reads `/audio/<file>`.
* **Onboarding agent:** content confirmation step and go-live gate, `inferTimeZoneFromPhone` pre-fill.
