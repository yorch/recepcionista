# Adversarial review, round 4

Scope: the last three commits on `claude/serene-clarke-fowr2c` (`dfc5026` round-3 fixes, `de88992` captcha, release, invites, sessions, `03083bd`
provisioning, job runner, SMS segments, trial caps, changelog). Baseline at `03083bd`: `npx tsc --noEmit` exit 0, and
`TEST_DATABASE_URL=.../scratch bun test` gave **577 pass, 0 fail** (51 files).

Every finding below marked VERIFIED was reproduced with a throwaway bun test against the scratch Postgres. The scripts live outside the repo, in the
reviewer's scratchpad (`r4/provision-cross.test.ts`, `cap-race.test.ts`, `owner-alert-bulk.test.ts`, `release-recent.test.ts`, `rel-norm.test.ts`,
`dst.test.ts`). They import the repo's own `tests/helpers/*` and use the same fake-fetch pattern as `tests/integration/provision-numbers.test.ts`.
Nothing under `src/` was changed.

## Findings

### F1 (High, VERIFIED): a failed purchase can adopt another tenant's live number, then DELETE it at Twilio

- `src/lib/providers/twilio.ts:205-217`: when the purchase answer is ambiguous (5xx or timeout), the code looks the *candidate* up in the account's
  `IncomingPhoneNumbers` and adopts it if it is listed. The account is shared by every tenant, so a listed number does not mean "this request bought it".
- `src/app/api/businesses/[id]/provision/route.ts:220`: every tenant searches area code `305`. Twilio's search returns the same first candidate to
  two tenants who provision at the same moment.
- `route.ts:237-242`: `businesses.phone` is `@unique`. Saving the adopted number fails with a unique violation, `updateBusiness` swallows it and
  returns `null`, and the route then calls `releaseNumber(phone)`. `releaseNumber` deletes the number on the shared account, which is the OTHER
  business's live line. Its own doc says "the caller must have checked that no other business uses the number", but nothing checks.

**Reproduction** (`r4/provision-cross.test.ts`): business A is `live` with `+13057770111`, and B has no number. Fake Twilio: the search offers
`+13057770111` (a stale result, because A bought it a moment ago), B's `POST IncomingPhoneNumbers` returns 503, and the reconcile `GET` lists
`+13057770111` (A's, sid `PN_A`). Result: B gets 502 `number_record_failed` and the calls include **`DELETE /IncomingPhoneNumbers/PN_A.json`**.
A's row still says `phone=+13057770111, status=live`, but the line is gone at the carrier. The same response also tells B "Nothing was purchased or
charged", which is wrong on the path where a number was bought and released.

The existing test `tests/integration/provision-numbers.test.ts:216` ("a bought number that cannot be saved is released") **asserts this behaviour**:
it gives a holder business the number and expects the `DELETE`.

**Fix:**
1. Adopt only a number that no business row holds (`getBusinessByPhone(candidate)` is null). Better, also require proof that this request bought
   it, for example by setting `FriendlyName=biz:<id>:<nonce>` on purchase and matching it on reconcile, or by checking `date_created` against the
   request start.
2. In the `!saved` branch, check whether another business holds `phone`, and never release a number that one does. Map P2002 to "number taken,
   retry" instead of releasing.
3. Fix the `retry` text for `number_record_failed`.
4. Rewrite the test at line 216 to expect *no* DELETE when another business holds the number.

### F2 (Medium, VERIFIED): the SMS cap is check-then-send, so concurrent sends blow straight through it

`src/lib/messaging/index.ts:101-130` runs `checkSmsAllowed` (a read), then sends, then `recordSms`. Nothing reserves the segments.

**Reproduction** (`r4/cap-race.test.ts`, with `BILLING_ENFORCED=true`): cap 5 segments, 4 already used, and 20 concurrent one-segment `sendAndLog`
calls. All **20 were sent and usage went to 24**. Parallel dashboard sends, parallel voice-tool texts or several app instances are enough to trigger it.

**Fix:** reserve before sending with one atomic conditional upsert, `UPDATE usage_counters SET sms_count = sms_count + $n WHERE ... AND sms_count + $n <= $cap RETURNING`,
inserting the row first. Refund the reservation if the provider send fails.

### F3 (Medium, VERIFIED): cap-exempt owner alerts can be pumped in bulk with long, caller-controlled text

- `flag_emergency` and `handoff_to_human` are `CAPACITY_EXEMPT_TOOLS` (`src/lib/voice/capacity.ts:71`).
- Owner alerts skip the cap (`messaging/index.ts:101`).
- `reason`, `address` and `customer_name` are only `trim()`med (`src/lib/voice/tools.ts:146`). There is no length cap, no per-call or per-hour
  limit on these alerts (only the missed-call alert has one), and no footer truncation, because owner texts never pass through `withStopFooter`.

**Reproduction** (`r4/owner-alert-bulk.test.ts`): cap 5 segments, enforced. Ten `flagEmergency` calls with a 1500-character `reason` gave
**10 texts and 240 segments metered against a cap of 5**. A caller can get the agent to call the tool repeatedly by prompt injection. The destination
is fixed (the verified owner), so the cost lands on the platform and the owner's phone is flooded.

**Fix:** clamp every free-text field in alert bodies (for example 160 characters each, 480 in total). Rate-limit owner alerts per call (1 per tool
per call) and per business per hour, as `allowMissedCallAlert` already does. Count exempt texts against a hard ceiling, for example 2x the cap.

### F4 (Medium, VERIFIED): a canceled tenant that still gets calls is never released by default

`src/lib/billing/release.ts:118` counts **every** call in the last 7 days. For a canceled tenant, each inbound call creates a `calls` row before
the gate (`src/app/api/voice/incoming/route.ts:78`), and the out-of-service line then marks it `handed_off` with `flagged_reason='out_of_service:no_plan'`.
One robocall a week therefore keeps the tenant on `skip` forever. The number, the agent and up to 60 s of agent time per call stay on the
platform's bill, which is the cost the release feature exists to stop.

**Reproduction** (`r4/release-recent.test.ts`): period ended 90 days ago, one out-of-service call today, result
`{"action":"skip","reason":"1 call(s) in the last 7 days (use --include-recent)"}`.

**Fix:** exclude `flagged_reason LIKE 'out_of_service:%'` (or count only calls made while billing allowed service) from `recent_calls`.

### F5 (Low, VERIFIED): `releaseNumber`'s platform-number guard compares raw strings

`src/lib/providers/twilio.ts:254`: with `TWILIO_PHONE_NUMBER="+1 305 777 0100"` or `"13057770100"`, a release of `+13057770100` passes the guard and
DELETEs the platform sender (`r4/rel-norm.test.ts`, which shows `DELETE /IncomingPhoneNumbers/PN_PLATFORM.json`). For this to happen, a business row
must hold the platform number (an admin edit or a seed). **Fix:** compare `toE164(env.TWILIO_PHONE_NUMBER)` with `toE164(number)`, and refuse when
either side cannot be parsed.

### F6 (Low, by inspection): a half-configured Twilio makes a release "succeed" as mock and orphans a real number

`twilio.ts:260` returns `{ok:true, mock:true}` whenever `TWILIO_PHONE_NUMBER` is unset, even when SID and token are present and the number is real.
`executeRelease` (`src/lib/billing/release.ts:187-189`) then clears the DB reference and pauses the business. The paid number stays on the account
and no row remembers it. The same applies to `deleteAgent` when `ELEVENLABS_API_KEY` was removed: a non-`mock_` agent id is reported as deleted.
**Fix:** treat "credentials incomplete but the number or agent is not a mock one" as `ok:false` (operator must fix config), never as mock success.

### F7 (Low, VERIFIED): segment counting undercounts when a 2-unit character straddles a segment boundary

`src/lib/messaging/policy.ts:98,100` uses `ceil(septets/153)` and `ceil(units/67)`, but an escaped GSM character (2 septets) or a UTF-16 surrogate
pair cannot be split across segments. `'a'*152+'€'+'a'*152` gives 2 (the real count is 3), and `'a'*66+'😀'+'a'*66` gives 2 (the real count is 3).
**Fix:** pack greedily per segment, the way carriers do. The `withStopFooter` 5-segment budget then holds too.

### F8 (Low): the scheduler re-reads the whole tenant table and history on every tick

- Every 60 s, `runDailyBriefings` and `runGratitudeJob` call `listBusinesses()` (all rows, all columns).
- After 18:00 local, each done business still costs 1-2 point queries per tick until midnight (`src/lib/jobs/index.ts:264-269`).
- Each hourly gratitude sweep loads the business's **entire** `sms_log` and `bookings` history (`src/lib/gratitude/index.ts:30,33`, unbounded
  `listSms` and `listBookings`).

This is already listed as Open (02 L4) in the changelog. Since F, it runs automatically for every live tenant. **Fix:** select only the needed
columns of due/live businesses in SQL, and restrict candidates to bookings in `[now-48h, now-20h]` plus gratitude rows for those phones.

### F9 (Low, docs): PRD.md contradicts the shipped job runner, and the changelog says PRD was reconciled

- PRD rows 146 ("manual sweep. Not scheduled"), 171 ("6 PM automatic briefing: Not built"), line 67 ("generates the day's briefing (on demand)"),
  §285-286 and row 308 all predate `03083bd` (PRD was last changed in `de88992`).
- `docs/changelog-hardening.md` 00#9 says "PRD reconciled; the 6 PM briefing and gratitude sweep now really run on a timer (F)".
- PRD row 80 still says "optional Turnstile" (it is now mandatory in production), and row 102 says "500 texts" (the cap is now 500 segments).
- PRD mentions neither release-canceled-tenants nor trial caps.

**Fix:** update those rows, or downgrade the changelog claim.

### F10 (Low): small config inconsistencies

- `JOBS` accepts `true/1/yes/on` in code (`src/lib/jobs/schedule.ts:21-32`), but `deploy.sh` dies on anything except `on`, `off` or empty, and the docs
  say `on/off`. Pick one.
- `SIGNUP_ALLOW_WITHOUT_CAPTCHA=true` together with `TURNSTILE_SECRET_KEY` set and no site key leaves signup "open (waived)", but
  `turnstileEnabled()` still demands a token that no widget can produce, so every signup fails `captcha_failed` (`src/lib/signup.ts:44`,
  `src/app/api/auth/signup/route.ts:53`). `deploy.sh` catches it, but a non-compose deploy does not. **Fix:** verify only when
  `signupAvailability().captcha === 'turnstile'`.
- Every tenant is provisioned in area code `305` (`provision/route.ts:220`), whatever its location. This is a product gap, and it is also what
  makes the F1 collision likely.

## Claims verified OK

- **Production mock-number guard:** `fakeNumberAllowed` needs `NODE_ENV!=='production'` AND no Twilio. The Dockerfile sets `NODE_ENV=production`
  (lines 69 and 102). A partial Twilio config in production gives 503 `not_configured`. A definite 4xx is not reconciled. A partial-failure retry
  reuses the stored number, so there is no second purchase (`provision-numbers.test.ts`, re-run).
- **Provisioning order:** 401 (auth), then 403 (staff/role), then 404 (another tenant's business), then 429, then the lease (409), then 402
  (billing, inside the lease). `force` is admin-only, and `phone` is not PATCHable by tenants (`src/app/api/businesses/[id]/route.ts` allow-list),
  so a tenant cannot clear its number to force a re-buy.
- **Jobs and `next build`:** the runner does not start at build. Next sets `process.env.NEXT_PHASE` during build
  (`node_modules/next/dist/build/index.js:1232`), `instrumentation.ts:91` guards on it, and `lib/jobs` has no import-time side effects.
- **Briefing catch-up:** only today's slot, until local midnight. There is no multi-day backfill after downtime.
- **Time zones and DST:** NY spring-forward and fall-back, Havana, Santiago, Lord Howe (30-minute DST) and the skipped Apia 2011-12-30 day all
  place 18:00 local correctly, and `nextBriefingAt` skips the nonexistent day (`r4/dst.test.ts`). An invalid zone falls back to the default.
  Tenants cannot edit `timezone` (settings route).
- **Job safety:** per-business lease plus a `processed_events` claim. A briefing that fails releases its claim. Manual runs use a separate
  `:manual` claim. The owner notice respects verified phone, quiet hours and cap, at most one per day. Gratitude respects quiet hours, billing and
  `live`, with hourly claims.
- **Job state growth:** bounded by the 30-day `processed_events` cleanup, and `markRun` refreshes `createdAt` so state rows survive.
- **Admin endpoints:** `/api/admin/jobs` and `/jobs/run` are admin-only. `dry_run` defaults to true there and in `/api/admin/release-tenant`, and the
  script defaults to a dry run. CSRF goes through `authenticate` (`session.ts:220`) and the proxy same-origin check for cookie POSTs.
- **Release safety:** only canceled or unpaid tenants; comp plans and later comp audits are skipped; shared numbers or agents are kept at the
  provider; the platform number is refused when the formats match (see F5); the notice is deduped per cancellation cycle (`notified_at >= since`); a
  release waits `notifyDays` after the notice; a provider failure keeps the DB reference for a retry. `_safe-db` blocks non-disposable DB names
  without `--force-i-know`.
- **Signup captcha:** availability depends only on `NODE_ENV` and env pairs. There is no header bypass. Invites are unaffected.
- **Invite acceptance:** token consumption and user creation are one transaction, and P2002 rolls the token back.
- **Session revocation:** 2FA disable is atomic with the session purge (MFA-pending sessions included); a role change purges sessions except the
  caller's own; disable purges all; password change and reset purge them too.
- **CSP:** `upgrade-insecure-requests` is on only in production with an https public origin, or when forced. Behind a TLS proxy with an https
  `APP_URL` it is on, which is correct.
- **Metering:** `recordSms` rejects negative values, segments are at least 1, and the trial cap is min(trial, plan) with overrides winning.
  Verification codes are counted but not capped (`verify-limits`). STOP/START/HELP replies are counted and never blocked; they can only be
  triggered by the inbound sender, who pays for the inbound text.
- **`docs/env-vars.md`:** every env name read in `src/` and `scripts/` (77) is documented, and every one is in `.env.example` apart from the
  Next-set flags. The doc's extra names (`DOMAIN`, `POSTGRES_*`, `APP_IMAGE`, `TOOLS_IMAGE`, `TRAEFIK_NAME`, `DATABASE_URL_OVERRIDE`) are
  compose/deploy variables, which is legitimate.
- **`docs/changelog-hardening.md`:** every cited path exists. Fifteen rows were spot-checked and match the tree:
  - 00#10: CI on `pull_request` only, with Postgres, tsc, eslint, build, migrate and test.
  - 01 L5: the "UUID" comment is still at `elevenlabs.ts:601`.
  - 02 L2: the eslint-disable is at `db/index.ts:47`.
  - 03#19: no lucide.
  - 03#13: `mobile-nav`.
  - 03#12: `aria-pressed`.
  - 02 M12: the indexes exist.
  - 01 M5: non-production fallback only.
  - 02 M15: "Jorge" is still there.
  - 03#21: robots only, no noindex.
  - 01 H2: `restrictions[completed_sessions][limit]`.
  - 02 L9: `DEFAULT_HOURS_EXPORT`.
  - DRY: `TOOL_NAMES` is declared twice.
  - 01 M7: timeouts.
  - Area F: no migration.
  
  The exceptions are 00#9 (see F9) and C4, whose cited test enshrines F1.
- **PRD "Shipped" rows** (10 spot-checked): the cited files exist and support rows 81, 83, 85 (reset uses `changePassword`, which revokes all
  sessions), 96 (`trialDays` 0-90, default 7), 97, 103 (`capacity.ts`), 105, 115, 126 (`firstMessageFor`), 129 (seven `TOOL_NAMES`) and 130
  (`verifyToolSecret`). The stale rows are listed in F9.

## Unverified suspicions

- **Twilio eventual consistency:** if a timed-out purchase is not listed yet on the immediate reconcile `GET`, the number is orphaned and the retry
  buys a second one. There is no delayed reconcile.
- **Lease loss in jobs:** job callbacks ignore the lease `AbortSignal`. If renewals fail for longer than the TTL (3 or 5 minutes), a second runner
  can enter while the first is still generating or sweeping. The claims mostly cover this, and gratitude itself dedupes.
- **`completeEvent` never throws:** if the briefing's `done` write silently fails, the claim expires after 10 minutes. The briefing is
  regenerated (LLM and TTS cost) and the owner texted again, unless a pre-18:00 row was missing.
- **No lock around a release:** the script and the admin API can run concurrently and send two heads-up mails, or race a provisioning call.
  Facts are loaded once and not re-checked before the provider deletes (a reactivation webhook in that window still gets released).
- **Cached tool ids:** `deleteAgentTools` clears only the in-process `toolIdCache`. Other instances may keep stale tool ids and register agents
  against deleted tools.
- **Dev only:** mock-pool numbers have 9000 suffixes per area code, so collisions in a dev DB with many businesses are likely. They surface as
  `number_record_failed`.
