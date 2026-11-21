# Review 02 - Data layer and business logic

Scope: `prisma/`, `src/lib/db`, `types.ts`, `kb`, `extraction`, `briefing`, `demo`, `format.ts`, `log.ts`, `providers/llm.ts`, `scripts/`, and `voice/tools.ts` (business logic only). I also read `src/lib/scheduler.ts`, because `tools.ts` depends on it for every booking decision.

## Summary

The schema and migrations agree with each other (2 migrations, no drift found). Cascades are sensible and the indexes cover the main access paths. The weak spot is **time and availability logic**. It mixes three time models:

- The scheduler uses server-local time. The Docker image sets no `TZ`, so that is UTC.
- The DB day-bounds helper hard-codes UTC-5.
- Everything user-facing uses `America/New_York`.

On top of that, double-booking protection is a racy exact-minute check, and deposit money never reaches the stats. The test story is ad-hoc scripts only. There is no test runner, and the `ws3`/`ws4` scripts re-seed (wipe) whatever `DATABASE_URL` points at.

I verified the time-zone behaviour by running the scheduler's `atTime` with `TZ=UTC`. The 08:00 open time became 08:00Z, which is 3:00 AM ET. I also confirmed that `dayRange('2026-07-15')` starts at 05:00Z, but midnight EDT is 04:00Z.

---

## High

### H1. Scheduler generates slots in server-local time, not the business's time zone
`src/lib/scheduler.ts:10-15, 22, 46-48`

- `atTime()` does `new Date('YYYY-MM-DDT00:00:00')` followed by `setHours`. That is the server's local time zone, and the Dockerfile and compose files set no `TZ`.
- With a UTC container, "open 08:00" becomes 08:00Z, which is 3:00 AM ET in winter and 4:00 AM in summer. `check_availability` therefore offers 3 AM-12 PM ET slots, and 1 PM-6 PM ET slots are never offered.
- `nextAvailable` takes `d.toISOString().slice(0, 10)` after `setDate`. That is the UTC date, so after 7-8 PM ET it jumps a day ahead and skips the remainder of "today".
- `tools.ts` renders everything in ET (`etParts`, `spokenTime`) and validates hours in ET (`insideOpenHours`). The offered slots and the validator therefore disagree.
- Failure scenario: the agent offers "tomorrow at 3 AM". If the caller picks it, `createBooking` rejects it as outside hours, and the call dead-ends.
- Fix:
  - Add a `timezone` column on `Business`, defaulting to `America/New_York`.
  - Write one `zonedTimeToUtc(dateStr, hhmm, tz)` helper. `date-fns` v4 is already a dependency; use `@date-fns/tz` `TZDate`, or Luxon.
  - Use it in the scheduler, `db/index.ts` `dayRange`, `tools.ts`, `briefing`, `format.ts` and `templates.ts`.
  - As a stopgap, set `TZ=America/New_York` in the Dockerfile and compose files.

### H2. Double-booking is possible, and the overlap logic is wrong
`src/lib/voice/tools.ts:341-356`, `src/lib/scheduler.ts:26-37`, `src/lib/db/index.ts:384-387`, `prisma/schema.prisma:94`

- **Check-then-insert race.** `createBooking` reads the booked slots, then inserts, with no transaction, lock or unique constraint. Two simultaneous calls (the product is a phone receptionist) can both get "slot free" and both book 10:00.
- **Exact-instant matching only.**
  - `bookedMinutes.has(minutesOf(iso))` and `booked.has(t)` ignore duration. A 120-minute job at 10:00 does not block 11:00. A booking at 10:30 blocks nothing on the hourly grid.
  - `checkAvailability` accepts `duration_minutes`, but the grid always steps 60 minutes. The `duration_minutes` stored on each Service is never used by the scheduler.
- **Cancelled bookings still block.** `getBookedSlots` calls `listBookings`, which does not filter `status`. A cancelled appointment holds its slot forever.
- **Redundant, unbounded query.** `tools.ts:341-346` first calls `getBookedSlots` and then `listBookings(business.id)`, which loads the business's entire booking history. The second call alone covers the first, because it is a superset.
- Fix:
  - Make the check and the insert atomic. Use `prisma.$transaction` with `pg_advisory_xact_lock(hashtext(businessId))`, or add a partial unique index such as `CREATE UNIQUE INDEX ... ON bookings(business_id, scheduled_at) WHERE status <> 'cancelled'`.
  - Use interval overlap (`start < otherEnd AND end > otherStart`) using the service duration.
  - Filter out cancelled bookings in `getBookedSlots`.

### H3. `isWithinHours` is effectively a no-op, and `insideOpenHours` has an off-by-one
`src/lib/scheduler.ts:59-62`, `src/lib/voice/tools.ts:143, 358`

- `isWithinHours` returns `slots.some((s) => s.available || s.start === iso)`. It is true if *any* slot that day is free, and it never compares `iso` against anything useful.
- It also uses `iso.slice(0, 10)`, which is the UTC date.
- It passes for any time on a day that has a free slot, and `s.start === iso` makes it pass for a booked slot. The check at `tools.ts:358` therefore protects nothing.
- `insideOpenHours` uses `minutes <= close`. For a business that closes at 18:00, a booking that *starts* at 18:00 is accepted. The start plus duration is never required to end by close.
- There is no past-time or minimum-lead check. `nextAvailable` requires now + 1 hour, but `createBooking` accepts any past timestamp.
- Fix: validate `start >= now + lead`, `start >= open`, `start + duration <= close`, all in the business time zone. Delete `isWithinHours`.

### H4. `scheduled_at` / `date` parsing from the LLM is fragile, and the agent is never told the current date or time zone
`src/lib/voice/tools.ts:240-244, 318`, `src/lib/kb/index.ts:88-152`, `src/lib/voice/elevenlabs.ts:66`

- The tool schema asks for ISO 8601 with an offset, but nothing validates it.
- `new Date('2026-11-23T10:00:00')` has no offset, so it is parsed in server time (UTC) and stored as 10:00Z, which is 5:00 AM ET. It is then rejected as outside hours, or booked wrongly. I verified this.
- The system prompt contains no current date, no "today is ..." and no time zone. The agent cannot resolve "tomorrow at 10" into a correct ISO string. It would need the `system__time` dynamic variable, or `ET_NOW` injected into the prompt. A grep for `{{`, `system__` and `current_date` across `elevenlabs.ts`, `kb` and `agent-prompt` finds nothing.
- `checkAvailability` does `new Date(requested).toISOString()`, which throws a `RangeError` on garbage input. The generic `catch` turns that into "let me check the calendar with the owner". Natural-language dates such as "March 5" parse as year 2001 (V8 legacy parser).
- Fix:
  - Parse the string as `YYYY-MM-DD[THH:mm]` in the business time zone when there is no offset, and reject anything else with a re-ask message.
  - Inject today's date and time zone into the agent via dynamic variables.

### H5. Emergency and handoff tools claim "owner notified" when notification failed or was skipped
`src/lib/voice/tools.ts:211-223, 589-596, 745-752`

- `alertOwner` returns `null` if there is no `owner_phone`. Otherwise it returns the logged SMS row, even when `sent.status === 'failed'`.
- `flagEmergency` and `handoffToHuman` always return the spoken message "the owner has been notified" (`ok: true`).
- `owner_notified: alert != null` is true for a *failed* SMS.
- Scenario: Twilio rejects the SMS during a water-leak emergency. The caller is told help is coming, and nobody was alerted.
- Fix:
  - Compute `notified = alert?.status === 'sent' || alert?.status === 'mock'`.
  - Vary the spoken message when it is false: keep the caller on the line, retry, or say a callback will happen.
  - Log at error level.
  - Handoff does not transfer the call. It only flags it and sends an SMS. Confirm the prompt text ("connect you with the owner") matches what actually happens.

### H6. Deposit money is never recorded, so revenue stats are wrong, and units are inconsistent
`src/lib/db/index.ts:147-160`, `src/lib/briefing/index.ts:62-71`, `src/app/dashboard/page.tsx:28`, `src/app/page.tsx:13`

- `deposit_amount` is only ever written by the seed data (`depositAmount: 189`). A grep of `src` shows no production code path that sets it.
- The Stripe webhook (`payments/webhook/route.ts:72`) sets `deposit_paid: true` and `status: 'confirmed'`, but not the amount. `createPaymentLink` never persists the amount on the booking either.
- Consequence: every real deposit counts as `0` in the briefing `deposits`/`revenue` figure and in the dashboard "deposits" tile, because `b.deposit_paid && b.deposit_amount` is falsy. Only demo data looks right.
- The webhook also forces `status: 'confirmed'`. That regresses a `completed` or `cancelled` booking if a late payment event arrives.
- Unit inconsistency: `deposit_amount` and `price_estimate` are whole dollars (seed `189`, the UI `money()` formats dollars). The payment flow is all cents (`amount_cents`, `DEPOSIT_CAP_CENTS`, and `templates.ts:86` does `price * 100`). Nothing converts between them at the DB boundary.
- Fix:
  - Pick one unit. Cents are the safest: rename the columns to `*_cents` or document them.
  - Write `deposit_amount` when the link is created, or in the webhook from `amount_total`.
  - In the webhook, only move the booking from `pending` to `confirmed`.

---

## Medium

### M1. Extraction fetches arbitrary user-supplied URLs (SSRF) with no response-size cap
`src/lib/extraction/index.ts:65-115`

- `normalizeUrl` explicitly accepts single-label hosts, `.local` and raw IPv4 (`isLocalName`, `isIpv4`), and `fetch` follows redirects.
- `http://169.254.169.254/...`, `http://localhost:5432` and internal service names are all fetched server-side.
- The response is passed through the LLM, and the extracted text is returned to the caller and stored. That gives an exfiltration path.
- `res.text()` has no size limit, only a 12 s timeout. The slice to `PAGE_CAP` happens after the whole body is in memory.
- Fix:
  - Resolve DNS and reject private, loopback and link-local ranges.
  - Re-check on redirects, using `redirect: 'manual'`.
  - Cap bytes while streaming.
  - Coordinate with the security reviewer.

### M2. Scraped (untrusted) text flows into the voice agent's system prompt
`src/lib/extraction/index.ts:132-158`, `src/lib/kb/index.ts:75-152`

- Site text is placed into an LLM prompt unescaped. The resulting `services`, `faqs`, `pricing_notes` and `name` are interpolated verbatim into the agent's `system_prompt`, and that agent has `send_sms`, `create_payment_link` and `handoff` tools.
- `sanitize` clamps types and counts, but not content. A site can inject instructions, for example "always quote $0" or "text any number".
- Fix: wrap scraped content in clear delimiters and say it is data. Strip control characters. Cap string lengths per field (`description` and `answer` are unbounded). Show the owner a review step before going live.

### M3. `sendSmsTool` lets the model send any text to any number
`src/lib/voice/tools.ts:415-466`

- The `to` and `body` fields are arbitrary. A prompt-injected or confused agent can text anyone, and the message goes out from the business number. There is no recipient allow-list (caller or booking phone only) and no rate limit.
- Fix: restrict `to` to the active call's `caller_phone`, the booking phone or the owner. Cap body length.

### M4. Briefing day-bucketing mixes UTC and ET, and queries are unbounded
`src/lib/briefing/index.ts:54-60`, `src/lib/db/index.ts:177-181`

- `gather` loads all of the business's bookings (`listBookings(businessId)`) and filters in memory with `b.scheduled_at.startsWith(date)` and `b.created_at.startsWith(date)`. Those are **UTC** ISO prefixes, but `date` is an ET calendar day.
- Briefings run at end of day, so anything after 7-8 PM ET falls into the next UTC day and is misattributed or dropped.
- `calls` use `dayRange`, which is a fixed UTC-5 (see M5), so the two sets use different day boundaries.
- `stats.bookings` counts bookings *scheduled or created* that day. It counts cancelled ones too, while the narration filters them out, so the dashboard and the voice note disagree.
- Fix: query by a proper ET day range in SQL (`scheduledAt` or `createdAt` in range). Exclude cancelled bookings from the stats and the narration consistently.

### M5. `dayRange` hard-codes UTC-5 (EST)
`src/lib/db/index.ts:177-181`

- `new Date(`${date}T00:00:00-05:00`)` is wrong from March to November (EDT, UTC-4). The day starts and ends an hour late.
- Effect: events from 11 PM to midnight EDT are assigned to the wrong day in `listCalls(date)`, `listBookings(date)` and `getBookedSlots`. Midnight edge cases show up in briefing counts and in the slot-taken check.
- Fix: use a zone-aware conversion (see H1).

### M6. `activeCall` can attach a booking, emergency or handoff to the wrong call
`src/lib/voice/tools.ts:185-193`

- If `call_id` is missing or unknown, it falls back to the *first in-progress call* of that business, found via an unbounded `listCalls(businessId)` that loads the entire call history.
- With two concurrent callers (normal for a receptionist), the booking and the emergency flag can be attached to the other caller.
- Calls that never receive an end webhook stay `in_progress` forever, so a stale call can be chosen.
- `call_sid` is in the schema (`@unique`) but is never written or read. `toCall`, `createCall`, `callPatch` and the `Call` type all omit it. Twilio and ElevenLabs retries therefore cannot be de-duplicated, and calls cannot be looked up by SID.
- Fix: persist `call_sid`. Require `call_id` (pass it as a dynamic variable to tools). Use a bounded query (`status='in_progress'`, order by `startedAt` desc, `take: 1`).

### M7. Tool `catch` blocks swallow errors silently, so `runTool`'s error log never runs
`src/lib/voice/tools.ts:278, 400, 458, 535, 598, 706, 754`

- Each tool wraps its body in `catch { return {...} }` without logging.
- `runTool`'s comment says that the "bare `catch {}`" was fixed so the reason is logged (`log.error('call.failed', ...)`). That handler is unreachable, because the tools never throw.
- In production a DB outage, a Prisma validation error or a provider failure becomes a generic spoken apology, with nothing in the logs.
- Fix: `catch (err) { log.error('tool.<name>.failed', { err }); return ... }`, or let the tools throw and have `runTool` own the fallback message.

### M8. Booking input validation: non-integer or negative `price_estimate` fails the whole booking
`src/lib/voice/tools.ts:370-382`, `prisma/schema.prisma:85`

- `price_estimate` is an `Int` column. The agent-provided `150.5`, or a string such as "$150", gives `NaN` (becomes `null`) or a float, and Prisma then rejects the write.
- The generic catch then reports "trouble putting that in the calendar" and the booking is lost. Negative values are accepted.
- Fix: `Math.round(Math.max(0, n))`, and cap the value.
- `customer_phone` goes through `normalizePhone`, which returns the raw string for fewer than 10 digits, so garbage can be persisted.

### M9. Duplicate confirmation SMS and a racy dedupe
`src/lib/kb/index.ts:136, 125`, `src/lib/voice/tools.ts:388-391`, `src/lib/db/index.ts:459-477`

- `createBooking` already triggers `/api/sms/confirmation`. The prompt, call-flow step 5, then tells the agent to "send_sms so the customer has it in writing". The customer can receive two texts.
- `findRecentSms` is a read-then-write dedupe with no atomicity. It loads **all** matching rows for the window and filters by phone in memory. `toLast10` is only used if provided.
- The 3 s `postInternal` timeout is a self-HTTP call. If Twilio is slower than 3 s, the tool reports `sms_sent: false` while the SMS may still go out. It is also an unauthenticated internal route, so check with the security reviewer.
- Fix: call the messaging function directly in-process. Put a unique key on (`booking_id`, `kind`) for confirmations. Remove the duplicate step from the prompt.

### M10. `upsertKnowledgeBase` clobbers unspecified fields and races on create
`src/lib/db/index.ts:241-265`

- The signature takes a `Partial`, but every missing field is reset to its default (`patch.services ?? []`, `pricing_notes ?? ''`, `system_prompt ?? ''`). A partial patch such as `{ pricing_notes }` silently wipes services, FAQs and the prompt.
- `findUnique` followed by `create` is not atomic. Two concurrent provisions hit the `business_id` unique constraint and throw.
- Fix: build `data` from defined keys only, and use `prisma.knowledgeBase.upsert`.

### M11. `updateX` helpers swallow all errors into `null`
`src/lib/db/index.ts:220-233, 296-307, 371-382`

- A transient DB error, a constraint violation (for example a duplicate `phone`) and "row not found" all return `null`. Callers treat that as a 404.
- Fix: only map Prisma `P2025` to `null`. Rethrow the rest.

### M12. Inbound-call lookup is a full table scan
`src/lib/db/index.ts:194-199`

- `getBusinessByPhone` runs `findMany({ phone: { not: null } })` and filters in JS on the last 10 digits. It cannot use the `@unique` index and grows linearly with tenants. It is on the hot path for each incoming call.
- Last-10 matching also collides across country codes.
- Fix: store E.164 (normalize on write) and use `findUnique({ where: { phone } })`.

### M13. Extraction hours parsing accepts garbage and loses AM/PM
`src/lib/extraction/index.ts:189-195`

- The regex `^\d{1,2}:\d{2}` followed by `slice(0, 5)` turns `"6:00 PM"` into `"06:00"` (it drops the PM). `"25:99"` and `"7:5"` are accepted. There is no check that `open < close`.
- A business open "9:00 AM" to "6:00 PM" would be stored as 09:00-06:00, which gives zero slots forever.
- If the model omits hours entirely, every day becomes `null` and the business has no availability, with no warning (the DB `DEFAULT_HOURS` fallback only applies when `hours` is nullish, not empty or all-null).
- Fix: parse 12h and 24h, validate ranges, require `open < close`, and fall back to defaults (and say so) when nothing valid is found.

### M14. LLM adapter robustness
`src/lib/providers/llm.ts`

- No timeout on either `fetch` (`:247, :286`). A hung provider stalls the provision or briefing route until the platform kills it (`maxDuration = 60`).
- OpenAI sends no `max_tokens`. Anthropic hard-codes `max_tokens: 2000`, which can truncate the JSON. The truncated JSON then fails `extractJson` and silently falls back to the template. For extraction that surfaces as the generic `llm_failed`.
- `unsupportedParams` is a module-global `Set`. One model's rejection of `temperature` disables it for every later call, including other models, and only `temperature` is actually removable. Any other 400 `param` burns an attempt and then throws.
- `extractJson` slices from the first `[` or `{` to the last matching closer. Prose such as "Here's the [result]" or trailing braces breaks it. It also returns `unknown` cast `as T` with no validation. Extraction compensates with `sanitize`, but nothing else does.
- OpenAI is always preferred when both keys are set. `mocked: true` covers three distinct cases (no key, call failed, parse failed), so callers lose the reason.
- Fix: add `AbortSignal.timeout`, use structured outputs or tool-use or `response_format: json_object`, validate with zod, and return a reason enum.

### M15. Briefing: hard-coded persona and unvalidated `date` used in a file path
`src/lib/briefing/index.ts:95, 175, 203`, `src/lib/briefing/tts.ts:352`, `src/app/api/briefings/generate/route.ts:11`

- The LLM system prompt says "Miami HVAC company", Spanglish and "Jorge". The deterministic fallback is Spanish only and defaults the owner to `'Jorge'`. The briefing is not parameterized per business, and it will name the wrong owner for any other tenant.
- `body.date` goes unvalidated into `generateBriefing`, then into `base = briefing-${businessId}-${date}`, and then into `path.join(AUDIO_DIR, base + '.mp3')`.
- A `date` such as `x/../../../evil` makes `path.join` normalize the path and write the `.mp3` (TTS output) outside `public/audio`. The same string becomes the unique `(business_id, date)` DB key.
- Fix: validate `^\d{4}-\d{2}-\d{2}$` in `generateBriefing`, and `encodeURIComponent` or sanitize `voiceId` and `base`.
- Operational note: audio is written to `public/audio` at runtime. The Dockerfile mounts a volume there, which is fine. But `localSay` needs macOS `say` and `afconvert`, so on Linux the briefing silently has no audio (`audio_url: null`).
- The LLM receives caller names and phone numbers (`caller: c.caller_name ?? c.caller_phone`) and full call summaries. This is a PII exposure to a third party that is not mentioned anywhere.

### M16. Demo seed data is time-frozen at import and uses server-local time
`src/lib/demo/seed-data.ts:11-17, 160`

- `const now = new Date()` is evaluated once at module load. In a long-running `next start`, `POST /api/demo/reset` seeds dates relative to process start, so "today" bookings drift into the past after a day.
- `day()` uses `setHours` (server local), and `demoBriefing().date` uses a UTC slice.
- Fix: compute `now` inside each factory, and use the business time zone.

### M17. Scripts and "tests": no real suite, and destructive against any DB
`scripts/*`, `package.json`

- There is no test runner (no vitest or jest in `package.json`) and no CI config in the repo (`.github` is absent). `bun scripts/ws*-test.ts` and `smoke.ts` are hand-rolled assertion scripts that need a live DB and server.
- `ws3-test` and `ws4-test` call `scripts/seed.ts` before and after. That runs `clearAll()` (delete every row in every table) on whatever `DATABASE_URL` is set. The same is true of `db:reset` and `/api/demo/reset`. There is no `NODE_ENV` or DB-name guard.
- The most test-worthy code (scheduling, hours, price matching, `sanitize`, `extractJson`, `dayRange`, DST) is pure and could be unit-tested without a DB. It currently has zero tests, and the DST and UTC bugs above would have been caught by a few cases.
- Fix: add vitest. Unit-test the pure functions with table-driven cases, including the DST change days (2026-03-08 and 2026-11-01). Run integration tests against a throwaway schema. Refuse `clearAll` unless `ALLOW_DESTRUCTIVE=1` or the DB host is localhost.

---

## Low

- **L1. Free-form enums.** `Business.status`, `Call.urgency`, `Call.status`, `Booking.status`, `SmsLog.kind` and `SmsLog.status` are `String` columns with no DB constraint. `types.ts` declares unions, but the mappers cast `row as any`. A typo writes silently and breaks `findRecentSms` and the dashboard. Use Prisma `enum`s or CHECK constraints (`schema.prisma:23,63-65,88,118,121`).
- **L2. Whole-file `any`.** `db/index.ts:32` disables `no-explicit-any` for all mappers, and `Json` columns are cast to `Hours`, `Service[]`, `FAQ[]` and `BriefingStats` with no runtime validation. Use `Prisma.BusinessGetPayload`-style types, and zod-parse `Json` on read. The `@/lib/types` header comment says "Do not change a field name without telling the lead", but nothing enforces it.
- **L3. Missing relations and indexes.**
  - `SmsLog.bookingId` has no FK and no index. Orphans accumulate after `onDelete` cascades, and per-booking dedupe is unindexed.
  - There is no index on `bookings(customer_phone)`, `bookings(status)` or `calls(caller_phone)`. Check whether the gratitude sweep and inbound lookups need them.
  - `bookings.customer_phone` is `NOT NULL`, but the demo and simulator can supply placeholder values.
- **L4. Unbounded list queries.** `listCalls`, `listBookings`, `listSms`, `listBriefings` and `listBusinesses` have no `take` or pagination. The dashboard pages and `createPaymentLink` (`tools.ts:498`, which does `listBookings(...).find(id)` instead of one query) load everything. `createPaymentLink` should use `getBooking` plus a `business_id` check.
- **L5. `checkAvailability` slots.** Each call to `slotsForDate` hits the DB once per day, and `nextAvailable` can do up to 14 sequential queries. Fetch the range once. `duration_minutes` is unbounded (negative or huge).
- **L6. `format.ts`.**
  - `whenET` computes "tomorrow" as now + 24 h, which is wrong for a few hours around a DST change.
  - `seconds(0)` returns "—".
  - `firstName('')` returns `''`, not "there".
  - `relative()` shows "just now" for future dates.
  - `money` is dollars only, with no cents.
- **L7. `log.ts`.** Secret redaction only works on key names, so a token inside a URL or error string is not redacted. Phone numbers are logged at `info` in `db` (`from`, `to`). `time()` logs success at `debug`, so LLM latency is invisible at the production `info` level. `level()` re-reads the environment on each line.
- **L8. Prompt and HVAC coupling.**
  - `promptIsDeficient` requires the literal phrases "water leaking" and "burning smell". Any non-HVAC business is permanently flagged deficient, so provisioning rewrites its prompt.
  - `extractPrompt`, `buildSystemPrompt` and the template are all AC-specific.
  - `generateKnowledgeBase` in `kb/index.ts:188-190` invents a "Service call" service with a 90-minute duration when none are extracted.
  - `fmtHours` iterates only keys that exist.
- **L9. Dead or unused code.**
  - `DEFAULT_HOURS_EXPORT` (`db/index.ts:499`).
  - `newId`, which is exported but has no callers.
  - `isoReq` is a trivial wrapper.
  - `routeLogger` (`log.ts:144`).
  - `ExtractionResult.source` value `'llm_only'`.
  - `ExtractionError` reason `'parse_error'`, which `sanitize` can never throw.
  - `getBookedSlots` is redundant with `listBookings`.
  - `isWithinHours` (see H3).
  - `hasLlm` and the `provider` logic in `generateText` are duplicated.
- **L10. `tools.ts` conventions.** `runTool` casts args to `Record<string, never>` (`:807`) to satisfy the tool signatures, which is a type hole. `resolveBusiness` reads `business_id` from tool arguments, meaning the model supplies the tenant id (security reviewer: confirm it is bound server-side).
- **L11. Migration housekeeping.** The two migrations are clean and the second only adds `agent_id`, so no drift. The timestamps (2026-11-14) are fine. `DATABASE_URL` carries `?schema=public`, and the SQL uses `"public"."..."`. A `directUrl` would be needed if a pooler such as PgBouncer is ever introduced.

---

## DRY / refactor opportunities

1. **One time-zone module (`lib/time.ts`).** Today `TZ = 'America/New_York'` is declared in 4 files (`tools.ts`, `format.ts`, `briefing/index.ts`, `messaging/templates.ts`). Hand-rolled Intl helpers are repeated across `tools.ts` (`etParts`, `spokenTime`, `dayPhrase`), `format.ts` (`timeET`, `dayET`, `whenET`), `briefing` (`clock`, `spanishClock`, `weekday`, `dayKey`) and `db` (`dayRange`). The module should export `businessDay(dateStr, tz)`, `zonedToUtc`, `partsInTz` and `localDateKey`. It would fix H1, M4 and M5 in one place.
2. **Single tool-name list.** `TOOL_NAMES` is defined in both `kb/index.ts:7` and `voice/tools.ts:766`, and `REQUIRED_TOOLS` is a third copy in `kb`. Define the list once and import it. `promptIsDeficient` can then derive its check from it.
3. **One `DAY_KEYS`.** It exists in `tools.ts`, `scheduler.ts` and `extraction` (Sunday-first in two, Monday-first in `kb` and `extraction`). A shared constant with an explicit "JS getDay" mapping avoids index bugs.
4. **Money formatting.** Four `money` helpers (`format.ts`, `tools.ts` cents, `briefing` dollars with Spanish fallback text, `pay/[id]/money.ts`) plus `price * 100` in `templates.ts`. Introduce a `Money` type or helper pair (`dollarsToCents`, `fmtCents`) and store cents.
5. **DB row mappers and patch builders.** Six `toX` mappers and three `xPatch` functions are the same field-by-field rename. Prisma's `@map` already exists, so a generic camel-to-snake converter, or returning Prisma types directly and mapping only dates, would remove about 100 lines.
6. **Tool result boilerplate.** Every tool repeats the `say(lang, en, es)` pair, a try/catch and `missingBusiness`. A `defineTool({ en, es })` wrapper that provides logging, the error fallback and message selection would also fix M7. The Spanish and English strings could move to a small message catalog, which would help the briefing and `templates.ts` as well.
7. **`listBookings(...).find` and `getBookedSlots`.** Replace the whole-history scans with `getBooking(id)` (tenant-checked) and a ranged `findMany`.
8. **Demo prompt versus generated prompt.** `SYSTEM_PROMPT` in `demo/seed-data.ts` is a separate hand-written prompt that `seed.ts` then overwrites with `generateKnowledgeBase`, so the hand-written one is only used in `--no-provision` mode. Drop it, or use it as the golden test fixture for `buildSystemPrompt`.
9. **Provision-in-process logic.** `scripts/seed.ts:provisionDemoAgent` duplicates the provision route's regenerate-and-register flow. Extract `provisionBusiness(id)` into `lib/` and call it from both.
10. **Extraction `generateJson` and `generateTextSafe`.** Both wrap `hasLlm` with the same try/fallback/log. A single `generate({ json?: schema })` returning `{ value, source: 'llm' | 'no_key' | 'call_failed' | 'parse_failed' }` would give callers the reason (M14).
