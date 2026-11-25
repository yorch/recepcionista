# 22. Adversarial review: platform / scheduling slice (agent D work)

Scope: time zones and inference, the scheduling config (slot, lead, horizon, buffer, crews) in availability, `validateSlot`, `nextAvailable`, reschedule and Google busy blocks, the crew-aware migration `20261208120000_mock_replacement_schema`, briefing audio (TTS, Postgres storage, audio route), LLM honesty and fallback labelling, the deploy.sh LLM requirement, the template content confirmation gate, the tenant release job, and the onboarding changes. Branch vs `origin/main` (commits `5fdd2e9`, `8f29743`).

Method: I read the code. I used my own databases (`rev_sched_test`, `rev_sched_shadow`, `rev_sched_old`) on 127.0.0.1:54329 and dropped them afterwards. I wrote throwaway bun tests in the scratchpad, never in the repo. Existing suites `tests/integration/platform-d.test.ts`, `tests/platform-d-pure.test.ts`, `tests/tz-infer.test.ts` and `tests/db/mock-replacement-migration.test.ts`: 51 pass, 0 fail.

## Findings (ranked)

### M1. The migration freezes the running app while it rebuilds the per-crew exclusion constraint (Medium)

- **Where:** `prisma/migrations/20261208120000_mock_replacement_schema/migration.sql:55-72`, together with `ALTER TABLE businesses ...` at `:15-33` and the validation loop at `:184-203`.
- **Problem:** `prisma migrate deploy` sends the file as one script, so it runs as one implicit transaction.
  - The `ACCESS EXCLUSIVE` locks taken by `ALTER TABLE businesses ADD COLUMN` and by the bookings `DROP/ADD CONSTRAINT bookings_no_overlap` are held until the end.
  - The end includes the GiST build over every booking and two full scans per CHECK (a `count(*)` and then `VALIDATE`).
  - So the `NOT VALID`-then-validate pattern does not shorten the lock window here.
- **Reproduced:**
  - Setup: an old-schema database (`origin/main` migrations) with 2,000 businesses and 1,000,000 bookings, then the new migration via `prisma migrate deploy`.
  - The migration took 1m57s.
  - A plain `SELECT count(*) FROM businesses` started 3 s in waited 1m54s.
  - Repair and constraint results were correct afterwards.
- **Impact:** deploy.sh runs `migrate` through `up -d` while the old app container is still serving. Every request reads `businesses`, so for the whole migration:
  - Twilio and ElevenLabs webhooks time out, and live calls fail.
  - Dashboard requests hang.
  - At SMB scale (tens of thousands of bookings) this is seconds; it grows linearly.
- **Fix:**
  - Move the bookings constraint swap (`DO $$ ... bookings_no_overlap ... $$`) into its own migration file. The `businesses` lock is then released before the GiST build.
  - Start each file with `SET lock_timeout = '5s'`, so a busy table fails the deploy instead of queueing every request behind it.
  - Document a maintenance window (or stop the app) for tables over about 100k bookings in `docs/runbook.md`.
  - Validate the CHECKs in a separate, later migration, so the `SHARE UPDATE EXCLUSIVE` scans do not run under the `ACCESS EXCLUSIVE` locks.

### M2. The tenant release job's "max 10 releases per run" cap is bypassed whenever a provider step fails (Medium)

- **Where:** `src/lib/jobs/tenants.ts:36-43` (`describe`) and `:73-82`.
- **Problem:** a release with any error is reported as `partial_error`, and only `released` / `notified` increment `report.processed`. The `MAX_RELEASES_PER_RUN` check (`:64`) only counts those.
  - In `executeRelease` (`src/lib/billing/release.ts:197-216`), a failed line deletion does NOT stop the agent deletion.
  - During an ElevenLabs phone-number API outage, every candidate's agent is deleted, the cap never triggers, and the report says `released: 0`.
- **Reproduced:**
  - Setup: `TENANT_RELEASE_JOB=on`, 13 canceled tenants past grace with a notice sent, and `fetch` stubbed so `DELETE /convai/phone-numbers/*` returns 500 and everything else returns 200.
  - One `runTenantReleaseJob({dryRun:false})` produced 13 × `partial_error`, `released: 0`, `deferred: 0`, and **13 agent DELETE calls** (cap 10).
- **Impact:** the cap is meant to protect against a runaway selection (for example a billing-sync bug marking many tenants canceled). It fails exactly when providers are degraded, and the destructive agent deletions are under-reported as "0 released".
- **Fix:**
  - Count every business where `r.applied` is true (any provider call was attempted) toward the cap.
  - Add a circuit breaker: stop the run after 2-3 businesses with errors.
  - Skip the agent deletion while `lineGone` is false, the same way the number is already kept.
  - Report `partial_error` items in the counts that the admin page highlights.

### M3. The dashboard "New booking" slot list applies the minimum notice and the booking window, which owner bookings are supposed to skip (Medium)

- **Where:**
  - `src/app/api/bookings/slots/route.ts:39` calls `slotsForDate(business, date, duration)`.
  - `src/lib/scheduler.ts:24-43` always applies `min_lead_minutes` and `horizon_days`.
- **Contradiction:** `createDashboardBooking` (`src/lib/booking-manual.ts:107`) passes `ownerInitiated: true`, and the Settings copy `pd.sc.ownerNote` says "Bookings you add yourself from the dashboard ignore the minimum notice and the booking window."
- **Why the owner cannot get around it:** the dialog (`src/components/calendar/booking-form-dialog.tsx:78-106`) only allows times from that list.
- **Reproduced (scratch test):**
  - Lead 180 and horizon 7: a date 20 days ahead returns **0 slots**, yet `createBooking(..., {ownerInitiated:true})` at that date succeeds.
  - Today, nothing earlier than now + 3 h is offered.
  - With the defaults (lead 60, horizon 14) every owner loses the next hour and everything beyond two weeks. That is a regression from main for the new dialog's purpose (a customer calls the owner directly to book in 3 weeks).
- **Fix:** add `opts.ownerInitiated` to `slotsForDate`: lead 0 and no horizon, like `slotsForMove` without `customer`. Use it in `/api/bookings/slots`.

### M4. The content confirmation fingerprint ignores FAQ answers and service descriptions, which carry template prices the AI quotes (Medium)

- **Where:** `src/lib/business-config.ts:203-211` (`contentFingerprint`): services name, price and duration, plus `pricing_notes` and `service_area` only.
- **Problem:** the vertical templates put literal prices into FAQ answers:
  - `src/lib/verticals/packs/plumbing.ts:20` ("Drain cleaning starts around $125")
  - `hvac.ts:20` ("Repairs start around $120")
  - `electrical.ts:21` ("Troubleshooting starts around $130")
- **Impact:**
  - The go-live gate (18f item 9, "owner must confirm prices") passes even though callers are told template prices the owner never priced.
  - Editing an FAQ price after confirming never makes the state `stale`.
  - Service `description` (free text, often prices or area) is also excluded.
- **Fix:**
  - Include FAQ question and answer, and service descriptions, in the fingerprint. Editing prose then re-asks, which is the honest trade-off.
  - Or, at minimum, include any FAQ or description containing a currency or number pattern.
  - Make the confirm UI list the FAQs it covers.

### L1. Confirming on the Knowledge page approves whatever is stored, not what the owner saw (Low-Medium)

- **Where:**
  - `src/components/knowledge/content-confirm.tsx:44` POSTs `{}`.
  - `src/app/api/businesses/[id]/content-confirmation/route.ts:45-48` and `src/lib/db/content-confirmation.ts:25-31` fingerprint the current DB content.
- **Failure scenarios:**
  - Unsaved edits: the owner edits prices in the editor without saving and ticks the confirm card above it. The old (template) prices are confirmed.
  - Concurrent staff edit: a staff member changes prices between the owner's page load and the click. The owner confirms prices they never saw.
- **Fix:** the client sends the fingerprint of the content it displayed (`expected_hash`). The route answers 409 when it differs from the current fingerprint. Alternatively, disable the card while the editor is dirty.

### L2. The migration's time zone "repair" moves valid legacy zones to New York (Low)

- **Where:** `migration.sql:36-38`.
- **The comment is wrong:** it says this is "what `tzOf` already did on read". It is not: `tzOf` (`src/lib/time.ts:20-23`) keeps every name that `Intl` accepts.
- **Reproduced on the populated old database:** these legacy values all became `America/New_York`:

  | Legacy value | What it meant | Shift after repair |
  |---|---|---|
  | `PST8PDT` | Pacific | 3 h |
  | `MST` | Arizona | 2-3 h |
  | `GMT` | UTC | 4-5 h |
  | `Japan` | Tokyo | many hours |

  `EST` (fixed UTC-5, `Intl` resolves it to `America/Panama`) would be repaired the same way.
- **Impact:** limited, because main had no UI or API that wrote non-IANA names (only operator SQL or seed). A tenant set by an operator would silently shift its hours, slots and texts.
- **Fix:** map Intl-valid legacy names to their canonical IANA name before the fallback (for example `MST` to `America/Phoenix`, `PST8PDT` to `America/Los_Angeles`, `GMT` to `UTC`, `Japan` to `Asia/Tokyo`). Or `RAISE` with the list of offending rows instead of guessing.

### L3. The onboarding time zone suggestion overrides a zone the owner already chose; inference gaps (Low)

- **Overrides a saved choice:**
  - `src/app/onboarding/step-timezone.tsx:41` pre-selects the area-code suggestion whenever `!touched`, even when the stored zone is not the default.
  - `flush()` (`:44-55`) saves it when the owner clicks Continue on the verify step.
  - Scenario: an owner who set `America/Chicago` in Settings but has a 305 mobile, revisiting `/onboarding?step=verify`, is switched back to New York. Hours shift, and the agent is resynced.
- **Wrong label in the dropdown:**
  - The suggestions `America/St_Thomas` (340) and `Pacific/Guam` (671) are not in `TIME_ZONE_OPTIONS` (`src/lib/tz-options.ts`), and only the stored zone is added to the list.
  - The `<select>` then shows the first option ("Eastern - New York") while it will save Guam.
- **Inference table** (`src/lib/tz-infer.ts:34-55`): split area codes mapped to one zone:
  - 812/930: Evansville and SW Indiana are Central, not Eastern.
  - 208: north Idaho is Pacific.
  - 541: Malheur County is Mountain.
  - 906: the western Upper Peninsula is Central.
  - Because Continue saves the suggestion, it is effectively applied, not just a hint.
- **Fix:**
  - Pre-select only while the stored zone is still the default and no `business.timezone_changed` audit row exists.
  - Add the inferable zones to the options.
  - Treat split codes as ambiguous (`null`).

### L4. The voice agent says "That day is full" for dates beyond the booking window (Low, honesty)

- **Where:** `src/lib/voice/tools.ts:311-316`.
- **Problem:** `slotsForDate` returns `[]` for a date at or beyond `horizon_days`, and `checkAvailability` turns that into `dayFull` ("That day is full, but I have ..."). The same happens on closed days.
- **Fix:** check the horizon, and closed days, first. Answer with the `too_far` wording, which already exists in `rejectionResult`.

### L5. Briefing audio: a failed regeneration destroys good audio; spend and reads are unbounded (Low)

- **Good audio deleted:** `attachBriefingAudio` (`src/lib/briefing/index.ts:330-343`) deletes the stored clip on ANY TTS failure. An owner pressing "Generate audio" on a briefing that already has audio (the POST does not check), during a transient ElevenLabs error, loses a valid clip of the same transcript.
  - Fix: only delete when the transcript differs from the one the clip was made from, or keep the clip on `provider_failed`.
- **Unmetered TTS spend:** the regenerate POST (`src/app/api/briefings/[id]/audio/route.ts:92-95`) allows 20 per hour per business, about 480 TTS calls a day at up to 2,500 characters, with no plan metering or daily cap.
  - Fix: a daily cap, and refuse when audio already exists for the same text.
- **Full blob read on every request:**
  - `GET` loads the full bytea (up to 5 MiB) before the `If-None-Match` check (`:52-62`).
  - It loads it again for every Range request, and the clip is copied twice (`Buffer.from`, then `subarray` into a new `Uint8Array`).
  - Fix: answer 304 from `getBriefingAudioMeta` alone. Serve ranges with `substring(bytes from x for n)`.
  - The route is authenticated and tenant scoped, so only an authenticated staff user can abuse this.

### L6. The booking window copy is off by one (Low)

- **Where:** `pd.sc.horizonHint` says "Customers can book up to this many days from today". The check is `dateKey >= today + horizon_days` (`src/lib/availability.ts:81`, `scheduler.ts:33`).
- **Effect:** `horizon_days = 1` means today only, and 14 means today plus 13 days.
- **Fix:** reword ("including today"), or compare with `>`.

## Checked and holding (no finding)

**Migration**
- Zero drift: `migrate diff --from-url` and `--from-migrations` with a shadow database both report "No difference detected".
- The populated old-schema upgrade succeeded:
  - Backfill was correct.
  - The constraint was rebuilt with `crew` and old overlap data stayed valid.
  - All CHECKs were validated.
- Re-running is guarded.

**Scheduling**
- Crews:
  - Lowering takes the `createBooking` advisory lock and refuses with `crew_in_use` for bookings that have not ended.
  - An explicit `crew` is validated (`invalid_crew` / `slot_taken`).
  - Reschedule falls back to crew 1 when the old crew is above the count.
- Buffer: applied symmetrically in `createBooking`, `rescheduleBooking`, `slotsForDate`, `nextAvailable`, `slotsForMove` and the Google busy check. The DB enforces only raw per-crew overlap, as the contract says, and every path re-checks under the lock.
- Lead and horizon consistency:
  - AI booking: `validateSlot` with lead and horizon.
  - Voice reschedule: `slotsForMove({customer:true})` together with `rescheduleBooking` with `initiator:'customer'`.
  - Owner reschedule and its slot list: no lead and no horizon.
  - Only the new-booking list (M3) is inconsistent.
- DST: windows come from `zonedTimeToUtc`. A spring-forward gap moves the opening forward, an ambiguous time takes the earlier instant, and 23 h / 25 h days come from `dayRange`. Slots step in absolute time, so no slot is lost or duplicated in instant terms.
- Worst-case `nextAvailable` CPU (20 crews, 180 days, 15-minute grid, 24 h hours, fully booked, 86k bookings): about 2 s. Unrealistic, so not reported.

**Briefing audio**
- Tenant scoping returns 404 for another business's briefing (same as missing). Content type comes from the CHECKed row. The response is `private` and `nosniff`.
- The Range parser handles suffix, open-ended, out-of-range (416) and multi-range (ignored).
- The legacy `/audio/<file>` route is still authenticated.

**Tenant release job**
- Dry run by default. `dry_run:false` without `TENANT_RELEASE_JOB=on` is reported as `refused_not_enabled`, both in the admin route and in the CLI `--apply`.
- Only `canceled` / `unpaid` tenants past grace, with a notice sent, are candidates. Facts are re-read under the lease. Live paying tenants are never selected, even with `business_id`.

**LLM and deploy**
- An LLM is required in production by both deploy.sh and health (503 `llm_not_configured`).
- Briefing narration falls back to `automatic` on a missing key, a provider error or the wrong length, and the dashboard labels it.
- Call summaries are marked `[auto]` and the UI shows a badge.

**Go-live gate**
- Enforced server-side in the provision route for every non-admin.
- PATCH cannot set `status`.
- The service area is a blocker.
- Already-live tenants are not re-gated, as designed.

**Note.** `clearContentConfirmation` is never called; the contract said a vertical switch should call it. The fingerprint covers the cases where a new template replaces the services, so this is not a finding on its own.

## Resolution

Every finding is fixed. Tests: `tests/integration/review19.test.ts`, `tests/review19-pure.test.ts`, `tests/db/mock-replacement-migration.test.ts`, `tests/integration/platform-d.test.ts`, `tests/integration/tenant-line.test.ts`.

| Finding | Status | Fix and evidence |
| --- | --- | --- |
| M1 migration freezes the app (Medium) | Fixed | `20261208120000` (never released: it is on this branch only) now only adds columns, tables and NOT VALID checks, with `SET lock_timeout = '10s'`. The CHECK validation and, LAST, the per-crew overlap rebuild moved to `20261209120000_review19_fixes` (its own transaction: the `businesses` ACCESS EXCLUSIVE locks are gone, the validation scans take SHARE UPDATE EXCLUSIVE locks, the GiST build holds only `bookings`). Both are guarded, so a database that applied the first version upgrades through the second as a no-op for what it has (fixture test). Runbook section 4 documents the maintenance window above about 100k bookings. Residual: the GiST build still takes `bookings` exclusively for its duration (inherent to an EXCLUDE constraint; `CREATE INDEX CONCURRENTLY` cannot back a constraint). Tests: pure `22 M1` (file layout), `mock-replacement-migration` (populated upgrade from main, from the first version, fresh, re-run, zero drift). |
| M2 release cap bypassed when a provider step fails (Medium) | Fixed | The run counts every business it ACTED on toward `MAX_RELEASES_PER_RUN` whatever the outcome, stops after 3 businesses with a provider error (`MAX_RELEASE_ERRORS_PER_RUN`, `deferred_to_next_run`), and `executeRelease` keeps the agent too while the imported line cannot be removed (no half teardown). `counts.partial_error` reports the failures. Tests `22 M2` (6 canceled tenants, every phone-number delete 500: no agent deleted, at most 3 `partial_error`, the rest deferred), `tenant-line` release test. |
| M3 owner slot list applies notice / window (Medium) | Fixed | `slotsForDate(..., { ownerInitiated: true })` (no lead, no horizon) is used by `GET /api/bookings/slots`; customers keep both. Test `22 M3`. |
| M4 confirmation fingerprint ignores FAQs / descriptions (Medium) | Fixed | The fingerprint covers service descriptions, FAQ questions and answers, pricing notes and the service area (an upgrade makes old confirmations `stale` once: documented). The Knowledge card says it covers the FAQs. Pure `22 M4`, test `22 M4+L1`. |
| L1 confirming approves whatever is stored (Low-Medium) | Fixed | `POST content-confirmation` accepts `expected_hash` (the card sends the fingerprint the page was rendered with; GET returns `content_hash`): a changed content is 409 `content_changed` and nothing is stored. Unsaved editor edits cannot be seen by the server: the copy says the card confirms what is SAVED. Test `22 M4+L1`. |
| L2 migration moves valid legacy zones to New York (Low) | Fixed | The migration maps names Intl knows to their IANA zone (`PST8PDT`, `MST`, `GMT`, `Japan` ... in a table inside the migration) and writes an audit event `business.timezone_repaired` (from, to, mapped) for every repaired row; only an unknown name falls back to New York. Test: the populated upgrade in `mock-replacement-migration`. The wrong comment is gone. |
| L3 onboarding zone suggestion (Low) | Fixed | The suggestion pre-selects only while the stored zone is the untouched default (`chosen` in the GET view: a non-default zone or an audited change); St Thomas and Guam are in the select; split area codes (812, 930, 208, 986, 541, 906) give no suggestion. Test `22 L3`, pure `22 L3`. |
| L4 "That day is full" beyond the window (Low) | Fixed | `check_availability` says why a day has nothing: beyond the booking window, closed, in the past or full. Test `22 L4`. |
| L5 briefing audio (Low) | Fixed | Failed regeneration keeps a clip made from the SAME text (new `briefing_audio.text_hash`) and deletes only a clip of an older text; the same text and voice is not synthesized again (`reused`); real syntheses are capped at 10 per business per day (429 `audio_daily_limit`); the 304 comes from the metadata alone and a Range request reads only its bytes (`substring()` inside Postgres, no second copy). Tests `22 L5`, `platform-d` audio tests. |
| L6 horizon copy off by one (Low) | Fixed | Copy (EN/ES) and docs say "counting today" (`horizon_days = 1` is today only). |
| Note: `clearContentConfirmation` never called | Documented | A vertical switch that replaces the services changes the fingerprint, which has the same effect (known-limitations). |
