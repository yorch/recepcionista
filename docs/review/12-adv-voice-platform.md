# 12. Adversarial review: voice platform (live transcript, transfer, screening, STIR, metering, recording proxy)

Scope: `src/app/api/calls/[id]/{live,transcript,audio}`, `src/app/api/voice/{transcript-event,screen,initiation,incoming,dial-status,voicemail}`,
`src/lib/voice/{live-stream,live-transcript,transfer,screening,reconcile,recording-audio,conversations,postcall}.ts`, `src/lib/db/{transcript,call-trust,usage}.ts`,
`src/lib/billing/warnings.ts`, `src/lib/stir.ts`, `src/lib/voice/caller-limits.ts`, `src/lib/voice/owner/{session,detect}.ts`.
Method: I read the code only. No database tests were run. Every finding below was checked against the cited lines. Findings already fixed or documented in reviews 05-10 are not repeated.

Checked and holding (nothing found):
- Tenant scoping on `/live`, `/transcript`, `/audio` and on the dashboard call page.
- Storing transcript events is gated on consent: the poller, the push route and post-call reconcile all require `disclosed`; the insert re-checks consent in SQL; owner calls are refused.
- Decline detection covers Spanish.
- Webhook auth: Twilio signature on screen, dial-status and voicemail; the tool secret on initiation and transcript-event.
- Metering idempotency between post-call and reconcile (`claimCallMetering`) and per parent SID for forwards.
- STIR fails closed: an absent verstat is treated as a stranger, and every real entry path passes `stirStatus`.
- Usage-warning claims are atomic.

---

## Medium

### M1. The live transcript stream keeps flowing to a member who was removed from the business, if they belong to another business
- **Where:** `src/app/api/calls/[id]/live/route.ts:43`. The reauth is `resolvePrincipal(req.headers)` and only `r.ok` is checked. `src/lib/session.ts:207-216` gives `pickActiveMembership` a fallback to any other membership. `src/lib/db/memberships.ts:132` (disable) and `:154-` (remove, when other memberships exist) keep the session and only move `active_business_id`.
- **Scenario:** User U is staff in businesses A and B. U opens `/dashboard/calls/<A-call>` during a live call. The owner of A removes or disables U. On the next reauth tick, `resolvePrincipal` still returns `ok: true`, now with `principal.business_id = B`. The stream never checks that again, so U keeps getting every caller utterance of A's call until the call ends or the 25-minute lifetime runs out. The route doc (line 13) promises "a removed member stops receiving within a minute". That is true only for a user with a single membership, because their account is deleted.
- **Fix:** In `reauth`, use the principal that comes back. Run `requireBusinessAccess(r.principal, call.business_id)` and `hasRole(r.principal, 'staff')` (catch the error and return false). Add a test for the case where a user with two memberships is removed mid-stream.

### M2. The recording proxy has no single-flight, no streaming cap and a 4-entry process-wide cache: memory and upstream amplification
- **Where:** `src/lib/voice/recording-audio.ts:17-19,56-73`; `src/app/api/calls/[id]/audio/route.ts:11-12,30-36`.
- **Scenario:**
  - The cache holds only 4 entries, shared by every tenant on the instance. With more than 4 recordings being played across all tenants, every Range request (seek, or the browser's metadata probe) misses and downloads the whole file again from ElevenLabs.
  - Requests for the same conversation are not coalesced. Twenty parallel Range requests while the first download is in flight mean twenty full downloads.
  - `await res.arrayBuffer()` (line 67) buffers the whole body before the 40 MB check when the upstream sends no `content-length` (chunked). `serveBody` then copies the body again for each 200 response (`body.slice()`, line 43).
  - The per-user limit is 30 per minute and the per-business limit is 90 per minute. Both count requests, not concurrency. One staff session that fires 30 parallel `GET /api/calls/<id>/audio` with different `Range` headers across 5 or more recordings holds about 30 × (size + copy) in memory. For 15-minute calls that is several hundred MB, and close to 2.4 GB at the 40 MB ceiling. A few tenants doing this at once can OOM the Node process, which also serves the voice webhooks.
- **Fix:**
  - Coalesce downloads per `conversationId` with an in-flight `Map<string, Promise>`.
  - Bound the cache by bytes (for example 64 MB total), not by entry count.
  - Read the body as a stream and abort once it passes `MAX_BYTES`, whatever the headers say.
  - Add a process-wide semaphore on upstream downloads (for example 4) and return 503 with `Retry-After` beyond it.
  - Serve with `body.subarray()` (no copy).

### M3. Erasure and the retention purge leave the full ElevenLabs conversation (audio and transcript) in place, and that is the audio the app now serves
- **Where:**
  - `src/lib/db/recording-deletions.ts:2-10`: only Twilio recordings are queued for deletion.
  - `src/lib/voice/recording-audio.ts:8,21`: `forgetCachedConversationAudio` is never called anywhere (grep). The header comment ("dropped on erasure") is false.
  - Provider conversations are deleted only for declined and owner calls (`postcall.ts:520,552`).
- **Scenario:** A caller asks for erasure. `calls` rows are deleted and the dashboard can no longer play the audio. But the recording and transcript stay at ElevenLabs for as long as the workspace retention setting allows, and anyone holding the conversation id plus the platform key can still fetch them. `docs/known-limitations.md:73` acknowledges "the app does not purge provider audio". However, `docs/compliance.md` presents erasure as complete.
- **Fix:**
  - In the same transaction that deletes call rows, queue the `conversation_id`s into `pending_recording_deletions` (a provider column of `elevenlabs`).
  - Drain them with `DELETE /v1/convai/conversations/{id}`, with the same retry and backoff as the Twilio queue.
  - Call `forgetCachedConversationAudio` there, or remove the claim from the comment.
  - Correct `docs/compliance.md`.

---

## Low

### L1. Recording plays can bypass the audit log by sending a suffix Range
- **Where:** `src/app/api/calls/[id]/audio/route.ts:39`. Only `!range || /^bytes=0-/` is audited. `recording-audio.ts:45` turns `bytes=-N` into `start = max(0, size - N)`.
- **Scenario:** `curl -H 'Range: bytes=-999999999' /api/calls/<id>/audio` returns the whole recording as a 206 and writes no `call.recording_played` row. Two requests, `bytes=1-` and then `bytes=0-0`, have the same effect. Staff can pull every recording without leaving any trace, and per-listen audit is the control that this feature advertises.
- **Fix:** Audit once per (user, call, 10-minute window) for any successful 200 or 206, deduplicated with `claimEvent('recording-played', \`${user}:${call}:${bucket}\`)`, instead of matching the range prefix.

### L2. `transferOutcomeFromTranscript` defaults to "connected"; its `unknown` branch is unreachable
- **Where:** `src/lib/voice/transfer.ts:110-112` (`if (!called) return 'none'; … return resolved || called ? 'connected' : 'unknown'`). `called` is always true at that point.
- **Scenario:** The provider shape is marked UNVERIFIED. If the agent invokes `transfer_to_number` and the result carries no `tool_name`, or uses another field, or the leg drops silently, the call is stored as `connected`.
  - The owner is told the call was transferred.
  - `postcall.ts:375-380` meters the whole conversation duration as forward seconds and never as AI seconds.
  - So the AI minutes of that call are never counted against the AI cap. They are counted against the cheaper forward allowance instead.
  - This is the documented "AI part metered as forward" limit, but here it is reached even when the transfer never happened.
- **Fix:** Return `'unknown'` when `called && !resolved`, so the status stays `attempted` and the call is metered as AI. Separately, meter the AI portion of a transferred call as AI seconds, since only the after-transfer time is forward time.

### L3. A forward-metering failure in post-call loses the minutes permanently
- **Where:** `src/lib/voice/postcall.ts:377-384` and `src/lib/voice/forward-metering.ts:141-160`. `meterForwardedCall` catches the error and returns `'failed'`; it never throws.
- **Scenario:** For a transferred call, `claimCallMetering` succeeds, then `recordForwardSeconds` fails (for example a DB blip). `meterOnce` releases its own event claim and returns `'failed'`. The `catch` in post-call never runs, so `metered_at` stays set. Reconcile skips the call (`alreadyMetered`), and the forward seconds are never recorded.
- **Fix:** Release the claim when `(await meterForwardedCall(...)) === 'failed'`: call `releaseCallMetering(c.id)`.

### L4. Reconcile meters 0 seconds when the provider reports no duration, and closes the call for good
- **Where:** `src/lib/voice/reconcile.ts:65-75`. `durationSecs ?? 0` runs after only `in-progress`, `initiated` and `unknown` were filtered out.
- **Scenario:** A conversation in `processing`, or one with `metadata.call_duration_secs` missing or null, is claimed with `seconds = 0`. That call's minutes are never counted, and a later post-call webhook also skips it, because the claim is taken.
- **Fix:** When `durationSecs === null`, treat the result as `not_ready`: bump the attempt counter and do not claim.

### L5. The poller stores every provider turn as final, including the turn still being spoken, so a mid-call decline in that turn is missed (conditional)
- **Where:**
  - `src/lib/voice/live-transcript.ts:45`: `is_final: true` for every turn.
  - `:91-97`: decline is checked only on `seq > known`.
  - `src/lib/db/transcript.ts:59-61`: final rows are immutable.
- **Scenario:** Suppose ElevenLabs grows the text of the latest user turn while the call is `in-progress` (this is unverified; the module itself says the in-progress behaviour is unverified). Then the first poll stores "I don't", and later text such as "...want to be recorded" is never stored and never checked. The caller's objection is missed until post-call, and live viewers keep reading the transcript.
- **Fix:** While the snapshot is not ended, store the last turn as `is_final: false`. Re-run `callerDeclinedRecording` on every caller turn whose text changed, not only on new seqs.

### L6. Owner mode ignores STIR on the Twilio line: a spoofed owner caller id can lock the owner out and use cap-exempt minutes
- **Where:** `src/lib/voice/owner/detect.ts:73-87` (compares caller id only) and `src/lib/voice/owner/session.ts:41-49`. The incoming route has `stirStatus` at hand (`incoming/route.ts:100`) but does not pass it.
- **Scenario:** An attacker spoofs the verified owner number with no attestation, or a failed one. They get the private owner assistant:
  - 10 sessions a day, up to 5 minutes each, exempt from the minute caps.
  - They use up the real owner's daily sessions.
  - They can make 5 "attack-looking" proposals, which trips `OWNER_BAD_PROPOSALS_LOCKOUT` and locks the real owner's line for an hour.
  - Each proposal also texts the owner a code, up to the 6-per-hour SMS limit.

  Changes still need the SMS confirmation, so this is a DoS and cost issue, not an integrity issue.
- **Fix:** On a line that provides a verstat, refuse owner mode when `attestationLevel(stir)` is `failed`, and consider requiring `A`. Keep the SMS factor as it is. Docs say A grants nothing extra, but its absence on a line that normally provides it should deny entry.

### L7. The `/transcript` polling fallback has no rate limit, and each request writes a lease row
- **Where:** `src/app/api/calls/[id]/transcript/route.ts:26-29`, and `requestPoll` → `acquireLease` (`live-transcript.ts:84`).
- **Scenario:** A staff session can loop on `GET /api/calls/<live-id>/transcript` with no limit (the SSE slot limits do not apply here). Each request runs 2-3 `getCall` lookups, a lease upsert, `lastTranscriptSeq` and a list query. That is cheap per request but unbounded.
- **Fix:** Add `rateLimit('live-poll:user:<id>', 40, 60_000)`. The client polls every few seconds, so this costs legitimate users nothing.

---

## Resolution

Tests: `tests/review14-pure.test.ts` (recording proxy, transfer outcome), `tests/integration/telephony-phase2.test.ts` (R14 cases), `tests/db/migration.test.ts`.

| Finding | Status | How / test, or why it stays |
| --- | --- | --- |
| M1 live stream survives removal from the business | **Fixed** | `voice/live-access.ts` `mayStillViewCall`: the re-check resolves the principal NOW and requires staff access to THIS call's business. Test: "R14 M1" (user in A and B removed from A: the session resolves to B and the check fails). |
| M2 recording proxy memory / upstream amplification | **Fixed** | Streamed read with a hard 40 MB cap (cancels the upstream body), per-recording single flight, cache capped at 64 MB in total (oldest first, TTL), at most 4 concurrent downloads per process (503 + `Retry-After`), `subarray` instead of copies. Tests in `tests/review14-pure.test.ts` ("R14 voice M2": 20 parallel Range requests make 1 download, chunked cap, byte cap eviction, concurrency limit). |
| M3 erasure / retention leave the ElevenLabs conversation | **Fixed** | Provider API supports it (`DELETE /v1/convai/conversations/{id}`, already used for declined / owner calls). `pending_recording_deletions.provider` (migration `20261203120000`), `enqueueRecordingDeletions` queues `conversation_id` in the same transaction as the call DELETE (retention purge, erasure, demo reset; only with `ELEVENLABS_API_KEY` set) and drops the proxy's memory copy; the drain deletes with retries / backoff / alert; a declined or owner call whose inline delete failed is queued too. `docs/compliance.md`, `docs/known-limitations.md`, `docs/runbook.md` corrected. Tests: "R14 voice M3", "R14 voice M3b", migration test. Residual: copies ElevenLabs keeps outside this API (backups, logs). |
| L1 recording plays bypass the audit log | **Fixed** | One `call.recording_played` row per (person, call, 10 minutes) for ANY successful 200/206, deduplicated with `claimEvent`. Test: "R14 voice L1" (suffix range, open range, `bytes=0-0`). |
| L2 transfer outcome defaults to "connected" | **Fixed** | `unknown` when the call has no readable result (status stays `attempted`, metered as AI). The AI part of a connected transfer is metered as AI seconds from the transfer turn's `time_in_call_secs` (`transferStartSecs`); without it the whole call stays forward time (residual, UNVERIFIED provider shape). Tests: pure + "R14 voice L2/L3". |
| L3 forward-metering failure loses the minutes | **Fixed** | `meterForwardedCall`'s `'failed'` now releases the metering claim (throws into the existing catch). Test: "R14 voice L2/L3" (a temporary CHECK makes the write fail; the retry meters it). |
| L4 reconcile meters 0 s when no duration | **Fixed** | No duration (and not `failed`) is `not_ready`: the attempt counter bumps, nothing is claimed. Test: "R14 voice L4". |
| L5 poller stores the growing turn as final | **Fixed** | The last turn of an unfinished snapshot is stored interim (`is_final: false`), the poller re-reads from the newest stored seq and re-checks the decline on every caller turn whose text changed; finalised when the call ends. Test: "R14 voice L5". |
| L6 owner mode ignores STIR | **Partly fixed** | `TN-Validation-Failed` on the owner number is refused owner mode on both entry paths (audited `owner_kb.refused` / `stir_failed`). Not required: attestation A, because many carriers report no verdict and the SMS confirmation is the real control (documented). Test: owner-callin "R14 L6". |
| L7 `/transcript` has no rate limit | **Fixed** | 40 requests a minute per person (the client polls every 3 s), 429 + `Retry-After`. Test: "R14 voice L7". |

**Residual-gaps pass.** L2's residual: the AI / forward split falls back to the Twilio dial duration, then the last timed turn before the transfer, before treating the whole call as forward time (provider shapes still UNVERIFIED). L6 is addressed together with 11 L4 (per identity class budgets). See `docs/changelog-hardening.md`.
