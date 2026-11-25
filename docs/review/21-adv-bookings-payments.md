# 21. Adversarial review: manual bookings and deposits

Scope: `src/app/api/bookings/**`, `/api/payments/*`, `/api/sms/payment-link`, `/pay/[id]`, the deposit policy API, manual mark / unmark / manual refund, `src/lib/billing/price.ts`, crew-aware `createBooking` / `rescheduleBooking`, and the voice `create_payment_link` tool. Branch vs `origin/main` (commits 5fdd2e9, 8f29743).

Method: I read the code and reproduced findings against a throwaway Postgres (`rev_bookpay_test`, migrated with `prisma migrate deploy`, dropped afterwards). The tests were scratch bun tests outside the repo. They used the real webhook route with a signed Stripe event, the real `markDepositPaidManually`, `recordManualRefund` and `refundDeposit`, and the fake `fetch` guard. No outbound calls were made. The existing `tests/integration/booking-payments.test.ts` passes (19/19).

## Findings (ranked)

### H1. A card payment on a booking already marked paid by hand is silently absorbed: no owner alert, stays "manual", and Stripe refund is blocked. High

- `src/lib/db/index.ts:1191-1198` `markDepositPaid` only updates when `depositPaid=false` or the amount differs.
- `src/app/api/payments/webhook/route.ts:118-121` stores the Stripe refs, then sends the owner alert only when `updated`.
- `src/lib/refund-service.ts:42` refuses with `manual_deposit` whenever `deposit_source='manual'`.
- `src/app/api/bookings/[id]/deposit/mark-paid/route.ts:54-58` deactivates the link best effort only: one 4 s attempt, no queue, no Stripe lookup when no link id is stored. The cancel path, by contrast, has the durable `scheduleLinkDeactivation` queue.

Scenario, reproduced:
1. The owner sends a $50 link.
2. The customer pays $50 cash, and the owner marks the deposit paid.
3. The Stripe deactivation times out or fails. The link may also be a voice-tool link whose id was never stored.
4. The customer then pays the still-live $50 link.

Result: the webhook answers `deposit_paid:false`, and the owner gets 0 alerts. The row stays `deposit_source='manual'` while `stripe_payment_intent_id=pi_…` is set. `refundDeposit` (even with override) returns `manual_deposit`. `unmarkManualDeposit` still succeeds, which leaves `deposit_paid=false` with a captured card payment on file. The owner can then resend a link and collect a third time.

This is double collection that the owner does not see, and the platform cannot refund it. It also contradicts the module doc ("Stripe's webhook replaces a manual mark", `src/lib/db/deposit-policy.ts:9`).

Fix:
- In `markDepositPaid`, also match `depositSource: 'manual'` (or `not: 'stripe'`) so a Stripe payment always converts the row to `stripe`.
- When it replaces a manual mark, audit `payment.paid_over_manual_deposit` and always alert the owner: "a card payment arrived for a deposit you marked as received; refund one of them".
- Make the mark-paid deactivation durable: reuse the link-deactivate queue and let `drainLinkDeactivations` accept `deposit_source='manual'` rows. Fall back to `findActivePaymentLinksForBooking` when no id is stored.
- Refuse `unmark` when `stripe_payment_intent_id` / `stripe_checkout_session_id` is set.

### M1. A manual refund record blocks the Stripe refund of a later card payment. Medium

- `src/lib/db/index.ts:1197` switches the source to `stripe` but leaves `refund_status='refunded'` and `refund_amount_cents` from the manual refund.
- `src/lib/refund-service.ts:52-56` then answers `already_refunded`.

Reproduced:
1. The owner marks $40 manual and records a $40 manual refund.
2. The live link is paid at $50.
3. The row now reads `deposit_source=stripe, deposit_amount=5000, refund_status=refunded, refund_amount_cents=4000`, and `refundDeposit` returns `already_refunded`.

The card charge cannot be refunded from the app, and the booking claims it was refunded.

Fix: when the webhook converts a manual deposit to Stripe, reset the refund bookkeeping (`refund_status='none'`, clear the amount, keep the manual refund in the audit trail). Or refuse to record a manual refund while a link may still be live (see H1).

### M2. A stale booking snapshot rewrites the amount of an already-paid manual deposit and leaves a new live link. Medium (race)

- `src/lib/messaging/actions.ts:119` and `src/app/api/bookings/[id]/deposit/route.ts:78` decide using the booking read at request start (`!booking.deposit_paid`).
- `src/lib/payments/link-store.ts:18-30` (`rememberPaymentLink`) never checks `deposit_paid`.

Reproduced with a snapshot taken before the manual mark:
- `createAndSendPaymentLink` texts a new $90 link.
- It overwrites `deposit_amount` to 9000 on a row that is `deposit_paid=true, deposit_source=manual`. The audit log still says 5000.
- The new link stays payable, which leads straight into H1.

Triggers:
- The owner clicks "resend" and "mark paid" in two tabs.
- The voice tool runs while the owner marks the deposit.
- `/api/payments/create-link` or `/api/sms/payment-link` runs during a mark.

Fix: write `deposit_amount` with a conditional `updateMany({ where: { id, depositPaid: false } })`. In `rememberPaymentLink`, deactivate the new link when the booking is paid (the same treatment as cancelled). Optionally take the booking's advisory lock in mark-paid and in the link request.

### M3. In percent mode, the AI's own `price_estimate` sets the deposit and can push it below the owner's minimum. Medium

- `src/lib/voice/tools.ts:427-447` stores the model-supplied `price_estimate` (dollars, unchecked against the catalog `base_price`).
- `src/lib/voice/tools.ts:650` computes the deposit from it.
- `src/lib/business-config.ts:143` "never more than the whole job" overrides `min_cents`.

Example: policy 20%, min $50, max $200.

| Price estimate the model sends | Deposit |
| --- | --- |
| $1.50 | $1.50 |
| $1.00 | $1.00 |
| $0.99 | $50.00 (non-monotonic) |

A caller ("the job is a dollar fifty") or an injected prompt therefore picks the deposit amount anywhere from $1 up to the minimum. The booking becomes `confirmed` when that payment arrives. The "amount is server-computed" guarantee only holds for fixed mode.

Fix, for the AI path:
- Take the price from the matched catalog service (`base_price`), and ignore the model's estimate for deposits.
- Or treat `min_cents` as a hard floor: refuse with `no_amount` when the estimate is below the minimum.
- Make the `< DEPOSIT_MIN_CENTS` branch consistent.

### L1. In fixed mode, the AI creates and texts deposit links tied to no booking. Low

`src/lib/voice/tools.ts:646-686`: when `booking_id` is missing, foreign, or from another call, `booking` is null. Fixed mode still computes an amount and texts a Stripe link with no `booking_id` metadata. A caller phoning about an existing booking pays, but the booking is never marked paid. The webhook takes the "without a booking match" branch, and the owner has to reconcile by hand. Repeated tool calls create a new link each time (only the SMS caps limit this).

Fix: require a booking made on this call before creating a link, or attach the call's single booking automatically.

### L2. The plan price lookup has no single-flight and blocks the public landing page. Low

`src/lib/billing/price.ts:39-63` is called on every render of the force-dynamic `/` page (`src/app/page.tsx:36`). When the cache is cold or has expired (every 10 min), every concurrent request issues its own Stripe GET and waits up to 4 s before rendering. During a Stripe slowdown, every visitor pays the 4 s until the failure is cached.

There is no poisoning vector: the cache key is the env price id and the response shape is validated.

Fix: memoise the in-flight promise per price id, and serve the stale value while it refreshes (stale-while-revalidate).

### L3. A demo mock payment is stamped `deposit_source='stripe'`. Low (demo only)

`src/app/api/pay/mock-complete/route.ts:28` goes through `markDepositPaid`, which now writes `stripe` without a payment reference. The contract says demo-paid deposits stay NULL. A later refund attempt answers `no_payment_reference`. It is gated by `demoModeEnabled()` (never in production), so the only effect is misleading demo data.

## Checked and holding

- **Crews and the database exclusion constraint:** the constraint is per `(business, crew)`. With 3 crews and a 30-minute buffer, 20 concurrent creates gave exactly 3 bookings, one on each crew. Explicit-crew collisions answered `slot_taken`, and an adjacent booking inside the buffer was refused. Reschedule keeps or reassigns the crew under the same advisory lock.
- **Tenant isolation:** every route calls `requireBusinessAccess` with the booking's own `business_id` before acting. The webhook checks that the `business_id` metadata matches. `create-link` returns 404 for another tenant's booking.
- **Step-up:** mark-paid, unmark and manual refund all call `requireRecentAuth` after the tenant check. Staff are refused (`role: 'owner'`). CSRF is enforced via `authenticate`.
- **`created_via`:** cannot be set from a request. The dashboard hardcodes `'dashboard'`, the AI defaults to `'ai'`, and the DB whitelists the value.
- **`/pay` redirect:** it only goes to `https://buy.stripe.com` URLs returned by Stripe for the booking's stored link id. A paid booking shows the receipt and a cancelled one never forwards. There is no open redirect and no cache poisoning (the cache key is a server-stored `plink_` id). Card form and `mock-complete` are unreachable in production.
- **Deposit amount checks:** the owner routes (`/deposit`, `/payments/create-link`, `/sms/payment-link`) all go through `resolveDepositAmount`, which checks bounds and integers. The AI ignores `amount_cents` and the $500 cap applies. Percent rounding is `Math.round` on integer cents.
- **Manual deposits and Stripe:** `refundDeposit` never calls Stripe for a deposit whose `deposit_source` is `manual` (but see H1 for the case where it should).

## Repro artefacts

Scratch tests in `/tmp/claude-0/-home-user-recepcionista/59b1eb07-88a1-5d65-bce8-a60fd41cc4aa/scratchpad/t/` (outside the repo):

| File | Covers | Run with |
| --- | --- | --- |
| `adv.test.ts` | H1, M1, M2 | `TEST_DATABASE_URL=… bun test <file>`, from the repo root |
| `crew.test.ts` | crew race | same |
| `pure.test.ts` | M3 | same |

Output excerpts:

```
webhook A {"received":true,"booking_id":"…","deposit_paid":false}
A row manual true pi_nubitg4z18d owner alerts 0 0
A refund {"ok":false,"code":"manual_deposit"}
A unmark after stripe paid true false pi_nubitg4z18d
B row stripe 5000 refunded 4000
B refund {"ok":false,"code":"already_refunded"}
C row true manual 9000
```
