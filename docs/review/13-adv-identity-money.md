# 13. Adversarial review: identity (passkeys, memberships) and money paths (refunds, cancel, reschedule)

Scope: `src/lib/webauthn.ts`, `src/lib/db/passkeys.ts`, `src/app/api/auth/passkeys/**`, `src/lib/passkey-http.ts`, `switch-business`,
`src/lib/db/memberships.ts` and its migration triggers, `src/lib/session.ts` principal resolution, invites/team, `src/lib/refunds.ts`,
`src/lib/refund-service.ts`, `src/lib/payments/refund-events.ts`, `src/lib/providers/stripe-refunds.ts`, the payments webhook,
`/api/bookings/:id/{refund,reschedule}`, `src/lib/messaging/sms-cancel.ts`, and the annual plan.

Method: I read the code, then reproduced the top three findings against a throwaway Postgres (`rev_idmoney_test`, migrated, dropped
afterwards) with the real route handlers, `refundDeposit`, `handleRefundEvent` and the repo's virtual authenticator. The repro script is
`/tmp/claude-0/-home-user-recepcionista/59b1eb07-88a1-5d65-bce8-a60fd41cc4aa/scratchpad/rev13.test.ts`. It passes: each finding is confirmed.

| # | Severity | Finding |
|---|----------|---------|
| H1 | High | A passkey planted by a squatter on an unverified account survives the real owner's password reset, which bypasses the M4 fix |
| H2 | High | A refund in `pending` state (or with an unknown outcome) followed by a retry with a different amount issues a second Stripe refund |
| M1 | Medium | After an asynchronous refund failure (webhook), every retry reuses the first Idempotency-Key, so the app cannot retry the refund for 24 h |
| L1 | Low | The deposit payment link stays live after cancellation, so money can be taken for a cancelled booking |
| L2 | Low | An owner of business A can sign a shared member out of every business, B included |

---

## H1 (High): squatter passkey survives the password reset (2FA/takeover bypass of the M4 fix)

**Where:** `src/app/api/auth/reset-password/route.ts:40-55` (only TOTP is treated as "untrusted when enrolled before verification");
`src/app/api/auth/passkeys/register/options/route.ts:37-50` (no `verifiedEmail`); `src/app/api/auth/passkeys/login/verify/route.ts:506-521`
(the session is created `mfaVerified: true`, and an unverified email may sign in).

**Scenario:**
1. The attacker signs up with `victim@corp.com` (or creates the account any other way while the address is unverified). Unverified
   accounts may sign in with a password, and a new session is born with `sudo_at = now`.
2. The attacker registers their own passkey. `register/options` only asks for `requireRecentAuth`, which the fresh login satisfies, and
   never checks `email_verified`.
3. The real owner finds the address taken and uses "forgot password". `reset-password` resets the password, marks the email verified,
   revokes sessions and, per the M4 fix, clears TOTP that was enrolled before verification. It leaves `passkey_credentials` untouched.
4. The attacker signs in with the planted passkey. They get a full, MFA-verified session on an account that is now verified and owned by
   the victim, and they keep that access indefinitely.

The repro reaches step 4 with **200** from `passkeys/login/verify` after the reset, and `email_verified_at` is set.

The 24 h stale-account replacement in signup does not help. It runs only when the victim signs up again, not when they reset, and only
after 24 h.

**Fix (any of these, ideally the first two):**
- In `reset-password`, apply the same rule to passkeys as to TOTP: delete credentials with `created_at` earlier than `email_verified_at`,
  or all of them when the account was unverified, and audit and email it. Also consider deleting all passkeys on reset, since reset is the
  "I was compromised" flow.
- Require a verified email to register a passkey (`authenticate(req, { allowEnrollment: true, verifiedEmail: true })` in
  `register/options` and `register/verify`).
- Optionally refuse passkey login for an unverified account.

---

## H2 (High): a different amount on a pending or unknown refund creates a second Stripe refund

**Where:** `src/lib/refund-service.ts:52-90`, `src/lib/refunds.ts:117-119` (the key is `booking + amount + failures`), and the UI in
`src/components/calendar/refund-section.tsx:66-96`. The refund button and the partial-amount input stay enabled while
`status === 'pending'`; only `'refunded'` hides them.

`refundDeposit` blocks a second refund only when `refund_status === 'refunded'`. In `pending` (Stripe answered `pending` or
`requires_action`) or after a timeout (`outcome_unknown`, also left `pending`), a new request:
- passes the replay check,
- takes the claim, because the first one was already released,
- calls `recordRefund(...pending)`, which is allowed from `pending`,
- and uses `refundIdempotencyKey(id, NEW_AMOUNT, 0)`, a different key, so Stripe creates a new refund.

The comment at line 7 says "a repeated click, retry or timeout can never refund twice". That holds only when the amount is identical.

**Repro:** deposit 5000, `refundDeposit(2000)` with Stripe answering `pending`, then `refundDeposit(3000)`. Two `POST /v1/refunds` go out
with keys `rc-refund-<id>-2000` and `rc-refund-<id>-3000`. Both are accepted, the customer receives 5000, and the booking records 3000.

**Realistic trigger:** Stripe card refunds go `pending` when the connected balance is insufficient, and network timeouts are routine. The
owner sees "processing…", ticks "partial" or edits the amount, and clicks again. With a full amount first and then a partial one, Stripe
may reject the second for exceeding the charge. Any two partial amounts that fit under the deposit both go through.

**Fix:**
- In `refundDeposit`, under the claim: if `refund_status === 'pending'` and `refund_amount_cents !== amount`, return 409 `in_progress`.
  While a refund is pending, allow only an exact replay with the same amount and key.
- Better still, derive the key from the booking and a persisted attempt counter, not from the amount (for example
  `rc-refund-<id>-a<n>`), and bump the counter only on a definite failure.
- In the UI, disable the button and the amount field while the status is `pending`.

---

## M1 (Medium): after an async refund failure, retries reuse the old Idempotency-Key, so nothing is retried

**Where:** `src/lib/refund-service.ts:72-73` counts `audit_events` rows with `action = 'booking.refund_failed'` to choose the attempt
suffix. When Stripe reports the failure asynchronously (`refund.failed` or `refund.updated` with status `failed`), `handleRefundEvent`
(`src/lib/payments/refund-events.ts:96-98`) calls `markRefundFailed` but audits only `booking.refund_reconciled`. The counter does not move.

**Repro:** the first attempt answers `pending`. The `refund.failed` webhook sets `refund_status='failed'`. The owner clicks "retry", and
the same key `rc-refund-<id>-5000` is sent again. For 24 h Stripe returns the cached first response (`pending`, same refund id) and creates
no refund. The booking goes back to `pending`, a webhook never arrives (the refund already failed), and the owner is stuck with
"processing" while the customer is not refunded. The owner was texted "refund failed, check Stripe", but the in-app retry silently does
nothing.

**Fix:** persist an attempt counter on the booking (see H2) and increment it in `markRefundFailed` (both callers). Alternatively, have the
webhook failure path write a `booking.refund_failed` audit row.

---

## L1 (Low): the deposit link stays payable after cancellation

**Where:** `src/lib/booking-changes.ts:117-142` (cancel), `src/app/api/payments/webhook/route.ts:110-120`, and
`src/lib/db/index.ts:1124-1139` (`markDepositPaid` sets `deposit_paid` on any status). The Payment Link is single-use
(`stripe.ts:59`) but is never deactivated on cancel.

**Scenario:** the customer replies "C" (`sms-cancel.ts`). The booking is cancelled with no deposit, so it becomes `not_applicable`, and
the reply says there is no deposit. Later the customer, or anyone holding the text, pays the old link. The webhook marks the cancelled
booking `deposit_paid`. The owner's alert reads "Deposit paid by …" with no hint that the booking is cancelled. Money is kept until the
owner notices and refunds it.

**Fix:** on cancel, deactivate the payment link (`POST /v1/payment_links/{id} active=false`, after storing the link id). In the webhook,
when the booking is already cancelled or completed, alert "payment received for a CANCELLED booking — refund it", or auto-flag it
`refund_status='none'` with eligibility shown.

## L2 (Low): cross-business sign-out by a co-tenant owner

**Where:** `src/app/api/team/users/[id]/revoke-sessions/route.ts:23` calls `deleteUserSessions(target.id)` for all sessions. The comment
says this is intended ("the account is one person"), but it lets the owner of business A repeatedly sign a shared member out of business B,
where A has no authority. `changeTeamRole` already scopes deletion to sessions active in A.

**Fix:** delete only the sessions whose effective business is A, using the same `OR` as `team.ts:97-100`. Leave "sign out everywhere" to
the user themselves or a platform admin.

---

## Checked and holding (not findings)

- **WebAuthn challenges:**
  - Stored hashed, single-use (atomic `UPDATE … used_at IS NULL … RETURNING`), 5 min, bound to purpose and to the user for
    register and reauth. A login challenge cannot be used for reauth and vice versa (purpose column).
  - The challenge is consumed before the signature is checked, so a replayed assertion fails.
- **Origin and RP ID:**
  - Taken from configuration. `expectedOrigin` is an exact list filtered to the RP ID's domain.
  - The request origin is used only outside production when no base URL is set.
- **User verification and counter:**
  - UV is required everywhere, and the `userHandle` is checked against the credential owner.
  - The counter is checked atomically in SQL. A clone-suspect result revokes sessions, but only after a valid signature and a consumed
    challenge, so it cannot be triggered remotely.
- **Session fixation:** passkey login deletes any previous user or admin session token before issuing a new one, and clears the admin
  cookie.
- **Step-up:**
  - Passkey reauth checks `expectUserId`, shares the reauth budget, and stamps only the caller's session.
  - Register and delete require `requireRecentAuth`.
  - MFA-pending sessions resolve to nothing (`session.ts:190`), so a password-only attacker cannot register a passkey on a TOTP account.
- **Last-credential lockout:** not possible. Every account has a `password_hash` (NOT NULL), so deleting the last passkey still leaves the
  password.
- **switch-business:** the membership check is inside the UPDATE (enabled membership and enabled account). The CSRF check is in
  `authenticate`, and only the caller's session row changes. The role is re-resolved per request from memberships, and the legacy
  `users.role` is not used for authz.
- **Membership trigger** (`rc_sync_user_membership`): the `ON CONFLICT` updates only the role, never `disabled_at`, so legacy writes cannot
  re-enable a disabled membership. The repoint-on-business-delete trigger prefers enabled memberships.
- **Team routes:** an owner cannot re-enable a globally disabled account (`setTeamUserDisabled` toggles only the membership). Last-owner
  guards use row locks. Owners are pinned to the active business with a 404.
- **Accept-invite with an existing account:** needs a signed-in, fully-MFA'd session with exactly that email. The token is consumed in the
  same transaction as the membership, and admins are refused.
- **Refund route authz:** owner or admin, a 404 for other tenants before the step-up, `requireRecentAuth`, body allow-list. The amount must
  be an integer, greater than 0 and no more than the deposit paid. The currency is always USD (`stripe.ts:53`).
- **Webhook refund and dispute events:**
  - The signature is verified, events are deduped with `claimEvent`, and the business/metadata cross-check holds.
  - `recordRefund` and `markRefundFailed` never downgrade `refunded`, and dispute status is monotonic.
- **SMS "C":** runs after STOP/HELP and the owner commands, matches only the bare letter, is scoped to the inbound number's business and
  the sender's E.164, refuses when there are several upcoming bookings, is rate limited, dedupes on MessageSid, and never refunds on its own.
- **Reschedule:** owner-only and moved in place (no row copy, so a payment intent can never be shared by two bookings). Hours, overlap and
  past times are enforced in `rescheduleBooking`.
- **Annual plan:** `billing_interval` is display-only and is learned from the subscription price in the webhook. The client `interval` is
  validated and refused when no annual price exists. The mock-activate path is non-production only.
