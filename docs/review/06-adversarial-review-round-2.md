# 06 — Adversarial review, round 2 (branch `claude/serene-clarke-fowr2c`)

Scope: `git diff origin/main` (107 files): Postgres shared state (rate limiter, leases, processed events),
compliance (disclosure, consent, STOP, quiet hours, retention, erase/export, 911), per-tenant auth, the
integration suite and Docker hardening. Prior context: `05-adversarial-review.md`.

PoC scripts are in the reviewer scratchpad
(`/tmp/claude-0/-home-user-recepcionista/59b1eb07-88a1-5d65-bce8-a60fd41cc4aa/scratchpad/*.ts`). They import the
real modules and run against the scratch Postgres (`postgresql://postgres@127.0.0.1:54329/scratch`). Each one
creates and deletes its own tenants. The run command is
`cd /home/user/recepcionista && DATABASE_URL=postgresql://postgres@127.0.0.1:54329/scratch bun <script>`.

## Baseline

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `bunx eslint src tests` (the CI step) | pass (1 warning, `shell.tsx:36` `window.location.href`) |
| `bunx next build` (the CI env: dummy DB URL, `ADMIN_TOKEN`) | pass |
| `TEST_DATABASE_URL=…/scratch bun test` | **174 pass, 0 fail**, 18 files |
| `bun test` without `TEST_DATABASE_URL` | 105 pass, **83 skip**, exit 0 (see L5) |
| `prisma migrate diff --from-migrations … --to-schema-datamodel … --shadow-database-url <fresh db> --exit-code` | `No difference detected.`, exit 0 |
| Upgrade path: old schema (init + agent_id) seeded with realistic rows, then `prisma migrate deploy` for the ×100 money, agent dedupe and new migrations | applies cleanly. Cents ×100 OK, `stats.revenue` ×100 OK, the duplicate `agent_id` was nulled on the newer business, defaults filled (`retention_days=365`, `consent_status='unknown'`) |

---

## High

### H1. A caller who declines recording still gets a full transcript stored, and that call is marked `disclosed`
- **Where:** `src/lib/voice/postcall.ts:340-365` matches the post-call webhook to a call in three ways: by `call_id`, by `getCallBySid(conversationId)`, or by the "single unambiguous live call" heuristic. If none of these matches, it creates a **new** call row. The declined check at `:375` only looks at the matched row. `src/lib/voice/tools.ts:822` (`handoffToHuman`) keys the row it creates or marks by `callKey(args)`, which is `call_sid || conversation_id`, so a phone call is keyed by the Twilio `system__call_sid`, never by the conversation id. `src/app/api/voice/incoming/route.ts:63` creates the call **without `call_sid`**, so the tool cannot find that row and creates a second one.
- **Failure:** The lookup by conversation id misses. The heuristic then sees two candidates (the incoming row and the tool row, or another concurrent caller), logs `ambiguous_call` and creates a fresh row with the whole transcript. `disclosedInTranscript` (`postcall.ts:417`) then marks that row `consent_status='disclosed'`. It does so because the regex `\b(recorded|grabada)\b` matches the **caller's** sentence "I don't want to be recorded".
- **Repro** (`declined-leak-single.ts`: one call through `/api/voice/incoming`, `handoff_to_human` with `consent_declined=true`, then the post-call webhook):
  ```
  │ 015448a7… │ null               │ disclosed │ undefined                                    │  <- incoming row
  │ 99cc0960… │ CA_declined_5jlh71 │ declined  │ undefined                                    │  <- tool row
  │ 15b26f7b… │ conv_5jlh71        │ disclosed │ agent: This call may be recorded.
                                                 user: I don't want to be recorded. M…        │  <- LEAK
  ```
  `declined-leak.ts` shows the same leak on the ElevenLabs-native path whenever a second caller is live for the same business.
- **Impact:** This defeats the headline Florida all-party-consent control in `docs/compliance.md` ("Declined calls: post-call processing stores no transcript…"). It also records a false `disclosed` status, and the dashboard shows a phantom duplicate call.
- **Fix:**
  - Store `call_sid` in `/api/voice/incoming` (Twilio `CallSid`).
  - Have tool-created rows store **both** keys. Add a `conversation_id` column, or look up by `callSid IN (conversation_id, call_sid)`.
  - In post-call, also match `metadata.phone_call.call_sid` (or the equivalent field) and `dynamic_variables.system__call_sid`.
  - When the call is ambiguous or unmatched, **never** create a row that holds the transcript. Store metadata only, or check whether any row for this business in the window is `declined` and fail safe.
  - Match the disclosure regex only on `role === 'agent'` turns.
  - Add an integration test for the declined path through `/api/voice/incoming`.

### H2. Voice tools regression: the platform caller id was dropped, so texts go to the number the LLM relays, and the per-call booking cap does not apply
- **Where:** `src/lib/voice/tools.ts:364` (`bookingPhone = call?.caller_phone || phone`), `:477` (`callerPhone = call?.caller_phone || ''`) and `:573`. On `origin/main` these were `call?.caller_phone || str(args.caller_phone)`, with `args.caller_phone` bound to `system__caller_id` (`elevenlabs.ts:270`, documented as trusted at `tools.ts:46`). The cap in `src/lib/db/index.ts:455` is applied only `if (input.call_id)`. `createBooking` never creates a call row, and on the ElevenLabs-native path no row exists until `handoff` or `flag_emergency` runs. The rows those two create (`tools.ts:641,822`) also never store the caller id.
- **Repro:**
  - `caller-id-regress.ts`: with a platform caller id of `+13055550142` and an LLM-relayed `+13055559999`, the booking is stored with `+13055559999` and the confirmation SMS goes to `+13055559999`. `send_sms` to the caller fails: "I do not have a number I can text from here".
  - `cap-bypass.ts`: one conversation (same `conversation_id` and `call_sid`) gets **6 of 6 bookings** (cap is 2), and the confirmation texts go to six different attacker-chosen numbers (`+17865551008…13`).
- **Impact:** This reopens 05/H3. A caller can make the business's Twilio number text arbitrary third parties, one SMS per slot with LLM-written `service`/`address` text, and can flood the calendar. Texting the real caller is broken on the native path.
- **Fix:**
  - Restore the `args.caller_phone` (`system__caller_id`) fallback before the model's `customer_phone`.
  - Upsert a call row on the **first** tool call of a conversation (keyed by `call_sid`/`conversation_id`, storing `caller_phone` from `system__caller_id`), so the cap and the matching always have a row.
  - Enforce the cap per `conversation_id`/`call_sid` even when `call_id` is null.

### H3. 50 junk logins every 5 minutes lock every tenant out of password login
- **Where:** `src/app/api/auth/login/route.ts:34` calls `limitRequest(req,'auth/login',10,5min,{failClosed:true})`, and `src/lib/ratelimit.ts:103` adds a **global** bucket `auth/login:*global*` of `limit*5` = 50 per 5 min. That bucket is checked before the credentials and is shared by every account and tenant. The per-account bucket (`login/route.ts:63`, 10 per 15 min) counts before the password check, so it also locks out a known email.
- **Repro** (`login-dos.ts`, `TRUSTED_PROXY=true` as in production compose):
  ```
  A) victim, correct password, own fresh IP -> 429 {"ok":false,"error":"rate limit exceeded"}   (10 bad guesses at the victim's email from 2 IPs)
  B) victim after 60 junk logins from 6 IPs -> 429 {"ok":false,"error":"rate limit exceeded"}   (random emails)
  ```
  Without `TRUSTED_PROXY` (any deployment other than the compose file) every client shares the `untrusted` key, so **10** requests lock everyone out.
- **Impact:** A trivial, platform-wide denial of dashboard access. The admin-token path shares the same buckets. `docs/auth.md` documents the per-account lockout but not the global one.
- **Fix:**
  - Use the global bucket only as a high circuit breaker (thousands, not 50), or drop it now that per-IP and per-account buckets exist.
  - Count only **failed** attempts per account, and reset on success.
  - Key the per-account bucket on (account, IP /24 or /64) with a separate, much higher account-wide ceiling.
  - Consider progressive delay instead of a hard lockout.
  - Keep the break-glass token on its own bucket.

---

## Medium

### M1. Opt-out bypass: an owner can text a customer who replied STOP by re-pointing `owner_phone`
- **Where:** `PATCH /api/businesses/:id` (`src/app/api/businesses/[id]/route.ts:21`) lets any **owner** set `owner_phone` to any E.164 number. It was admin-only on `origin/main`. `policy.ts:30` classifies `owner_alert` sent to the owner phone as `owner`, which is exempt from opt-out and gets no footer. `POST /api/sms/send` accepts `kind` from the body, including `owner_alert` (`sms/send/route.ts:12-14,54`).
- **Repro** (`optout-bypass.ts`):
  ```
  1. normal text to opted-out customer : 200 status=blocked_opt_out footer=false
  2. PATCH owner_phone = customer      : 200
  3. same text as kind=owner_alert     : 200 status=mock footer=false   (status 'sent' with Twilio configured)
  ```
- **Related (verified by reading the code):**
  - `sms/send` also takes `consent_basis` from the body. `{kind:'review_request', consent_basis:'express_opt_in'}` satisfies the marketing gate by assertion alone.
  - `kind:'other'` (the default) is "customer" class, which has **no quiet-hours** check, so free-text promotions go out at 3 am.
  - `messaging/actions.ts:53` hard-codes `consent_basis: 'booking_followup'` for every gratitude text. `blocked_no_consent` is therefore unreachable on the real gratitude path, and the "recorded consent basis" control is vacuous.
- **Fix:**
  - Do not accept `kind` or `consent_basis` from tenant callers. Free text is always `other` and goes through the full customer/marketing policy, quiet hours included.
  - Only an admin may change `owner_phone`, or require a re-verification SMS to the new number.
  - Classify as `owner` only when `kind === 'owner_alert'` comes from server code, never from the HTTP API.
  - Derive the gratitude consent basis from stored data, not a constant.

### M2. `POST /api/sms/payment-link` lets any owner text arbitrary free text to any number
- **Where:** `src/app/api/sms/payment-link/route.ts:37,47-53`. `to` is unrestricted: there is no known-contact check like `sms/send` has. `description` is owner free text and becomes the SMS body via `paymentLinkSms(... service: description)` (`messaging/actions.ts:71-86`). The route was admin-only (`guardAdmin`) on `origin/main` and is now `owner`. The IDOR sweep showed that a cross-tenant `booking_id` is refused (404) but `to` is not checked at all.
- **Impact:** Each tenant gets an SMS-pumping and phishing primitive on the platform's Twilio account: 10 per minute per client, 50 per minute globally, with the business name as prefix and a real payment URL.
- **Fix:** Send only to `booking.customer_phone`, or apply the same known-contact check as `sms/send`. Make `booking_id` mandatory for tenants and cap `description`, or drop it for tenants.

### M3. Erasure and access requests miss PII held in owner alerts, briefings and audio files
- **Where:** `src/lib/db/compliance.ts:113-140` and `src/lib/privacy.ts` match only `calls.caller_phone`, `bookings.customer_phone` and `sms_log.to_phone`. Owner alerts contain the customer's name and phone in the **body** (`tools.ts:658-660,834-836`, `gratitude-reply/route.ts:72-76`, `payments/webhook:113`). `briefings.transcript` and `stats` summarise callers. Briefing MP3s live at `public/audio/briefing-<business>-<date>.mp3`.
- **Repro** (`erase-purge.ts` on an upgraded DB):
  ```
  erase b1 { calls: 2, sms_logs: 1, bookings_anonymized: 2 }     (tenant b2's matching call untouched: correct)
  owner_alert bodies after erase: [ "New booking: Ana +13055550142 AC repair" ]
  briefing transcripts after erase: [ "Ana called about AC" ]
  ```
- **Fix:**
  - Also delete or redact `sms_log` rows whose `body` contains the phone digits or the booking's name (owner alerts carry `booking_id`, so use it).
  - Regenerate or delete the briefings for the affected days and delete their audio files.
  - Include these items in the export.
  - Fix the comment and docs that still say "Admin only": `privacy/*/route.ts:7,8`, `compliance.md`.

### M4. Retention: the first boot after upgrade silently deletes everything older than 365 days, and audio files are never purged
- **Where:** The migration adds `retention_days DEFAULT 365` to every existing business. `src/instrumentation.ts` then starts `startRetentionJob()` unconditionally, and its first run is 2 minutes after boot (`retention-job.ts:17,30`). `RETENTION_JOB` does not appear in `.env.example`, README or DEPLOY.md, and nothing there mentions retention. `purgeExpiredData` deletes `briefings` rows but not `public/audio/*.mp3`, and those files are served without auth (`proxy.ts` matcher excludes `audio/`).
- **Repro:** On the upgraded scratch DB, a call 400 days old was deleted and its booking anonymised by the first purge: `{ calls: 1, bookings_anonymized: 1 }`, `k9 | [redacted] | '' | 2026-11-23 17:45`. The only safety net is `deploy.sh`'s pre-deploy `pg_dump`.
- **Fix:**
  - Default existing rows to "no automatic purge" (nullable `retention_days`, or a migration that sets 3650) until the operator opts in.
  - Document `RETENTION_JOB` and log a dry-run count on first start.
  - Delete the audio files for purged briefings, and serve audio through an authenticated route instead of `public/`.

### M5. STOP handling does not receive STOPs when deployed as documented, and misses FCC "reasonable means" revocations
- **Where:** `DEPLOY.md:108` still tells operators to point the Twilio number's SMS webhook at `POST /api/sms/gratitude-reply`. A number has only one inbound-SMS URL, and `gratitude-reply` has no keyword handling: `Body="STOP"` gives `422 rating must be a number`. So `/api/sms/inbound` never runs and `sms_opt_outs` stays empty. `keywords.ts:8` matches the whole message only. Results from `bun -e` against `parseKeyword`:
  ```
  "Stop texting me" null | "STOP 🛑" null | "ＳＴＯＰ" null | "Opt out" null | "OPTOUT" null | "REVOKE" null | "\"STOP\"" null | "Parar" null
  "Yes" start | "yes!" start      <- any "yes" re-subscribes a STOPped number
  ```
  The FCC's 2024 TCPA revocation order (in force April 2025) treats replies using words such as stop, quit, end, revoke, opt out, cancel or unsubscribe as revocation.
- **Fix:**
  - Use one inbound-SMS route: `/api/sms/inbound` handles keywords first, then dispatches ratings to the gratitude logic. Update DEPLOY.md.
  - Add `REVOKE`, `OPTOUT`/`OPT OUT`, and Spanish `PARAR`/`ALTO`/`BAJA`. Apply NFKC normalisation and strip quotes and emoji.
  - Treat a message that **contains** a stop word as an opt-out, or at least flag it to the owner.
  - Do not treat a bare `YES` as re-subscribe unless it answers an opt-in prompt.

### M6. The custom disclosure is not validated, but every incoming call is still recorded as `disclosed`
- **Where:** `src/lib/kb/disclosure.ts:19-23` and `settings/route.ts:55-60` accept any text up to 300 characters ("Hi!" passes). `firstMessageFor` (`elevenlabs.ts:137-141`) then speaks that text **instead of** the AI and recording notice. `voice/incoming/route.ts:66-68` hard-codes `recording_disclosed: true, consent_status: 'disclosed'` before anything is spoken. The prompt (`kb/index.ts`, `complianceRules`) tells the agent that the opening sentence *is* the standard notice, which is false once the text has been overridden.
- **Fix:**
  - Always prepend or append the platform notice, so a custom text can extend it but not replace it. Otherwise require the custom text to mention both AI and recording, in each language served.
  - Set `disclosed` only after the agent's first turn is observed.
  - Re-sync the agent when the settings change. *Unverified* whether the native ElevenLabs path (no `/api/voice/incoming`) picks up the new first message before re-provisioning; the UI says "applies from the next call".

---

## Low

- **L1. `_safe-db` regressions and bypasses (verified):**
  - `deploy.sh --seed --i-know-this-wipes-data` is now broken. The seed container gets `DATABASE_URL=…/recepcionista` (`.env.example:56`), and `assertSafeDatabase` exits 2: `[seed] REFUSING to run: database "recepcionista" …`. `deploy.sh:112` does not pass `--force-i-know`.
  - `bun run db:reset` (`package.json:19`) runs `prisma migrate reset --force` against **any** DB before the seed guard runs.
  - The substring match accepts names like `recepcionista_prod_latest`, `contest_production` and `localhost_prod`, all `true`.
  - **Fix:** Pass the flag from `deploy.sh` (it already asks for consent), put the guard in a pre-step of `db:reset`, and match whole tokens (`(^|_)(dev|test|scratch|local)($|_)`).
- **L2. `withStopFooter` can produce invalid UTF-16, and its ellipsis forces UCS-2 (verified).**
  - `withStopFooter('a'.repeat(275)+'😀'.repeat(20))` leaves a lone `\uD83D` (`isWellFormed() === false`).
  - `…` (U+2026) is not GSM-7, so every trimmed message switches to UCS-2: 300 characters become 5 segments instead of 2.
  - Any body containing "text stop" or "reply stop" suppresses the footer, and tenant free text can include it (M1).
  - **Fix:** Cut on code points or graphemes, use `...`, budget by GSM-7/UCS-2 segment count, and match only the exact footer.
- **L3. `claimEvent` loses events if the process dies between claim and completion** (`events.ts`; `payments/webhook/route.ts:66-77`, `postcall.ts:302-316`). Every retry is then answered as a duplicate. **Fix:** Store `status = processing|done` with `claimed_at`, and let a retry take over a `processing` claim older than N minutes. 05/L9 (the post-call webhook returns 400 for conversations of unrelated agents) is still open, and those 400s now also release the claim on every retry.
- **L4. `withLease` never tells `fn` that the lease was lost** (`locks.ts:62-77`): a renewal returning `false` is ignored. During a DB stall longer than 90 s, a second `provision` can buy a second number. **Fix:** Pass an `AbortSignal` that fires when renewal fails, and check it before each paid provider call.
- **L5. DB tests skip silently.** Without `TEST_DATABASE_URL`, 83 tests skip and the run still exits 0. CI sets the variable today, but a renamed secret or env would turn CI green with no DB coverage. **Fix:** In `preload.ts`, throw when `CI=true` and `TEST_DATABASE_URL` is unset. No test covers H1 or H2.
- **L6. Migration:** The CHECK constraints on `businesses` and `calls` are added validated, which takes an ACCESS EXCLUSIVE lock and a full scan (fine now, slow on a large `calls`). The unguarded `ADD CONSTRAINT` statements make a hand re-run fail. There is no documented rollback; the `pg_dump` in `deploy.sh` is the only path back. **Fix:** Use `NOT VALID` followed by `VALIDATE CONSTRAINT`, and add a short rollback note to DEPLOY.md.
- **L7. Staff can read the full stored `system_prompt`.** `GET /api/businesses/:id` returns `knowledge_base` to staff, while `/api/voice/agent-prompt` is owner-only. Prompts stored before this branch still contain `Owner: <name> (<owner_phone>)`, which undoes `publicBusiness()`. **Fix:** Strip `system_prompt` for staff, and run a one-off migration that rewrites stored prompts.
- **L8. Still open from before:**
  - The `rc_session` admin cookie is a deterministic HMAC that never expires server-side (05/L7).
  - `GET /api/voice/incoming` is public and returns the tenant count.
  - `/api/voice/incoming` routes calls to an unknown `To` number to the **first** tenant (`incoming/route.ts:50`).
  - Briefing audio is served without auth at a predictable `/audio/briefing-<business uuid>-<date>.mp3`; you need the business UUID to fetch it.
- **L9. Docs drift:**
  - `docs/auth.md` says `/` "still renders the first business's aggregate numbers"; it no longer does.
  - `docs/compliance.md` and the route comments say erase/export are "admin", but they are owner+.
  - `README.md`, `DEPLOY.md` and `.env.example` say nothing about retention (M4) or the inbound SMS URL (M5).
- **L10. The declined-consent reply asks for personal data.** `tools.ts:847` says "What's the best number to reach you?", which contradicts the prompt rule "do not ask for or repeat further personal details".

---

## Claims verified OK

- **Tenant isolation (`idor-sweep.ts`, 25 cases, a real DB session cookie):** owner A gets 404 on every path, query and body that names tenant B. That covers privacy erase/export, business GET/PATCH, settings GET/PATCH, knowledge PUT, briefings GET/generate, `sms/send` with B's id, `sms/confirmation` and `sms/gratitude` with B's booking, `create-link` with B's booking, `agent-prompt` and `gratitude/run`. Owners get 403 on `admin/users`, `businesses` POST, `provision`, `extract` and `demo/reset`. Staff get 403 on settings PATCH, erase and `sms/send`. Tenant B's data was unchanged afterwards.
- **Role escalation:** `POST /api/admin/users` is admin-only and accepts only `owner`/`staff`, and DB CHECKs back up role and business. Admin users can only be created with the CLI.
- **`rc_business`:** read only for admin principals (`dashboard-context.ts:34-47`). A tenant setting it has no effect.
- **Sessions:** a 256-bit token, only its sha256 stored. Logout deletes the row. Disabling a user or changing the password revokes sessions. Expired sessions are deleted on read. The token is rotated at every login, so there is no fixation. Cookie flags: HttpOnly, Lax, Secure in production.
- **Login enumeration:** unknown email, wrong password and disabled account take the same scrypt path and return the same 401.
- **CSRF:** cookie-authenticated non-GET requests need `Sec-Fetch-Site: same-origin` or a matching `Origin` in both the proxy and `authenticate()`. `same-site`, `null` origin and a missing header are refused. Content type does not matter. No GET handler has side effects, and there are no server actions.
- **Proxy:** every non-public route handler calls `authenticate`/`guardAdmin`, so a forged but well-formed `rc_user_session` passes the proxy and is rejected in Node. `/login?next=` uses `safeNextPath` (05/M2 fixed), and `/` no longer renders tenant data (05/L1 fixed).
- **Rate limiter math:** an atomic upsert plus a weighted previous window, on the DB clock. Cleanup (3 h) is safely past the largest window (1 h × 2). Keys are bounded (route + IP ≤ 64 chars, or a hashed email). XFF uses the right-most hop only with `TRUSTED_PROXY=true`.
- **Lease acquire:** a single `INSERT … ON CONFLICT … WHERE expires_at <= now RETURNING`, so two holders cannot acquire an unexpired lease. Release is holder-scoped.
- **Retention SQL:** correct per tenant, with UTC handling for `timestamp(3)` columns. A booking's FK to a purged call is SET NULL, so the transaction does not abort. Opt-outs are kept.
- **Erasure scoping:** per business and per last-10 digits, rejecting fewer than 7 digits. Another tenant's matching rows were untouched.
- **Migrations:** no Prisma drift, and the full chain applies over realistic old data (above).
- **CI workflow:** valid. The Postgres service, `migrate deploy`, the `recepcionista_test` name guard and the `bunfig` preload all work. `next build` and lint now run. Locally, build, lint and typecheck pass.
- **Disclosure text XSS:** none. It is rendered by React as text and is never inserted into the system prompt, only into `first_message`.
- **911:** the `CALL_911_*` sentence is in all three `flag_emergency` outcomes, and the prompt rule comes after the FAQ block.

## Unverified suspicions (not proven here)

- Behind Cloudflare or another CDN in front of Traefik, the right-most XFF hop is the CDN's address, so all users share one per-IP bucket, which makes H3 worse.
- On the ElevenLabs-native number path, a disclosure change (M6) and the compliance block are not pushed to agents that already exist until someone re-provisions. Existing live agents keep the old first message, with no disclosure, after this deploy.
- Next's handling of `public/audio` files written at runtime in the standalone image. Docs suggest only build-time public files are served, which may mean briefing audio 404s in Docker.
- With Twilio Advanced Opt-Out or default long-code STOP handling, Twilio already blocks texts to the number. The app's suppression list then diverges from Twilio's, and the TwiML reply to STOP may be dropped (error 21610).
- Last-10-digit matching collides across countries, for example `+44 7700 900123` and `+1 770-090-0123`, for opt-outs and erasure.
- `users_email_lowercase_check` (Postgres `lower`) versus JS `toLowerCase` on non-ASCII emails could make `createUser` throw a CHECK violation instead of the 422 the API advertises.
