# Deposits, cancellation and refunds

How booking deposits are refunded, what the software does and does not do, and what the operator must review. This describes software
behaviour; it is **not legal advice**. The public page `/refunds` (src/app/refunds/page.tsx) states the customer-facing version and **the operator
must review it (with counsel where required) before launch**.

## What the app does

1. **A business chooses a refund policy** (Settings > Deposit refund policy; `PUT /api/businesses/:id/refund-policy`, owner only, audited):

   | `refund_policy` | A cancelled booking's PAID deposit is refundable when... |
   | --- | --- |
   | `none` | never |
   | `full_24h` (default) | cancelled 24 hours or more before the start |
   | `full_48h` | cancelled 48 hours or more before the start |
   | `full_always` | cancelled at any time, even after the start |

   The boundary is inclusive (exactly 24 h before is refundable, one millisecond later is not); the time is the cancellation time against the
   booking's start (`src/lib/refunds.ts`, pure and unit tested). `refund_policy_text` (<= 2000 characters, plain text) is the owner's wording; it is shown
   as text (never markup) on `/pay/[id]` and beside Stripe's Pay button (Payment Links `custom_text.submit.message`, with a link to `/refunds`).
   The payment text (`paymentLinkSms`) carries the one-sentence policy; it is dropped, never the link, when the text would not fit.
2. **Cancelling never refunds by itself.** `PATCH /api/bookings/:id {status:'cancelled'}` (and the voice tool `cancel_booking`) computes the verdict,
   records `cancelled_at`, marks the booking `refund_status = not_applicable` when nothing is owed (no paid deposit, or the policy says no), texts the
   customer (see below) and answers with `refund: {eligible, reason, hours_before, policy}`. An eligible paid deposit stays `none`: the dashboard offers
   **Refund deposit ($X, policy allows)**; an ineligible one offers **Policy says no refund. Refund anyway?** (an explicit second click).
3. **The owner refunds**: `POST /api/bookings/:id/refund {amount_cents?, override?}`:
   - owner (or admin) only, same-origin enforced, **step-up**: a recent password / 2FA proof (403 `reauth_required`, the dashboard asks and retries once);
   - amount: whole cents, `0 < amount <= deposit paid`; omitted = the whole deposit; `null`, strings, floats are 422;
   - `override: true` is required when the policy does not refund (or the booking is not cancelled) and is recorded in the audit row;
   - **one refund per booking**: after `refunded`, the same amount replays as 200 (`replayed: true`), a different amount is 409 (refund the rest in Stripe);
   - Stripe `POST /v1/refunds` (`payment_intent`, `amount`, `reason=requested_by_customer`, metadata) with `Idempotency-Key = rc-refund-<booking>-<cents>`
     (`-aN` after N definite failures) and a 15 s timeout; a short per-booking claim stops concurrent clicks from racing;
   - a definite Stripe refusal -> `refund_status = failed`, audit `booking.refund_failed`, 502 `provider_refused`; the retry uses a NEW key;
   - an unknown outcome (timeout, dropped connection) -> stays `pending`, 502 `outcome_unknown`; the retry reuses the SAME key, so it can never refund twice. While a refund is `pending` only the SAME amount can be sent again (409 `in_progress` for any other amount: a different amount is a different key, i.e. a second refund; the dashboard locks the amount). A failure that Stripe reports later (`refund.failed` / `refund.updated` failed webhook) is audited as `booking.refund_failed` like a synchronous one, so the retry gets a new key instead of Stripe's cached replay. Only a failure of the booking's CURRENT pending refund counts: a late or redelivered failure event for an older refund (or one that names no refund) is ignored;
   - success -> `recordRefund`, audit `booking.refunded` (amount, partial, override, policy verdict, Stripe ids), `emitBookingChanged(id,'refunded')`, and a
     text to the customer ("We refunded $X ... 5-10 business days");
   - the payment is found through `stripe_payment_intent_id` (else `stripe_checkout_session_id`, resolved through Stripe). A deposit paid before those ids
     were captured has neither: the route says to refund it in the Stripe dashboard (`no_payment_reference`).
   - Outside production with no `STRIPE_SECRET_KEY` the refund is a recorded mock (demo deposits have no Stripe payment). In production it fails closed.
   - **A refund stuck `pending` ("Check with Stripe")**: `POST /api/bookings/:id/refund/check` (owner, same step-up) lists Stripe's refunds for the booking's payment (`GET /v1/refunds?payment_intent=`) and resolves the pending attempt under the same per-booking claim a refund uses. This booking's refund (our `booking_id` metadata, same amount) found and succeeded: its id is adopted, the booking becomes `refunded` and the customer is texted once; found and still processing: the id is adopted (the webhook finishes it); found failed / canceled: marked failed (audit `booking.refund_failed`, so the retry takes a NEW Idempotency-Key); not found and the attempt (`bookings.refund_requested_at`) is at least 30 minutes old: it never reached Stripe, marked failed the same way so the owner can send it again; younger: 409 `too_early`. Stripe unreachable: 502 `unavailable`, nothing changes. It never creates a refund and is idempotent (a resolved booking is 409 `not_pending`); each use is audited (`booking.refund_checked`). The `reconcile` job does the same as the system for every refund pending longer than `REFUND_RECONCILE_AFTER_HOURS` (default 6), at most once an hour per booking.
4. **The deposit webhook captures the payment ids** (`checkout.session.completed` -> session id and payment intent; `payment_intent.succeeded` -> intent id)
   and reconciles later events (`/api/payments/webhook`, same signature check and `claimEvent` replay protection):
   - `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`: set the booking's refund state to Stripe's truth, also for refunds made in the
     Stripe dashboard (audit `booking.refund_reconciled`). Monotonic: a `refunded` booking is never downgraded; replays and reordering converge. A failed
     refund alerts the owner.
   - `charge.dispute.created`: audit `payment.dispute_created` (dispute id, amount, reason) and a text to the VERIFIED owner phone. Nothing is refunded or
     contested automatically; answering a dispute is done in Stripe. `charge.dispute.created / updated / closed / funds_withdrawn / funds_reinstated` also set
     `bookings.dispute_status` (`none | open | won | lost`, monotonic: a settled dispute is never reopened by a late event), shown in the calendar panel and the agenda; a loss is texted too.
   - **Customer text `C`** (the confirmation footer says "Reply C to cancel"): `/api/sms/inbound` cancels the sender's ONLY upcoming booking of the business the number belongs to, replies with the refund-policy verdict text (en/es) and emits the usual booking hooks; with several upcoming bookings it asks them to call. `CANCEL`, `STOP`, `END`, `QUIT` ... are opt-outs and keep precedence. Rate limited, deduplicated by MessageSid; a sender who opted out gets the cancellation but no reply text.
   Add these event types to the deposit webhook endpoint in Stripe: `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`
   (plus the three deposit events it already receives).

## Customer texts about a change

All go through `sendAndLog` (opt-outs, destination-country allow-list, plan cap, segment metering) with kind `other` and consent basis
`transactional_booking` (`caller_initiated` when the customer made the change on the phone). A change made by the OWNER is also held back during quiet
hours (9 pm to 8 am business time; the panel says so and offers "Text the customer about this change"); a change the customer made on the phone is not.
`customer_notified_at` is stamped only when the text was really delivered (`sent` or `mock`). The cancellation text tells the truth about the deposit:
"eligible for a refund; we will process it" / "under our policy ... not refunded" / nothing when no deposit was paid; it never says "refunded".

## Operator checklist

- Review the `/refunds` page text and each tenant-facing sentence in `src/lib/refunds.ts` (`policySentence`).
- Add the new event types to the Stripe deposit webhook endpoint; confirm `STRIPE_WEBHOOK_SECRET` is set.
- Stripe dashboard refunds are reconciled by the webhook; partial refunds made there are recorded as `refunded` with their amount.
- Not handled: refunds after 180 days (Stripe's limit), multiple partial refunds through the app (one per booking), refunding to a different card, tax.
- Unverified against a live Stripe account: the `custom_text[submit][message]` field of Payment Links (documented, never exercised here) and the exact
  event payloads beyond the fields used (`payment_intent`, `amount`, `amount_refunded`, `status`, `metadata`).
