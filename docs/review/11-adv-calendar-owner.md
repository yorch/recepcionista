# 11 — Adversarial review: Google Calendar two-way sync and owner call-in

Scope: `src/lib/integrations/google/*`, `src/app/api/integrations/google/*`, `src/lib/jobs/calendar.ts`, `src/lib/db/calendar.ts`;
`src/lib/voice/owner/*`, `src/lib/db/owner-kb.ts`, `src/app/api/businesses/[id]/kb-changes/*`, the owner branch of `/api/sms/inbound`.
Method: code reading only. No source was edited and no tests were run against the shared DB. Findings in reports 05-10 are not repeated.

## What held up (attacked, no finding)

- **OAuth.** The state is HMAC-signed and bound to user, business and session, single use (`claimEvent('gcal-state')`), with a 10 min TTL. The PKCE verifier sits in an encrypted HttpOnly cookie bound to the state nonce. Swapping in a code from another flow fails at Google because the verifier does not match. The scope check, `prompt=consent` and the refresh-token requirement are all in place.
- **Token storage.** Tokens are stored as AES-GCM envelopes with the connection id as AAD, so they cannot be moved between rows. They are never logged, and the error bodies are cut down to a `reason`.
- **Webhook.** Auth needs the channel id, the resource id and an HMAC channel token, compared in constant time. Unknown channels are compared against a dummy, and the response is always 200. The sync it triggers is coalesced by a lease.
- **SSRF.** Every Google URL is a constant. `calendar_id` and event ids are `encodeURIComponent`ed. The calendar choice is checked against `calendarList` (`minAccessRole=writer`).
- **Busy-block privacy.** `fields=` stops titles and descriptions from being fetched at all, and only times are stored or returned.
- **Push/pull loops.** Our own events are recognised by link or by the private `rc_booking` property and are never turned into blocks. The etag dedupe stops audit loops.
- **Owner gate.** The call keys and caller id come from ElevenLabs system dynamic variables, not from LLM parameters. `bindTenant` pins the business from `agent_id`. The call row must be `kind='owner'`. Customer tools are refused on owner calls.
- **Codes.** A code is an HMAC bound to (business, change, scope) and is only accepted from the verified owner sender. Attempts are rate-limited fail-closed. apply/reject/revert are atomic state transitions, so replaying YES/NO/UNDO is a no-op. Codes do not work across tenants.
- **Dashboard routes.** `requireBusinessAccess` plus `getKbChange(id, changeId)` keep the routes on the right tenant.

---

## M1. Reconnecting Google silently switches the synced calendar back to `primary` (Medium)

**Where**
- `src/app/api/integrations/google/callback/route.ts:53-55`: passes `calendar_id: 'primary'`.
- `src/lib/db/calendar.ts:71`, `:83`: the `common` block is applied on the update path too.
- Event links are kept on reconnect (docs/integrations/google-calendar.md:75: "links and history are kept").

**Scenario**
1. The owner picked a secondary calendar such as "Work".
2. The connection goes `needs_reauth` (password change, a token revoked by Google). This is the documented common case.
3. The owner clicks Reconnect. The same row is updated with `calendarId='primary'`.

**What goes wrong**
- **Busy time comes from the wrong calendar.** After the full sync, blocks are mirrored from **primary**. Commitments in "Work" stop blocking availability, so the receptionist double-books. Nothing in the UI says the calendar changed. `pick=1` only opens the picker, and the select shows `primary` as the current value.
- **False alerts.** The next push of any booking that changed PATCHes `primary/events/<id>`, gets 404, deletes the link and records `calendar.event_changed_externally {change:'deleted_in_google'}` (`push.ts:112-115`). The dashboard then shows false "the owner deleted this event" alerts. The booking is recreated in primary, so the old copy in "Work" becomes a duplicate.
- **Erasure is incomplete.** For an erased booking, `redactLinks` (`privacy.ts:15-16`) DELETEs from primary, gets 404, treats that as deleted and drops the link. The event, which holds the customer's name, phone and address, stays in the "Work" calendar forever.

**Fix**
- On reconnect, keep the stored `calendar_id` when the account email is unchanged. Only pass `calendar_id` on first connect.
- If the account email changed, run the `changeCalendar` cleanup first: delete the remote events through the old tokens (or keep the links as "orphaned" for the redaction sweep) and drop the old blocks.

## M2. Confirming one owner proposal makes every other pending proposal "stale" (Medium, functional)

**Where**
- `src/lib/voice/owner/apply.ts:67-73`: `kb.updated_at > change.created_at` leads to reject + 'stale'.
- `apply.ts:41`: `resyncAfterKbChange` upserts `system_prompt`, which bumps `knowledge_bases.updated_at` (`@updatedAt`, prisma/schema.prisma).
- `owner-kb.ts:142`: also bumps it whenever the patch has a KB field.

**Scenario**
1. The prompt and tool explicitly allow up to 5 proposals per call (`OWNER_PROPOSALS_PER_CALL`). The owner says "Brake pads are now $120" (A), then "Add FAQ: Do you take cards? Yes" (B).
2. Two texts arrive, and the owner replies `YES <codeA>`. A is applied, and the KB row is updated and the prompt rebuilt, so `updated_at` is now later than B's `created_at`.
3. The owner replies `YES <codeB>`. B is rejected and audited as `owner_kb.stale`, and the owner reads "your knowledge was edited after this was proposed".

This is the case even when B only touches business fields (`set_hours`, `add_closed_dates`), which already have a precise `base` check inside the transaction (`owner-kb.ts:135-140`). The prompt rebuild alone makes them stale. Every multi-change call therefore applies at most one change, and the owner has to call again for each of the rest. The integration test only covers a dashboard edit (`tests/integration/owner-callin.test.ts:257-261`).

**Fix**
- Make the stale check per field. Store the proposal-time values of every touched KB field (as is already done in `base` for business fields) and compare them inside the apply transaction.
- At minimum, ignore `system_prompt`-only writes, for example by comparing a content hash of services/faqs/pricing_notes instead of `updated_at`.

## M3. Switching calendars races an in-flight sync and watch: the old calendar's state is written onto the new one (Medium, plausible)

**Where**
- `src/lib/integrations/google/oauth.ts:51-60`: `changeCalendar` takes neither the `gcal-sync:<id>` lease nor any lock.
- `sync.ts:147-148`: `replaceBusyBlocks` and `updateCalendarSyncState`, unconditional.
- `watch.ts:45`: `ensureWatch` writes the channel unconditionally.

**Scenario** (this is the normal UI flow)
1. The callback starts `ensureWatch` and a full `syncConnection` of `primary` in the background (`callback/route.ts:58`) and redirects with `pick=1`. The owner picks "Work" a few seconds later.
2. `PATCH /calendar` runs `changeCalendar`. It clears `sync_token` and the channel, drops the blocks and sets `calendar_id='Work'`.
3. The background full sync of primary was already past its listing. It then calls `replaceBusyBlocks` with **primary's** events and stores **primary's** `nextSyncToken` on the connection, which now points at Work, with `fullAt=now`.
   - In the same way, a still-running `ensureWatch` stores a channel watching **primary**.

**What goes wrong**
- Primary's blocks gate availability for a business that chose Work.
- The next sync is incremental (`fullAt` is fresh), using primary's token against Work. If Google answers 410, a full resync fixes it. If not, primary's blocks stay until the daily full resync (up to 24 h).
- I could not check Google's answer to a sync token from another calendar, so this part is rated plausible.
- Work's changes get no push until the channel renews (about 6 days). The 15 min poll still runs.

**Fix**
- Run `changeCalendar` (and `disconnectGoogle`, see L1) under the `gcal-sync:<id>` lease.
- Make sync and watch writes conditional on the `calendar_id` they read (`updateMany where {id, calendarId: conn.calendar_id}`), and discard the results when the count is 0.

## L1. Disconnect can be undone by an in-flight refresh or sync (unconditional status writes) (Low)

**Where**
- `src/lib/db/calendar.ts:145-151`: `updateCalendarTokens` sets `status:'active'` with only `where:{id}`.
- `sync.ts:183`: `if (conn.status === 'error') setCalendarConnectionStatus(..., 'active')` uses the stale `conn`.
- `sync.ts:195`: the catch writes `'error'` over whatever status is current.
- `sync.ts:147`: `replaceBusyBlocks` has no status check.

**Scenario.** The owner clicks Disconnect while a sync or token refresh is running. `disconnectGoogle` revokes, then `setCalendarConnectionStatus('revoked')` wipes the tokens and blocks. The in-flight work then finishes:
- **(a) A refresh returns.** `updateCalendarTokens` stores a fresh access token and flips `revoked` to `active`. The reconcile job keeps pushing customer data into a calendar the owner disconnected for as long as that token is valid. This is worse when the revoke call failed, which is only logged (`oauth.ts:81-83`).
- **(b) The sync's last page was already fetched.** The blocks are reinserted. If the stored status was `error`, it is set back to `active`. The blocks gate bookings until the next poll finds no tokens and calls `markNeedsReauth`, which emails the owner "reconnect your calendar" right after they disconnected.
- **(c) An in-flight fetch times out.** The catch writes `error` over `revoked`. The status endpoint reports `connected:true` again. After that, every poll ends in `needs_reauth` without changing the status, because `markNeedsReauth` only moves from `active` (see L3), so the connection stays stuck in `error`.

**Fix**
- Guard every status transition with `status: { not: 'revoked' }`. `updateCalendarTokens` should never change the status.
- Make the sync writes conditional the same way.
- Have `disconnectGoogle` take the sync lease (or bump a generation column that the sync writes compare against).

## L2. Two businesses sharing one Google calendar ignore each other's bookings (Low/Medium)

**Where:** `src/lib/integrations/google/sync.ts:72`. `isOurs` treats **any** event with the private `rc_booking` property as "ours" and drops it, whichever business pushed it.

**Scenario.** One owner runs two businesses (two locations, or two trades with the same technician) and connects both to the same calendar, which is allowed. Business B's booking events carry `rc_booking=<B's booking id>`. When business A syncs, they are neither blocks nor linked, so they are skipped silently. A then books the same person into slots B already sold, which is a cross-business double booking. An owner-created event would have blocked the slot correctly.

**Fix:** treat an event as ours only when `links.has(ev.id)`, or when `rc_booking` names a booking of **this** connection's business (look the ids up in a batch). Map everything else as a normal busy event.

## L3. A 403/404 ("calendar gone or permission withdrawn") while the connection is in `error` never reaches `needs_reauth`, so stale blocks stay enforced (Low)

**Where:** `src/lib/integrations/google/sync.ts:189-192` calls `markNeedsReauth`, which returns early unless the status is `active` (`tokens.ts:40`). The 10-failure path works around this with `markNeedsRetry` (`sync.ts:202-206`), but this path does not.

**Scenario**
1. Google has a blip, so the connection goes to `error [1]`.
2. The owner then deletes the synced calendar or removes the app's access, so the next sync gets 404 `notFound`.
3. `markNeedsReauth` does nothing and the function returns `needs_reauth`. The status stays `error`, which counts as healthy (`busy.ts:13`), and the failure count never goes up.

**Impact:** the last mirrored blocks of a calendar that no longer exists keep refusing bookings indefinitely. This breaks the documented "fail open" rule. No email is sent, and the job retries every tick after the first backoff.

**Fix:** use `markNeedsRetry` (or a transition from `active|error`) in the 403/404 branch.

## L4. A spoofed owner caller ID gets more than "a conversation only" (Low)

**Where:** `src/lib/voice/owner/tools.ts:158-167` (list), `:169-188` (undo), `:78-87` (strike), `session.ts:42-43`. The doc claim is in `prompt.ts:3-4` and `session.ts:29`.

Caller ID is spoofable, which the design accepts. A spoofer who reaches owner mode can still do the following:
- **Read private data.** `list_recent_changes` reads out the last 5 change summaries, including **proposed or rejected** ones such as unpublished prices, closures and removed services. `undo_last_change` speaks the last applied summary.
- **Lock out the real owner.**
  - Five deliberately flagged proposals ("ignore previous instructions...") lock the owner line for an hour, for both propose and undo.
  - Ten spoofed calls use up `OWNER_SESSIONS_PER_DAY`, so the real owner gets the "limit reached" message for 24 h.
  - Proposals and undo requests use up the shared 6/hour confirmation-SMS budget.
- **Send text of their choosing from the business number to the owner.** The FAQ answer, notice or pricing-note text appears in "Reply YES <code> to apply: ...". It is bounded and scanned, but nothing tells the owner the request came from a call they may not have made.

**Fix**
- Limit `list_recent_changes` to applied/reverted items.
- Scope the lockout and session counters per verified call, or count only sessions that produced a YES.
- Add "Requested by a call at 3:12 PM. Not you? Reply NO <code>." to the confirmation text.

## L5. A voice UNDO of a change older than 7 days (or beyond the last 100 changes) texts a code that can never validate (Low, functional)

**Where:** `src/lib/voice/owner/tools.ts:172-180` picks the latest **applied** change of any age. `sms.ts:33-35` only searches changes created in the last 7 days and at most 100 rows.

**Scenario:** the owner calls and says "undo my last change", which was applied two weeks ago. They get "Reply UNDO ABC123". The reply answers "That code is not valid" and uses one of the 10 attempts in the 15 min window.

**Fix:** have `undoTool` refuse changes outside the `findByCode` window, or let `findByCode` also look at the newest applied change regardless of age.

---

## Resolution

Status after the fix pass. Tests: `tests/integration/google-calendar.test.ts` (R14 cases), `tests/integration/owner-callin.test.ts` (R14 cases), `tests/review14-pure.test.ts`.

| Finding | Status | How / test, or why it stays |
| --- | --- | --- |
| M1 reconnect resets the calendar to `primary` | **Fixed** | `upsertCalendarConnection` keeps `calendar_id` when the account email is unchanged (it only applies the requested calendar on first connect or for a different account). A different account first runs `resetForNewAccount` (deletes the old account's pushed events through the old tokens, drops links and blocks, under the sync lease) and starts on `primary`; the callback audits `account_changed` / `old_events_not_deleted`. Test: "R14 M1". Residual: events that cannot be deleted because the old tokens are already dead stay in the old account (counted in the audit; `docs/known-limitations.md`). |
| M2 confirming one proposal makes the others stale | **Fixed** | The `updated_at` comparison is gone. Each proposal stores `base` for every field it touches (knowledge-base fields except the derived `system_prompt`, plus hours / closures / area) and `applyKbChange` compares them inside the apply transaction (per field). Test: "R14 M2" (A price, B FAQ, C note all apply; D, a second price change, is stale). Residual: a proposal made before the upgrade has no KB `base` (it expires after 30 minutes). |
| M3 calendar switch races an in-flight sync / watch | **Fixed** | `changeCalendar` takes the `gcal-sync:<id>` lease (waits up to 20 s, else 409); `replaceBusyBlocksIf` (row `FOR SHARE`), `updateCalendarSyncState`, `upsertBusyBlock` and `ensureWatch` are conditional on the calendar they read and on not being revoked; a watch channel created for the old calendar is stopped, not stored. Test: "R14 M3" (conditional writes, watch race, switch waits for a running sync). |
| L1 disconnect undone by an in-flight refresh / sync | **Fixed** | `updateCalendarTokens` never changes the status and ignores a revoked row; `setCalendarConnectionStatus` refuses every non-revoked transition from `revoked`; sync writes are conditional (see M3). Test: "R14 L1". |
| L2 two businesses sharing one calendar | **Fixed** | `isOurs` = linked to this connection, or the `rc_booking` marker names a booking of THIS business (one batched lookup per page). Test: "R14 L2" (the existing marker test now uses a real booking; the fake Google is shared across tests). |
| L3 403/404 from `error` never reaches `needs_reauth` | **Fixed** | `markNeedsReauth` transitions from `active` and from `error`; `markNeedsRetry` is now just that call. Test: "R14 L3". |
| L4 spoofed owner caller id | **Partly fixed, rest residual** | Fixed: `list_recent_changes` reads out only applied / reverted changes; every confirmation / undo text says "Requested on a call at <time>. Not you? Reply NO <code>."; a `TN-Validation-Failed` caller id is served as a stranger (report 12 L6). Residual (by design, documented in `docs/known-limitations.md`): the 5-strike lockout, the 10 sessions a day and the 6 texts an hour stay per business, because a trustworthy per-call "verified" signal does not exist on lines without a STIR verdict. Tests: "R14 L4", "R14 L6", `tests/review14-pure.test.ts`. |
| L5 voice UNDO of an old change texts a dead code | **Fixed** | `findByCode` always includes the newest applied change whatever its age or position. Test: "R14 L5" (applied 20 days ago, 101 newer rows). |
