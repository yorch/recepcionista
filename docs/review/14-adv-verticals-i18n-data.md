# 14. Adversarial review: verticals, i18n, migrations, clearAll, resync-agents, jobs, env docs

Scope: `src/lib/verticals/*` and the vertical change flow, emergency/911 handling per pack, prompt injection through pack or KB, `src/lib/i18n/*`,
`PATCH /api/me/locale`, the `rc_locale` cookie, localized emails, migrations `20261201120000` and `20261202120000`, `clearAll`,
`POST /api/admin/resync-agents`, the new jobs (`reconcile`, `usage_warnings`, `google_calendar`), and `docs/env-vars.md` checked against the code.
This review did not repeat any finding from reports 05-13.

## How the claims were checked

- I created my own databases on 127.0.0.1:54329: `rev_vid14`, `rev_vid14b` and `rev_test_vid14`. I did not use `scratch`. All three were dropped afterwards.
- **Zero drift.** I applied all migrations to an empty database, then ran `prisma migrate diff --from-url <db> --to-schema-datamodel`. The result was an empty migration. A second `migrate deploy` said "No pending migrations".
- **Upgrade of a populated old-schema database.** I applied migrations up to `20261130120000` only and seeded old-schema rows:
  - a live business and an onboarding business;
  - an owner, a disabled staff member and an admin;
  - one finished call and one in-progress call.
  I then deployed `20261201` and `20261202`, ran the diff again (empty), and re-ran both SQL files by hand to confirm they can be applied twice.
  - The new columns got their defaults (`vertical='hvac'`, `locale='en'`, `closed_dates='[]'`).
  - Memberships were backfilled for owners and staff (the admin got none).
  - The business-delete trigger re-pointed a user who belongs to two businesses, as intended.
  - The consent guard skipped an insert for a call already marked declined.
- **Tests on `rev_test_vid14`.** `tests/db/clear-all`, `tests/db/locale`, `tests/db/migration`, `tests/integration/verticals` and `tests/integration/jobs` all pass: 56 tests.
- **Pure suites.** The i18n suites and `verticals-pure` all pass: 115 tests.
- **Repro scripts.** I ran small bun and psql scripts for findings M1 and M3 (results quoted below).

---

## M1. Post-call urgency scores the agent's own triage question, so nearly every triaged call is stored as "emergency" (Medium)

**Where**
- `src/lib/voice/postcall.ts:229-240`: `transcriptText` joins every turn, agent and caller, as `role: text`.
- `src/lib/voice/postcall.ts:251-261`: `inferUrgency` substring-matches the pack's `strong` keywords against that whole text.
- The result is stored at `postcall.ts:509` and `:592`.

**What goes wrong**
- Each pack's `emergency.triage` is the question the prompt orders the agent to ask on every call (call flow step 3, `kb/index.ts`).
- That question contains the same strong keywords:
  - dental: "severe pain? ... bleeding ... swelling";
  - plumbing: "sewage";
  - electrical: "sparks or a burning smell";
  - HVAC: "water leaking ... burning smell".
- So the agent's own question marks the call.

**Repro.** I ran `inferUrgency` through bun on one agent triage line plus a routine answer from the caller:

| Vertical | Caller's answer | Result |
| --- | --- | --- |
| dental | "No, just a routine cleaning please." | `emergency` |
| plumbing | "no, just a slow faucet." | `emergency` |
| electrical | "no, I want a ceiling fan installed." | `emergency` |
| hvac | "no, just a tune-up" | `emergency` |

**Impact**
- `calls.urgency` drives the dashboard Emergency badge, the briefing counts, and the urgency hint passed to the LLM summary.
- With almost every call marked emergency, real emergencies are lost in the noise.
- HVAC already had this on origin/main. This change copies the pattern into four packs. Dental and electrical are the worst cases, because their triage text is mostly strong words.

**Fix**
- Score only caller turns (`role === 'user'`) in `inferUrgency`. `transcriptText` can return both the joined text and the caller-only text.
- Add a regression test: an agent triage question followed by a routine answer must give `routine`.

## M2. Vertical change: a failed agent sync is silent and never retried, so the live agent keeps the old trade's emergency rules (Medium)

**Where**
- `src/lib/verticals/change.ts:38-47`: the sync outcome is `'failed'`.
- `src/app/api/businesses/[id]/route.ts:113-122`: the outcome is written only to the audit `meta`, and the response is just `publicBusiness(updated)`.
- `src/components/dashboard/vertical-settings.tsx:30-32`: the UI shows "saved".

**What goes wrong**
- `docs/verticals.md` says `failed` means "the next sync applies it". No next sync is scheduled:
  - `PUT /knowledge` does not call `syncAgent`;
  - there is no periodic agent sync;
  - only re-provisioning, a voice/settings change or the admin resync re-pushes the prompt.
- If `upsertKnowledgeBase` throws, the catch at `change.ts:45` hides it too. `businesses.vertical` is then new while `system_prompt` is still the old one.

**Scenario**
1. An HVAC business switches to Electrical.
2. ElevenLabs returns 5xx, or a timeout, on the PATCH.
3. The owner sees "saved".
4. The live agent keeps triaging with HVAC rules ("water leaking? no cooling?") instead of "sparking panel / downed line".
5. Post-call keywords and the 911 tool copy are now electrical, so the two halves disagree indefinitely.

**Fix**
- Return the `VerticalChangeOutcome` in the PATCH response and show a warning when `agent !== 'synced'`.
- Queue a retry: a `processed_events` claim, or an "agent_dirty" flag that a job drains.
- Write the business row and the prompt in one transaction, or roll the vertical back when the prompt rebuild fails.

## M3. Transcript consent trigger has a race: a declined call can keep transcript rows (Medium, privacy)

**Where**
- `prisma/migrations/20261201120000.../migration.sql:469-492`: `rc_transcript_consent_guard` is a plain `EXISTS` check with no row lock. `rc_call_declined_purge` is an AFTER UPDATE delete.
- `src/lib/db/transcript.ts:52-58`: the INSERT ... SELECT has the same unlocked check.

**What goes wrong**
- The transcript FK takes `FOR KEY SHARE` on the call row. An `UPDATE calls SET consent_status` takes `FOR NO KEY UPDATE`. These two locks do not conflict.
- So T1 inserts while consent is still `disclosed`, without committing yet.
- T2 sets `declined`. Its purge cannot see T1's uncommitted row, and T2 commits.
- T1 commits, and the row survives.

**Repro** (psql, two sessions): T1 `BEGIN; INSERT ... SELECT FROM calls WHERE consent_status <> 'declined'; pg_sleep(3); COMMIT` runs alongside T2 `UPDATE calls SET consent_status='declined'`. Afterwards `consent_status = declined` and 1 transcript row remains. The UPDATE did not block.

**Impact**
- This is exactly the mid-call objection case: `handoff_to_human consent_declined=true`, or `callerDeclinedRecording`, racing a `transcript-event` webhook or a live-poll append.
- Reads hide the row, because `transcript/route.ts` filters on `disclosed`.
- The row stays at rest until someone opens the transcript (`requestPoll` then purges it) or retention runs. That breaks the "no rows are ever stored" guarantee in `docs` and `transcript.ts:4`.

**Fix**
- In the trigger: `PERFORM 1 FROM calls WHERE id = NEW.call_id FOR SHARE;` before the `EXISTS`.
- Or add `FOR SHARE OF c` in the INSERT ... SELECT.
- `FOR SHARE` conflicts with `FOR NO KEY UPDATE`, so either the insert waits and sees `declined`, or the purge waits and sees the committed rows.

## M4. Admin resync can silently replace the live agent: a transient PATCH failure creates a new agent with no post-call webhook (Medium, plausible)

**Where**
- `src/lib/voice/elevenlabs.ts:640-669`: any non-retryable PATCH status, including 429 or 5xx, logs `recreating: true` and POSTs `/agents/create`. `rememberAgent` then repoints `businesses.agent_id`.
- `src/app/api/admin/resync-agents/route.ts:80-85`: `created` is counted as success.

**What goes wrong**
- The admin resync PATCHes up to 25 agents per request, 6 requests per minute, with no backoff. That is the load most likely to hit provider 429s.
- For each business whose PATCH fails transiently:
  - a new agent is created, and the DB now points at it;
  - the resync route never calls `bindPhoneNumber` or `registerPostCallWebhookOnAgent`, which provisioning does at `provision/route.ts:327-334`;
  - the old agent stays bound to the number with stale config, and later syncs update the orphan instead;
  - where the new agent does get used, it has no post-call webhook, so there are no summaries or transcripts and metering falls to the reconcile job.

**Fix**
- Only recreate on 404 from the PATCH. Treat 429 and 5xx as `failed`.
- In the resync route, report `created` as a warning and run the same bind and webhook-registration steps as provisioning.

## M5. `calls.metered_at` backfill marks in-flight calls as already metered, so their minutes are never billed (Medium, revenue)

**Where**
- `prisma/migrations/20261201120000.../migration.sql:370`: `UPDATE calls SET metered_at = COALESCE(ended_at, started_at) ... WHERE metered_at IS NULL`.

**Repro.** On the populated upgrade, the in-progress call (`ended_at` NULL, `status in_progress`) got `metered_at = started_at`.

**Impact**
- The post-call webhook for that call arrives after the deploy. `claimCallMetering` (`db/call-trust.ts:33`) finds `metered_at` set and skips.
- The reconcile job also skips it, because it lists only `metered_at IS NULL`.
- The same happens to webhooks that failed before the deploy and are retried after it.
- Origin/main metered in post-call (`recordCallSeconds`), so before the deploy these calls had not been metered.
- Every call in progress during the deploy window is lost from usage. That understates caps and billing.

**Fix**
- Backfill only calls whose post-call data was already stored: `WHERE metered_at IS NULL AND ended_at IS NOT NULL AND duration_sec IS NOT NULL`. Leave the rest for post-call or reconcile to meter.
- The re-runnable SQL has the same issue if it is re-applied by hand later: guard it with a cut-off timestamp.

---

## L1. A malformed `rc_locale` cookie breaks signup and invite acceptance (Low)

- `src/lib/i18n/core.ts:224` calls `decodeURIComponent` with no try/catch.
- `rc_locale=%` throws `URIError` (verified with node).
- Callers:
  - `signup/route.ts:75`: inside the try, so the answer is `503 signup is temporarily unavailable` and no account is created;
  - `accept-invite/route.ts:83`: inside the transaction, so it rethrows and returns 500.
- The cookie could come from a sibling subdomain (cookie tossing), a buggy proxy, or the user's own browser.
- **Fix:** wrap the decode in try/catch and return `undefined`, or skip decoding because the valid values are ASCII.

## L2. Post-call life-safety floor misses common phrasings (Low)

- `LIFE_SAFETY_STRONG` (`src/lib/verticals/index.ts:57`) is the only urgency signal for cleaning, landscaping and general.
- It lacks "huele a gas", the most common Spanish phrasing (the product's own Spanish 911 copy uses it). "huele a gas en la cocina" in an HVAC call gives `routine` (verified).
- It also lacks `smoke`/`humo`, sparks, "fuga de gas" and "electrocut".
- In the trade packs, these words are only partly covered, by `fuga` (HVAC) and `humo` (HVAC, electrical).
- A cleaning call with "smoke coming out of the outlet and sparks" gives `routine` (verified).
- `docs/verticals.md` says the list includes "fire", but only "on fire" and "house fire" are in it.
- This is a hint only, because a call the agent flagged as an emergency always wins. It does matter when the agent misses the flag.
- **Fix:** add `huele a gas`, `fuga de gas`, `smoke`, `humo`, `sparks`, `chispas`, `electrocut`.

## L3. A pack's own 911 sentence never reaches the prompt; it is only spoken after `flag_emergency` returns (Low)

- `buildSystemPrompt` (`kb/index.ts:130` onward) never includes `pack.emergency.call911`.
- The compliance block names home-services hazards only (gas, CO, fire, sparking, flooding).
- Dental's airway triggers ("trouble breathing or swallowing, swelling spreading across your face or neck") appear only inside the triage question. They are said as a 911 instruction only in the tool result (`tools.ts:773`), so after a tool round-trip, against the "911 FIRST, before any tool" rule.
- **Fix:** append `tx(pack.emergency.call911)` as a line of the EMERGENCIES section, telling the agent to say it first.

## L4. Concurrent vertical changes or KB edits can leave the prompt for a different vertical than the business (Low)

- `PATCH /businesses/:id` reads `before`, writes the business, then `applyVerticalChange` reads the KB and upserts the prompt. None of it is locked.
- Two quick changes (hvac to plumbing, then hvac to dental, from two tabs), or a concurrent `PUT /knowledge` that built its prompt from the old business row, can leave `vertical=dental` with a plumbing or HVAC prompt.
- `promptIsDeficient(prompt, vertical)` heals this only at provisioning.
- **Fix:** rebuild the prompt from a fresh `getBusiness` inside a transaction holding a lock on the business row, or compare-and-set on `knowledge_bases.updated_at`.

## L5. The "account already exists" security notice is in the attacker's language, not the account owner's (Low)

- `signup/route.ts:80` calls `sendSignupExistsNotice(email, localeOfRequest(req.headers))`.
- That uses the requester's cookie or Accept-Language, while the recipient's `users.locale` is known.
- An attacker probing an English-speaking user's address can make the warning arrive in Spanish, which makes it easier to ignore.
- `docs/i18n.md` says platform emails use the recipient's `users.locale`.
- **Fix:** look up the existing user's locale. Keep the timing constant by doing it inside `afterResponse`.

## L6. `usage_warnings` runs for every live business on every tick (Low, scale)

- `jobs/reconcile.ts:31-45`: every tick (default 60 s), and in every runner instance, the job runs 3 queries per live business (`getBusiness`, `getUsage`, `getUsageWarnings`).
- It also has no `withLease`.
- At 2,000 tenants that is about 6,000 queries per minute for a safety net.
- **Fix:** run it every 10-15 minutes behind a lease, and only for businesses whose usage counter changed since the last pass.

## Nits: docs vs code

- `docs/env-vars.md`, `OWNER_CALL_MAX_SECONDS` "30-300": a value under 30 falls back to 300, not to 30 (`voice/owner/config.ts:13`). Say "values outside 30-300 use 300 (above 300 is clamped to 300)".
- `src/lib/i18n/core.ts:7` header comment gives the order "user.locale -> business.locale_default -> Accept-Language" and leaves out the cookie. `resolveLocale` and `docs/i18n.md` both put the cookie second.
- `docs/verticals.md`, "The 911 floor": see L2 (the list does not contain "fire" on its own, nor smoke).
- Every environment variable that `src/` reads appears in `docs/env-vars.md`, and the new defaults match the code: `MAX_BUSINESSES_PER_USER` 1..100 with default 10, `LIVE_MAX_*`, `RECONCILE_*`, `NATIVE_TRANSFER` default off, `STIR_TRUST` and `LANGUAGE_DETECTION` default on, `WEBAUTHN_*`, `GOOGLE_*`, the `_ES` price texts.

## Checked and found sound (no finding)

- **Migrations.**
  - Zero drift on both a fresh database and an upgraded populated one.
  - Re-running both SQL files by hand works.
  - CHECKs are added NOT VALID and then validated.
  - The `block_on_busy` backfill key matches the audit writer (`integrations/google/settings.ts:8`, `meta.block_on_busy`).
  - The membership sync trigger never re-enables a disabled membership. The business-delete re-point works.
- **`clearAll`.** It deletes memberships before businesses, which avoids the re-point FK problem. It queues recording deletions in the same transaction. It is admin-guarded and only runs with `DEMO_MODE`.
- **i18n.**
  - No `dangerouslySetInnerHTML` on catalog text; the only use is a server-generated QR SVG.
  - Email params are HTML-escaped in `wrap` and in billing emails, and subjects are fixed catalog strings, so header injection is not possible.
  - Tenant names in invites go through `safeDisplayName`.
  - Spanish owner SMS alerts avoid accented characters, and `alertOwner` keeps them GSM-7.
  - `PATCH /api/me/locale` is CSRF-checked and whitelists the locale. The cookie value is only ever `en` or `es`, and `normalizeLocale` rejects anything else.
- **Packs.**
  - Static code, with no tenant data in them.
  - KB text stays inside `<untrusted_data>`, which strips its own delimiter.
  - Non-emergency packs still get the compliance 911 block and the `promptIsDeficient` marker ("does not run emergency dispatch").
- **`resync-agents`.** Admin-only, rate-limited, dry run by default, cursor pagination correct when combined with `business_ids`, audited without prompts.

---

## Resolution

Tests: `tests/review14-pure.test.ts`, `tests/integration/review14-data.test.ts`, `tests/db/migration.test.ts` (new populated old-schema upgrade test), `tests/db/locale.test.ts`.

| Finding | Status | How / test, or why it stays |
| --- | --- | --- |
| M1 urgency scores the agent's own triage question | **Fixed** | `callerTranscriptText` (caller turns only; legacy string transcripts drop `agent:` lines) feeds `inferUrgency`. Tests: pure (one per vertical) and "R14 verticals M1 end to end" (stored `routine` vs `emergency`). |
| M2 failed agent sync after a vertical change is silent and never retried | **Fixed** | `applyVerticalChange` returns `retry_queued`, the PATCH response carries `vertical_sync`, the dashboard shows a warning instead of "saved", and the business is flagged (`agent-dirty:<n>`); the `reconcile` job drains the flags with backoff (`voice/agent-resync.ts`), gives up loudly after 8 attempts. Test: "R14 M2" (503 -> warning + marker -> backoff -> recovery -> marker gone, no second agent). Residual: the generated call script is not retried (docs). |
| M3 transcript consent trigger race | **Fixed** | `rc_transcript_consent_guard` takes `FOR SHARE` on the call row first (new migration, `CREATE OR REPLACE`). Test: "R14 M3" (a decline now waits for the in-flight insert and its purge deletes the committed row; the reverse order skips the insert); migration test checks the function. |
| M4 admin resync silently replaces the live agent | **Fixed** | Only a 404 on the PATCH recreates an agent; 429 / 5xx / rejected body return `error: update <status>` and create nothing. The resync endpoint reports a created agent, binds the phone number, registers the post-call webhook and says so in `detail` / audit `created`. Test: "R14 M4". |
| M5 `metered_at` backfill marks in-flight calls as metered | **Fixed** | New migration step: calls whose `metered_at` equals the backfill signature and that have no `ended_at` or no stored `duration_sec` (and started within 3 days) are un-settled again, so post-call or reconcile meters them; the same repair runs for databases that already applied the phase-1 migration. The old migration file is left untouched (checksum). Tests: migration test on a populated old-schema database (m1..m4) and the phase-1 test (c2 now unsettled), re-run of the SQL, zero drift. |
| L1 malformed `rc_locale` breaks signup | **Fixed** | `localeCookieFrom` catches the decode error. Tests: pure + "R14 L5" in `tests/db/locale.test.ts` (signup with `rc_locale=%` succeeds). |
| L2 life-safety floor misses phrasings | **Fixed** | Added "huele a gas", "huelo gas", "fuga / escape de gas", "gas leak", "smoke coming", "sale humo", sparks / "chispas", electrocut..., "en fuego". Bare "fire" / "smoke" are NOT added (a smoke-detector install must not be an emergency). `docs/verticals.md` corrected. Test: pure. |
| L3 the pack's 911 sentence never reaches the prompt | **Fixed** | The EMERGENCIES section of every emergency pack carries "911 FIRST" with the pack's `call911` (EN + ES). Test: pure, one per vertical. |
| L4 concurrent vertical changes / KB edits | **Fixed (vertical changes), residual (KB saves)** | `applyVerticalChange` runs under a `vertical-change:<id>` lease and rebuilds from the CURRENT business row; a request that cannot get the lease is flagged for the retry job. Test: "R14 L4". A concurrent `PUT /knowledge` that built its prompt from an older business row can still lag until the next sync (unchanged; the retry job heals only flagged businesses). |
| L5 signup-exists notice in the attacker's language | **Fixed** | The notice uses the existing user's `users.locale` (looked up inside `afterResponse`, constant timing), falling back to the request locale. Test: "R14 L5". |
| L6 `usage_warnings` runs every tick | **Partly fixed** | Every 10 minutes (`USAGE_WARNINGS_EVERY_MS`) and behind a `usage-warnings-job` lease (one instance); the per-business pass is unchanged ("only changed counters" is not implemented, documented). Test: "R14 L6". |
| Nit: `OWNER_CALL_MAX_SECONDS` range text | **Fixed** | `docs/env-vars.md`: above 300 clamps to 300, missing / under-30 falls back to 300. |
| Nit: i18n core header omits the cookie | **Fixed** | Header comment corrected. |
| Nit: `docs/verticals.md` 911 floor list | **Fixed** | See L2. |

**Residual-gaps pass.** L6: the usage-warning job visits only changed businesses (+ retry list, daily full sweep). M2: the agent-dirty retry rebuilds the generated call script. See `docs/changelog-hardening.md`.
