# Adversarial review, round 6 (final, narrow pass over 3706d7c)

Scope: the most security-sensitive code from `3706d7c`: the voicemail playback proxy, the Twilio voicemail / dial-status callbacks,
step-up re-authentication, forwarded-call metering and caps, provider-side recording deletion, `lineKind()` and paused-mode tool gating.

Baseline at HEAD 3706d7c: `npx tsc --noEmit` clean; `bun test` against the scratch Postgres: 742 pass, 0 fail.

PoCs: `/tmp/claude-0/-home-user-recepcionista/59b1eb07-88a1-5d65-bce8-a60fd41cc4aa/scratchpad/round6-poc.test.ts` (5 tests, all pass
against HEAD, so each one shows a real behaviour). Run it from the repo root:
`TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/scratch bun test /tmp/claude-0/-home-user-recepcionista/59b1eb07-88a1-5d65-bce8-a60fd41cc4aa/scratchpad/round6-poc.test.ts`.
No src files were changed.

## Verified findings

### H1 (High): one anonymous caller can shut a forwarding or paused business off the phone, hour after hour

- `src/lib/voice/forward-metering.ts:46` (`voice/forward:hour:${businessId}`) and `:58` (`voice/voicemail:hour:${businessId}`). Both
  budgets are counted per BUSINESS only. They are used at `src/app/api/voice/incoming/route.ts:121,146` and
  `src/app/api/voice/voicemail/route.ts:54`.
- Every inbound call uses up budget before anyone answers: a forward takes one unit from the forward bucket. A forward refused by the
  rate limit becomes `paused`, which takes one unit from the voicemail bucket. An unanswered forward takes a voicemail unit as well. A
  caller who hangs up straight away still uses the unit.
- Repro (PoC test 1, defaults 30/30): one caller number places 60 calls in a row to a forward-mode business. Calls 1-30 get `<Dial>`
  (30 rings on the owner's phone). Calls 31-60 get `<Record>`. The next GENUINE customer, from a different number, gets
  `unavailableTwiml` ("We cannot take your call right now… Goodbye") and neither the owner nor a voicemail. The attacker repeats this
  every hour. The cost is about one robocall a minute. The missed-call SMS budget (1 per 10 min) is used up by the same calls, so the
  owner is not told about the real customer either.
- PoC test 2: a Twilio webhook retry of the SAME CallSid takes a second unit (`existing` row at incoming:82 is reused, but
  `forwardAllowance` still runs).
- Fix:
  1. Add a per-CALLER limit before the per-business one, for example `voice/forward:caller:${businessId}:${callerE164}` at 3/hour and
     `voice/voicemail:caller:…` at 2/hour. Over it, send that caller to `unavailableTwiml` without touching the business buckets.
  2. Make the per-business ceiling much higher (it guards cost, not abuse by a single caller), or scale it with the plan.
  3. Count the forward budget only once per CallSid (skip `forwardAllowance` when `existing` was already marked forwarded, or claim with
     `claimEvent('forward-allow', callSid)`).
  4. When the voicemail budget is spent, record the call and alert the owner (already rate limited) rather than hanging up silently.
     Today the only trace is a `voicemail_rate_limited` log line.

### M1 (Medium): anonymous voicemails (and carrier voicemail on the forward target) burn the tenant's plan minutes, then the AI line goes out of service too

- `src/app/api/voice/voicemail/route.ts:66-77` meters `RecordingDuration` (up to 90 s, `VOICEMAIL_MAX_SECONDS`) into
  `usage_counters.call_seconds` through `meterVoicemail`. `checkCallAllowed` reads that same counter for AI calls.
- Repro (PoC test 3): `BILLING_ENFORCED=true`, trialing, `TRIAL_CALL_MINUTES_CAP=30`. 20 anonymous paused calls, each leaving a 90 s
  voicemail (noise defeats `trim-silence`), put usage at 1800 s. `checkCallAllowed` is then `ok: false`, so after the owner switches back
  to AI every caller hears the out-of-service line. With the 30/hour default that takes under an hour. On a paid plan it is about 45
  plan-minutes per hour, every hour.
- The forward path has the same lever. `<Dial timeout=25>` is longer than most carriers' voicemail pickup (about 20 s), so the owner's
  carrier voicemail "answers" and bridges. The attacker stays silent and every call is metered as bridged minutes (up to `timeLimit`, by
  default the whole remaining allowance or 3600 s). Calls in progress at the same time each get the FULL remaining allowance as
  `timeLimit` (`forward-metering.ts:41-44`), so N simultaneous calls can overshoot the cap N times.
- Fix:
  - Meter voicemail seconds into a separate counter (or at a fraction) that does not gate AI calls, or exempt voicemail from the AI cap.
  - Apply the per-caller limit from H1.
  - Use `FORWARD_RING_SECONDS` of about 15 together with `<Number url=…>` call screening ("press 1 to accept"). This is the standard
    defence against carrier voicemail answering forwarded calls.
  - Reserve minutes for calls already in progress (subtract a per-call reservation from `remaining` while a forward is live), or cap the
    number of simultaneous forwards per business.

### M2 (Medium): recording deletion is fire-and-forget after the only reference is gone

- `src/lib/db/compliance.ts:274-290` (purge) and `:415-423` (erase) DELETE the call rows first. Only afterwards do they call
  `deleteTwilioRecordings` (`src/lib/voice/voicemail.ts:93-110`). A Twilio 5xx or 429, a timeout, a crash between the two steps, or a
  `TWILIO_ACCOUNT_SID` that no longer matches (sub-account move or rotation, `delete_skipped` at voicemail.ts:99) leaves the recording
  at Twilio with no row anywhere pointing to it. Nothing can ever retry the delete.
- Repro (PoC test 5): stub Twilio DELETE to return 503, then run `eraseCustomerData`. The result is `{ calls: 1, recordings: 0 }`, no
  row references the recording any more, and there is no pending-deletion table. Erasure under privacy law is reported as done while the
  customer's recorded voice survives at the provider.
- `clearAll()` (`src/lib/db/index.ts:1310`, demo reset) and any cascade delete of a business also drop the recordings without deleting
  them.
- Fix: in the same transaction as the call DELETE, insert the recording SIDs into a `pending_recording_deletions(account_sid,
  recording_sid, attempts, last_error)` table. Delete at Twilio from the jobs runner and remove a row only on 2xx or 404, retrying with
  backoff. Report the pending count in `EraseCounts`, and raise an alert when it does not drain.

### L1 (Low): the break-glass admin COOKIE session skips the step-up

- `src/lib/session.ts:249`: `needs = p.kind === 'user' || (p.kind === 'admin' && p.via === 'user')`. `via: 'cookie'` (the 12 h
  `admin_token` DB session created by `/api/auth/login` with ADMIN_TOKEN) is exempt, although it is an ambient browser credential just
  like a user session. The "token is the proof" reasoning only holds for the Bearer header.
- Repro (PoC test 4): an `rc_session` cookie session whose `sudo_at` is 11 h old can PATCH any tenant's call mode to `paused` (200).
  The change notice is still sent to the owner, which limits the damage.
- Fix: require step-up for `via: 'cookie'` too, with `/api/auth/reauth` accepting the ADMIN_TOKEN for that session kind. Exempt only
  `token` and `dev`.

### L2 (Low): `forward_during_hours` and a re-sent `mode` skip the step-up

- `src/app/api/businesses/[id]/call-mode/route.ts:50`: the step-up runs only when `mode` moves INTO paused or forward. Changing
  `{ forward_during_hours: false }` on a business that is already in `forward` widens forwarding from business hours to 24/7 with a stale
  session. The target number is already verified and the change is audited, so the impact is limited.
- Fix: also call `requireRecentAuth` when `forward_during_hours` changes while `call_mode === 'forward'`.

### L3 (Low): a 2FA account can step up with the password alone

- `src/app/api/auth/reauth/route.ts:45`: when `totp_enabled` is set, the TOTP path runs only if `code` is sent. Otherwise the password
  is accepted. A stolen cookie plus a phished or reused password is enough to redirect the line, and the second factor never comes into
  it.
- Fix: for `totp_enabled` users, require the code (or the password AND the code).
- Related: reauth password attempts (8 per 15 min per user, :17) are counted separately from the login throttle. Reauth TOTP failures
  DO count towards the account MFA lock (`mfa.ts onAccountFailure`), so whoever holds a session can lock the real owner's 2FA login.
  This is acceptable, but worth documenting.

### L4 (Low): audit actor of a DB admin user is labelled `admin_token`

- `src/app/api/calls/[id]/voicemail/route.ts:31` and `src/lib/voice/call-handling-changes.ts:actorOf`:
  `actor_kind: principal.kind === 'user' ? 'user' : 'admin_token'`. A DB admin user (`kind: 'admin', via: 'user'`) is recorded as the
  break-glass token, with an `actor_user_id`. Fix: use `'user'` whenever `principal.user` is set.

### L5 (Low): `lineKind()` misconfiguration fails safe but misleads

- `src/lib/voice/line.ts`: `VOICE_LINE_KIND=webhook` on a native (ElevenLabs-imported) production line lets owners choose Forward.
  The dashboard says "forwarding", but initiation and the tools always use `'native'` (`initiation/route.ts:96`, `tools.ts:999`), so
  callers hear the paused script and nothing is forwarded. There is no toll or security impact, only an owner who believes calls are
  forwarded. Fix: when `ELEVENLABS_PHONE_NUMBER_ID` is set and `VOICE_LINE_KIND=webhook`, have deploy.sh warn, or have
  `/api/health` report the mismatch.

## Claims verified OK

- **Voicemail proxy: SSRF and credentials.** The stored URL is only parsed (`TWILIO_RECORDING_URL`, anchored, no `m` flag). The fetch
  URL is REBUILT from the AC and RE SIDs on `https://api.twilio.com`. The account must equal `TWILIO_ACCOUNT_SID` exactly, and
  `evil.example` or a foreign account is never fetched.
- **Cross-origin redirects.** Checked by experiment on Node 22.23 and Bun 1.4.4: a cross-origin redirect drops `Authorization` (Range
  is kept).
- **Logs.** Only the status or error name is logged, never the URL or credentials.
- **Proxy auth and IDOR.** `authenticate` (staff+), then `requireBusinessAccess` BEFORE the existence check: another tenant's call and
  a missing call both return 404. `Lax` cookies are not sent on a cross-site `<audio>` subresource.
- **Proxy response headers.** Forced `audio/mpeg`, `nosniff`, `private, no-store`. Only `content-length` and `content-range` are copied
  from upstream. Range must match `^bytes=\d*-\d*$` (multi-range and junk are dropped). An upstream 416 or other status becomes 502.
- **Recording URLs never leave the server.** `publicCall` drops `recording_url` everywhere, and the export gives the playback path
  only.
- **Callback signatures.** `/api/voice/voicemail` and `/api/voice/dial-status` verify the Twilio HMAC against
  `PUBLIC_BASE_URL + path + query` (or the request URL). The tenant comes from the CallSid or ParentCallSid row only.
- **Callback input checks.** A `RecordingUrl` that is not one of our recordings is not stored. Durations are clamped by `parseSeconds`
  (`^\d{1,7}$`, max 4 h; negative and NaN values are ignored).
- **Metering idempotency.** Each parent CallSid is metered once by `claimEvent`, across the Dial action, the status callback and
  retries. Voicemail uses a separate key. A failed write releases the claim and returns 503 so Twilio retries.
- **Forward allowance.** A lapsed plan never dials. The trial cap is applied. `timeLimit` is at least 30 s and at most
  min(remaining, `FORWARD_MAX_CALL_SECONDS`). The allowance fails closed.
- **Step-up / sudo.**
  - `sudo_at` is stamped only on the caller's own `auth.sessionId`. It is never created, extended or copied to another session, and is
    per session (tested).
  - New sessions are born with `sudo_at = now` only on login, the MFA completion that creates a NEW session, and invite acceptance.
    An MFA-pending session cannot call reauth (401 `mfa_required`).
  - Reauth is CSRF-checked (same-origin is required for an ambient POST). TOTP goes through `verifySecondFactor` (replay-guarded,
    account lock) with recovery codes refused.
  - `ALLOW_INSECURE_DEV` is impossible in production (`insecureDevAllowed` requires `NODE_ENV !== 'production'`).
  - Migration `20261129120000` adds a nullable column only, so existing sessions simply have to step up once.
- **Step-up coverage.** Every path that changes the call mode or the forward number (call-mode PATCH, forward-number PUT,
  verify/start, verify/confirm) goes through `requireRecentAuth`. `updateBusiness` and the settings PATCH cannot write those columns.
- **Paused tool gating.** Gating is done inside `runTool` on the canonical tool name, so route-level spelling variants can only make it
  stricter. The tenant is bound from `agent_id` in the tool route. `handoff_to_human` and `flag_emergency` only alert the OWNER, and
  `alertOwner` has its own budget. No tool texts an arbitrary number while paused.
- **Deletion scope.** Deletion targets exactly the recording SIDs on the deleted rows of that tenant (`callSid` is unique, so there is
  no cross-tenant aliasing), our account only, and a 404 counts as deleted.

## Unverified suspicions

- Twilio requests the `<Dial action>` even when the CALLER hangs up during ringing (`DialCallStatus=no-answer` or `canceled`). If it
  does, each such call also takes a voicemail unit and marks the call "forward unanswered" with no voicemail possible. This makes H1
  cheaper (the attacker hangs up after 1 s). Not tested against real Twilio.
- The voicemail proxy has no per-user rate limit. A malicious staff member issuing many parallel Range requests could use up the
  account-wide Twilio REST concurrency and slow down SMS for every tenant. Not measured.
- `claimEvent` claims that are never completed (a crash between claim and `completeEvent`) leave a call unmetered for good. This only
  ever under-bills. Not checked whether `claimEvent` expires stale claims.
- An audit-write failure after a successful upstream fetch returns 500 without consuming or cancelling `upstream.body`, so the socket is
  held until GC. Minor, not measured.
