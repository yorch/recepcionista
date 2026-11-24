# 15. Adversarial final verification of "Fix adversarial findings 11-14" (48c3313)

Scope: the fix commit against the Resolution tables of reports 11-14, the regressions it could introduce, and one pass for any remaining
Critical/High in the new feature set. Method: code reading, plus repros on a private database (`rev_final_test`, created and dropped by this
review; `scratch` untouched). A throw-away test file was used for the refund repro and deleted afterwards. No source files were changed.

Verdict: most fixes close their findings beyond the narrow test path. **One fix adds a money-loss regression (H1 below)**, and one fix is
only partial for the case its Resolution names (M1). Everything else is Low. I found no other Critical/High.

| # | Severity | Area | One line |
| --- | --- | --- | --- |
| H1 | **High** (money, reproduced) | refunds (report 13 M1 fix) | A late failure event for an OLD refund marks the booking failed and now also bumps the Idempotency-Key counter, so the owner's retry creates a second live refund while the current one is still pending |
| M1 | Medium (billing, reproduced) | migration `20261203120000` step 3 (report 14 M5) | The `metered_at` repair misses the main case it claims to cover on databases that already ran phase 1: calls that were in flight at the backfill and then finished |
| L1 | Low | calendar switch / account change (report 11 M1/M3) | `pushBooking` does not take the sync lease, so a push running during a switch or account change can still write an event into the old calendar or account |
| L2 | Low | payment-link deactivation (report 13 L1) | Only the latest link per booking is stored, so cancelling deactivates only the last link texted |
| L3 | Low | forward/AI split metering (report 12 L2/L3) | If the AI write fails after the forward write succeeded, the claim is released and reconcile bills the whole call as AI again (double count) |
| L4 | Low | agent-dirty drain (report 14 M2) | An automatic retry that hits a 404 makes a new agent with no phone binding and no post-call webhook (only the admin endpoint adds them) |
| L5 | Low | revoke-sessions (report 13 L2) | An owner signs a member out of "this business", but a session of theirs that is active in another business can switch straight back |
| L6 | Low | owner SMS text (report 11 L4) | The Spanish confirmation with a long summary goes over 320 characters, so `clampAlertBody` cuts the new "Responda NO <code>" tail |

---

## H1. A late failure event for an older refund opens a second live refund (High: money, reproduced)

**Where.** `src/lib/payments/refund-events.ts` `handleRefundEvent` (the `refund.failed || status failed/canceled` branch), `markRefundFailed`
(`src/lib/db/index.ts:1300`, matches `refund_status in ('none','pending','failed')`), `refundIdempotencyKey` counter in `src/lib/refund-service.ts`.

**What.** The failure branch never checks that the failing refund (`obj.id`) is the booking's current `stripe_refund_id`. Stripe sends
several events for one failed refund (`refund.failed`, `refund.updated` with status failed, and `charge.refund.updated`, all subscribed through
`REFUND_EVENT_TYPES`). It does not guarantee their order and redelivers for days. Before this commit such a late event only set the status
wrong: the next retry reused the same counter and key, so Stripe answered with the refund already in flight, and nothing was lost. The
M1 fix now writes a `booking.refund_failed` audit row for every webhook failure. That row is the counter behind the key suffix, so the next
retry gets a NEW key and Stripe creates a NEW refund. The H2 guard (a pending refund only allows the same amount) does not help, because the
late event already moved the status to `failed`. The owner is also texted "refund failed", which invites exactly that retry.

**Repro** (run on `rev_final_test`; the refund route and the Stripe webhook are real, Stripe is faked and answers `pending`):
1. Refund 2000 cents on a 5000-cent deposit. r0 is pending, key `rc-refund-<id>-2000`.
2. `refund.failed` arrives for r0. The booking is `failed` (counter 1).
3. The owner retries 2000. r1 is pending, key `...-2000-a1`, and `stripe_refund_id` is r1.
4. The sibling `refund.updated` (status failed) for **r0** arrives late. The booking is `failed` again, counter 2, and the owner gets a second "failed" text.
5. The owner retries. Output: `stripe calls [ ...-2000->re_0, ...-2000-a1->re_1, ...-2000-a2->re_2 ]`, HTTP 200.

At that point r1 and r2 are both live at Stripe: 4000 cents refunded for one 2000-cent refund. Stripe's own limit only stops refunds that
add up to more than the charge, so a partial deposit refund can be paid out twice.

**Fix.** In the failure branch, ignore an event whose `obj.id` is set and differs from `booking.stripe_refund_id`. Better still, make
`markRefundFailed` conditional on `stripe_refund_id = <id>` (or `IS NULL`) and on `refund_status = 'pending'`. Write the audit row only when
that conditional update changed the row. Add a test that replays the repro above.

## M1. The `metered_at` repair misses in-flight calls that finished after phase 1 (Medium: unbilled minutes, reproduced)

**Where.** `prisma/migrations/20261203120000_review14_provider_deletions_consent_lock_metering/migration.sql` step 3.

**What.** The phase-1 backfill set `metered_at = COALESCE(ended_at, started_at)`. For a call in flight at that moment, that value is
`started_at`. The repair matches `metered_at = COALESCE(ended_at, started_at)`. That is still true only while `ended_at` IS NULL. On a database
that already ran phase 1, which is the case the Resolution explicitly claims ("the same repair runs for databases that already applied the
phase-1 migration"), the post-call webhook for such a call arrived later under phase-1 code. It stored `ended_at` and `duration_sec`, and
`claimCallMetering` refused because `metered_at` was already set, so the call was never billed. Now `COALESCE(ended_at, started_at) = ended_at`,
which is not `metered_at`, so the signature no longer matches and the call stays settled. Calls still open are repaired. Calls that finished,
which are the realistic majority, are not.

**Repro** (psql on `rev_final_test`, all migrations applied): call `c_done_later` was in flight at the backfill. It then got `ended_at` and
`duration_sec = 240`. After step 3 it is `unsettled_for_reconcile = f`. The call that is still open is `t`.

**Fix.** Add a follow-up migration (the shipped file must not be edited, because of its checksum):
`metered_at = started_at AT TIME ZONE 'UTC' AND ended_at IS NOT NULL AND ended_at <> started_at AND started_at > <phase-1 apply time> - 3 days`,
plus a check that no `recordCallSeconds` happened for that call (for example, no `metered_at` set by new code, which is always `now()`).
The window should be anchored to the phase-1 apply time in `_prisma_migrations`, not to `now()`. Note also that `started_at > now() - '3 days'`
compares a `timestamp` with a `timestamptz`, so it depends on the session TimeZone. That is minor.

## L1. Pushes are not covered by the calendar switch or account-change lease

`changeCalendar` and `resetForNewAccount` hold `gcal-sync:<id>`. `pushBooking` holds only `gcal-push:<booking>`. A push that read the
connection before the switch POSTs to the old calendar and stores its link after `dropRemoteState` deleted the links. The next push then gets a
404 on the new calendar path and records a false `deleted_in_google`. The old event, which carries customer details, stays in the old calendar,
or in the old Google account in the account-change case. That account case is the privacy problem report 11 M1 was about. The window is the
duration of one push. Fix: make the link write conditional on the connection's calendar (as was done for busy blocks), or take the sync lease
in shared mode during a push.

## L2. Only the latest payment link per booking is deactivated

`setBookingPaymentLink` overwrites `stripe_payment_link_id`. If the voice tool and the dashboard (or two dashboard clicks) each created a link,
cancelling deactivates only the last one. The webhook alert for a cancelled booking still fires, so the owner is told. `create-link` also accepts
a cancelled booking. Fix: store every link, or refuse `create-link` for a cancelled booking and deactivate the previous link when a new one is made.

## L3. A partial metering failure on a transferred call is billed twice

In `processPostCall`, the forward seconds are recorded first (`meterForwardedCall`, which is deduplicated by call sid). If the following
`recordCallSeconds(aiSecs)` throws, the catch releases the metering claim. Reconcile then bills the whole `durationSecs` as AI seconds, on top
of the forward seconds already recorded. It needs a database write failure between the two writes. Fix: record the AI part first, or
release only when nothing was written.

## L4. The automatic agent re-sync can create an agent without phone binding or post-call webhook

`drainDirtyAgents` calls `resyncAfterKbChange` and then `syncAgent`. On a 404, `syncAgent` creates and remembers a new agent, the drain counts
that as `synced` and removes the marker. Only `POST /api/admin/resync-agents` was taught to bind the phone number and register the post-call
webhook for a created agent. The vertical-change path behaved the same way before this commit, but the drain now retries it automatically.
Fix: share the "created" follow-up (bind and register) in `syncAgent`'s create path, or treat `created` as `failed` in the drain and alert.

## L5. Revoking a member's sessions is scoped to one business, so the member can switch back

`revokeTeamUserSessions` deletes only the sessions active in this business. A stolen or abused session of the member that is active in
another business stays valid and can switch back into this one, because the membership is still enabled. That is defensible by design, but the
owner's only effective control is now disabling the membership. The button and docs should say so.

## L6. The Spanish owner confirmation text overflows 320 characters

With a summary of 150 characters or more, `confirmationSms(..., 'es', '12:34 PM')` is 338 characters. `clampAlertBody` (320) cuts the new
"No fue usted? Responda NO <code>." to "No fue usted...". The earlier "Responda NO <code>" in the same text still works, so the impact is cosmetic.
The English text is 306 characters, before any business-name prefix.

---

## Claims verified as closed (no finding)

- **Migration, steps 1, 2 and 4.** It runs again cleanly (applied a second time in one transaction, notices only). Rows that already exist
  satisfy the new CHECK: the old `sid_check` enforced the Twilio shape, and `provider` defaults to `'twilio'`. `NOT VALID` plus `VALIDATE`
  is harmless at this table size. An ElevenLabs row inserts. The consent guard's `FOR SHARE` does conflict with the declining
  `UPDATE ... consent_status`. Both orders (insert first, or decline first) behave as described in the migration. I found no new deadlock:
  every inserter takes only SHARE on the call row and does not then update the call in the same transaction.
- **Recording proxy (report 12 M2).** The byte cap is enforced while streaming and the upstream is cancelled. `running` is decremented in
  every path. The 30 s abort covers a hung body. Single flight, total-byte cache, 503 with `Retry-After`. Minor: the peak memory per download
  is about 2 x 40 MB because of the final copy. A download in flight during an erasure can re-cache audio, but nothing can reach it once the
  call row is gone.
- **Conversation deletion queue (report 12 M3).** `conversation_id` is unique and only set by signed provider webhooks, so the queue cannot
  name another tenant's conversation. It is queued in the same transaction as the DELETE (retention, erasure, `clearAll`). The inline failure
  of a declined or owner call falls back to the queue. It fails open only when `ELEVENLABS_API_KEY` is missing at purge time, which is documented.
- **Passkeys (report 13 H1).** Register options and verify now require a verified email. The reset deletes passkeys registered before
  verification, before marking the address verified. `changePassword` drops every session. No email-change path resets `email_verified_at`,
  so verified users do not lose passkeys they registered after verifying.
- **Refund pending rule (report 13 H2).** It is re-read under the claim and refuses a different amount while the refund is pending. The only
  stuck state is the documented case (a timeout that never reached Stripe). See H1 for the hole next to it.
- **Per-field stale check (report 11 M2).** It is compared inside the apply transaction under row locks, and `system_prompt` is excluded
  correctly. Proposals created before the upgrade have no knowledge-base base value (they expire after 30 minutes, as documented).
- **Calendar (report 11 M3 and L1-L3).** The lease is renewed by `withLease`. The waiter gives up after 20 s with a 409. `replaceBusyBlocksIf`
  and the revoke both lock the connection row first, so there is no lock-order inversion. A sync that finishes after a revoke is discarded.
  `markNeedsReauth` now moves a connection from `error` as well.
- **Live stream (report 12 M1), transcript rate limit (L7), reconcile `not_ready` (L4), transfer `unknown` (L2), interim last turn (L5),
  STIR on both owner entry paths (L6), recently-applied lookup in `findByCode` (report 11 L5), list of applied-only changes, signup locale
  (report 14 L5), malformed `rc_locale` (L1), vertical-change lease and drain (report 14 L4 and M2), usage-warnings lease (L6), and SMS
  "Reply C" cancel (it goes through `cancelBooking`, so the deposit link is now deactivated too).** All behave as claimed.
