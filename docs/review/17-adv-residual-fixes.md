# 17 - Adversarial review: residual-gap fixes (commit 64e46fa)

Scope: per-trust-class owner budgets, Google orphaned events, legacy proposal stale check, transfer metering split / pending forwards,
usage-warning "changed since" job, vertical script rebuild, refund recovery (check route + reconcile job), payment-link lookup on cancel,
`revoked_business_ids`, migration `20261206120000_residual_gaps`.

Method: read the diff (`git diff HEAD~1..HEAD`) plus the code it calls. Reproduced against a private DB `rev_resid17_test` (all migrations,
`prisma migrate diff` = empty, i.e. zero drift), with a throwaway bun test kept in the scratchpad (nothing added to the repo). The DB and a
second old-schema DB were dropped afterwards. Findings already fixed in reports 05-15 are not repeated.

| # | Sev | Area | Reproduced |
|---|-----|------|------------|
| 1 | High | Refund recovery marks a real dashboard refund "never reached Stripe" -> the owner sends a second one | yes |
| 2 | Medium | Refund check: an OLDER failed attempt skips the 30-minute age gate | yes |
| 3 | Medium | Accepting an invitation lifts the business revocation on EVERY session of the user, including the ones that were signed out | yes |
| 4 | Medium | Cancelling an unpaid booking calls Stripe's Payment Link list (up to 5 pages, 20 s) inline, live voice calls included; misses the old links it is meant for | code |
| 5 | Medium | Reconcile meters a transferred call's whole duration as AI time, on top of the forward seconds the dial callback recorded (pre-existing, still open) | code |
| 6 | Low | Stuck-refund reconcile can starve: the 20-row window is filled by refunds Stripe is still processing | code |
| 7 | Low | Usage-warning job: a check that hit a transient error counts as a clean visit (the retry marker is deleted) | code |
| 8 | Low | Small gaps: orphan anonymise sweep capped at 2000 rows with no order; changed-since LIMIT with no order; script rebuild race | code |

No finding (checked): owner trust budgets, legacy proposal stale check, orphans route authz, migration.

---

## 1. High: a refund made in the Stripe dashboard (pending) is marked "never reached Stripe", and the retry refunds a second time

`src/lib/refund-service.ts:143` (`pickBookingRefund`), `:205-212` (the "nothing at Stripe" branch), `:231-245` (`reconcileStuckRefunds`).

The payments webhook already writes dashboard-made refunds onto the booking (`refund-events.ts:111-113`: `refund.created/updated` with
`status: pending` -> `recordRefund(pending, stripe_refund_id: re_dash)`). Refunds made in the dashboard carry no `booking_id` metadata,
and `pickBookingRefund` only accepts refunds whose `metadata.booking_id === booking.id` and whose amount equals `refund_amount_cents`.
So the booking's own current refund (`booking.stripe_refund_id`) is invisible to the check. After the age gate (manual: 30 min; reconcile
job: 6 h, with no person involved) the booking is marked `failed` with reason `never_reached_stripe`, and a `booking.refund_failed` row is
written. That row moves the idempotency key on. The UI then tells the owner the refund may be sent again.

Repro (scratch test, passes): booking paid 100.00. Webhook `refund.created {id: re_dash, status: pending, amount: 5000, metadata: {}}`
-> booking `pending / re_dash`. Seven hours later `reconcileStuckRefunds({fetchImpl})`, where Stripe lists `re_dash` (pending, no
metadata), returns `marked_failed` and the booking becomes `failed`. Then `refundDeposit(5000)` sends a new `POST /v1/refunds` with key `-a1`.
Stripe accepts it (50.00 is still refundable), so the customer gets 100.00 back. A slow refund that is legitimately pending (a bank /
`requires_action` refund) is enough. When the dashboard refund later succeeds, the webhook flips `failed -> refunded` and hides the loss.

Fix: in `pickBookingRefund`, first match `r.id === booking.stripe_refund_id` (whatever its metadata or amount). Never conclude "never
reached" while `booking.stripe_refund_id` is set and Stripe still lists that id. More generally, treat ANY refund on the payment intent
that is not failed or canceled and that the app did not make (no or foreign metadata) as "unknown, check the dashboard": return 409, do
not mark it failed. Also compute the money still refundable as charge amount minus the refunds Stripe has that are not failed, and cap
the retry at that amount.

## 2. Medium: an older failed attempt of the same amount skips the age gate

`src/lib/refund-service.ts:199-204`. The `too_early` guard (`REFUND_CHECK_MIN_AGE_MS`) only applies when Stripe lists NO matching refund.
After a first attempt failed (refund `re_old`, failed), a second attempt that has just timed out is `pending` with `refund_requested_at =
now`. The owner clicks "Check with Stripe" at once. Stripe lists only `re_old`, because attempt 2's request may still be finishing on
Stripe's side after our 15 s client timeout, or the list may lag. `pickBookingRefund` returns `re_old` (failed), and the code marks the
CURRENT attempt failed at second 0. Repro: the check returned `marked_failed` with `refundRequestedAt = now`. The next retry uses a new
key. If attempt 2 did land, that is a second refund (partial deposits, or deposit < charge).

Fix: apply the age gate to every outcome other than "found succeeded / processing". Only a refund created at or after
`refund_requested_at` (Stripe `created` >= the attempt) may represent the current attempt. Ignore earlier failed refunds when deciding.

## 3. Medium: invitation acceptance un-revokes every session of the user

`src/lib/db/memberships.ts:76-79` (`addMembership`). When a membership is granted, `array_remove(revoked_business_ids, B)` runs for ALL
of the user's sessions. The doc comment on `revokeBusinessForSessions` says "only a NEW login (a new session) clears it".

Scenario: X's laptop is stolen. The owner of B uses "sign out of this business" (`revokeTeamUserSessions(B, X)`). The laptop session
working in business A survives with B revoked, as designed. The owner then removes and re-invites X, and X accepts on a new device. The
stolen session can act in B again (it can switch to B, or B resolves as the fallback). Repro: after `removeMembership` + `addMembership`,
the old session's `revoked_business_ids` went from `[B]` to `[]`.

Fix: clear the entry only for the session that accepted (the accept-invite route knows `auth.sessionId`; a new-account accept creates a
fresh session anyway). Do not touch other sessions in `addMembership`.

## 4. Medium: every cancel of an unpaid booking scans Stripe Payment Links inline

`src/lib/booking-changes.ts:132`, `src/lib/payments/link-store.ts:43`, `src/lib/providers/stripe.ts:121-150`. The lookup runs whenever no
link id is stored, which covers every booking that never had a deposit link, not only legacy ones. Each such cancel then pages through
`GET /v1/payment_links?active=true` for up to 5 x 100 links or 20 s, with each request allowed up to 15 s. That happens synchronously on
three paths: the dashboard, the customer SMS "cancel", and the voice tool `cancel_booking` (ElevenLabs tool `response_timeout_secs: 20`,
`elevenlabs.ts:277`), so a slow Stripe can time out a live caller's cancel. The account is the single platform account (no
`Stripe-Account`), so the active list holds every tenant's unpaid links: links that are never paid stay active, and a single-use link only
deactivates once it has been paid. The list is newest first, so the links this lookup is for (old, texted before the id was stored) are
the ones the 500 cap cuts off first.

Fix: look up only when the booking has a deposit and no stored id (`deposit_amount > 0`, or an audit or SMS record of a link). Do it
off the request path, in a job or fire-and-forget. Better, use Stripe Search (`/v1/checkout/sessions` by `metadata['booking_id']`, or
store the link id durably before texting) instead of paging.

## 5. Medium (pre-existing, still open): reconcile bills a transferred call twice

`src/lib/voice/reconcile.ts:79`. When the post-call webhook never arrives for a transferred call, reconcile records the conversation's whole
`durationSecs` as AI seconds. By this commit's own model (`splitTransferSeconds`: forward = duration minus the AI part), that duration
includes the forwarded leg. The dial-status / voicemail callbacks have already metered that leg into `forward_seconds` (per call sid).
The forward time is counted twice, once against the AI-minutes cap. This commit now stores `dial_seconds` and has `splitTransferSeconds`,
but reconcile does not use them.

Fix: in reconcile, when `transfer_status = 'connected'` (or `dial_seconds` is set), split with
`splitTransferSeconds({durationSec, transcript: null, dialSeconds})` and record only the AI part. Meter the forward part through
`meterForwardedCall` (deduplicated per sid).

## 6. Low: the stuck-refund pass can starve

`src/lib/refund-service.ts:233-240`. The pass selects the 20 OLDEST pending rows and only then skips the ones claimed in the last hour.
Refunds Stripe keeps processing (`requires_action`, slow bank refunds) come back as `unchanged`, with no write and no new
`refund_requested_at`, so they stay in the window for good. With 20 or more of them, newer stuck refunds are never looked at. Fix: order
by a `refund_checked_at` column (or exclude rows checked in the last hour in SQL) instead of filtering after `take`.

## 7. Low: a transient error drops a business from the warning retry list

`src/lib/jobs/reconcile.ts:98-100`. `checkUsageWarnings` "never throws": a database or network error returns `[]`. The job reads `[]` as
"clean", deletes the `usage-warn-retry` marker and advances `since`. A deferred (quiet-hours) or failed warning is then not retried until
the business writes usage again or the daily full sweep, so up to 24 h late. Fix: have `checkUsageWarnings` report an `error` outcome
(or rethrow) and keep the marker on it.

## 8. Low: smaller gaps

- `src/lib/db/calendar.ts:436`: `anonymizeOrphanedEvents(null)` takes 2000 rows with no ORDER and no cursor. Once more than 2000 orphan rows
  point at live bookings, rows of anonymised or erased bookings past them are never blanked (their service and start time stay). Order by
  id with a cursor, or use one `UPDATE ... WHERE booking_id NOT IN (live bookings)`. Orphan rows are also not covered by retention
  (`purgeExpiredData`).
- `src/lib/db/usage.ts:361`: `LIMIT 5000` with no ORDER, and the job then advances `since` anyway. With more than 5000 changed businesses
  per pass, the rest wait for the daily sweep.
- `src/lib/voice/agent-resync.ts:45-49`: `rebuildGeneratedCallScript` reads, compares and writes without a lock shared with the KB editor.
  An owner script saved between the read and the write is overwritten with the generated one. It also never recognises a stale script
  whose services list changed after the failed rebuild (it compares against the current services only), so that case keeps the old
  trade's script.
- Pending-forward key drift (edge case): postcall meters under `call_sid ?? conversationId`, and `settlePendingForwards` keys by the
  row's `call_sid ?? conversation_id`. If the clear after a successful forward write fails (`.catch(() => undefined)`, postcall.ts) and
  `call_sid` is filled in later, the job meters the same seconds again under the new key. Store the key used in postcall next to
  `forward_pending_secs`.

## Checked, no finding

- **Owner budgets per trust class** (`config.ts`, `session.ts:59-61`, `tools.ts`, `reply-tools.ts`): the class comes from the stored
  `caller_verified`, which is set only from Twilio `StirVerstat` (signed) or the tool-secret-authenticated initiation body. The tool
  args carry no trust input, and A is required for `verified`. A spoofer (no verdict / B / C) can only exhaust the `:u` lock, the `:u`
  text budget and the unverified session count. As documented, that still locks out an owner whose carrier gives no verdict.
- **Legacy proposals** (`owner-kb.ts:158`): every OWNER_PATCH_KEY has a value in `now`, so new proposals always store a base entry (no
  dropped `undefined` keys). Legacy rows without a base are refused as stale.
- **Orphans route**: owner-scoped through `scoped(req,'owner')`, and the delete is bound to `businessId`. The status route (staff+) exposes
  only service, start time and the connected account email. Old tokens are used before the upsert (callback order verified).
- **Pending forwards vs dial-status**: meterForwardedCall is deduplicated per sid, and `duplicate` clears the marker. The 2-minute
  `afterMinutes` keeps the job away from postcall's own retry. No double write was found beyond the edge case in item 8.
- **Migration 20261206120000**: re-ran it twice on a migrated DB (NOTICE/skip only). Applied it to an old-schema DB with an existing
  `user_sessions` row: `revoked_business_ids` was backfilled to `{}`. `prisma migrate diff` against schema.prisma is empty.
- **Refund check route**: owner role, tenant check before the 404, step-up (`requireRecentAuth`), rate limited, audited. It never calls
  `POST /refunds`.
