# Billing (Stripe subscriptions)

Open self-signup, paid access: a new account must start a **Stripe subscription with a free trial and a card on file**
before any paid resource (Twilio number, ElevenLabs agent) is provisioned. One monthly price, with monthly usage caps for
texts and call minutes.

Deposit payments (`/api/payments/webhook`, `STRIPE_WEBHOOK_SECRET`) are a separate feature and are untouched.

## How it works

| Piece | Where |
| --- | --- |
| Checkout / portal / status | `POST /api/billing/checkout`, `POST /api/billing/portal`, `GET /api/billing/status` |
| Stripe webhook (public, signed) | `POST /api/billing/webhook`, secret `STRIPE_BILLING_WEBHOOK_SECRET` |
| Admin comp / grandfather | `POST /api/admin/billing` |
| Provisioning gate | `src/lib/billing/gate.ts` (`assertProvisioningAllowed`), used by `/api/businesses/[id]/provision` |
| Dashboard | `/dashboard/billing`, banner `src/components/dashboard/billing-banner.tsx` |
| State on `businesses` | `billing_status`, `plan`, `stripe_customer_id`, `stripe_subscription_id`, `trial_ends_at`, `current_period_end`, `cancel_at_period_end`, `past_due_since`, cap overrides |

Status mapping (Stripe subscription status to `billing_status`): `trialing`, `active`, `past_due`, `unpaid`, `canceled` map one to
one; `incomplete` / `incomplete_expired` become `none`; `paused` becomes `unpaid`; anything unknown becomes `none` (fail closed).

Service rules (Phase 1, `src/lib/db/usage.ts`): `trialing` and `active` are allowed; `past_due` is allowed for
`BILLING_PAST_DUE_GRACE_DAYS` (default 5) after it first became past due; everything else is refused.

**Production fails closed.** With `NODE_ENV=production` billing is ENFORCED unless `BILLING_ENFORCED=false` is set explicitly (any other value, a
typo or an unset variable enforces). `deploy.sh` and `compose.production.yaml` refuse to run with the variable unset or invalid, and `deploy.sh`
prints a loud banner (plus a startup warning in the app log, `billing.not_enforced`) for `false`. Reason: signup is public, so a fail-open default would give
every stranger a free number, agent and texts. Two further rules do not depend on the flag: in production a **non-admin** can never provision a number/agent
without an active plan (`isProvisioningAllowed`), even with `BILLING_ENFORCED=false`; and `BILLING_ENFORCED=false` only relaxes texts/calls for tenants that
already exist. In development and tests nothing is refused unless `BILLING_ENFORCED=true`.

Checkout rules: owner or admin only, the account email must be verified (admins exempt), a business that already used a trial
gets no second one, an already-subscribed business gets 409 (use the portal). **One trial per person, not per business**: the normalised owner
address (case, `+tag`, Gmail dots) and the card's Stripe fingerprint are remembered as HMAC hashes in `trial_fingerprints`; a seen address starts
paid (no trial) and a card seen on another business ends the trial immediately when `checkout.session.completed` arrives (audited as `billing.trial_denied`). Cookie requests are same-origin checked and rate limited.

### Webhook behaviour

- Signature: `Stripe-Signature` (`t=`, one or more `v1=`), HMAC-SHA256 of `t.body`, 5 minute tolerance. Unset secret answers 503, except
  `ALLOW_INSECURE_DEV=true` outside production.
- Idempotent: `claimEvent('stripe-billing', event.id)`, `completeEvent` on success, `releaseEvent` on failure (Stripe retries then work).
- Events handled: `checkout.session.completed` (subscription mode only), `customer.subscription.created|updated|deleted|trial_will_end`,
  `invoice.paid`, `invoice.payment_failed`. Everything else answers 200 and is ignored.
- The business is found by `stripe_customer_id`, or by `client_reference_id` / subscription `metadata.business_id` for the first event.
  A business that already has a different customer id, or a customer id owned by another business, refuses the event (200, audited as
  `billing.webhook_refused`). A late event about an older, replaced subscription is ignored.
- Owners are emailed (best effort) on payment failure, trial ending and cancellation.

## Rollout

### 1. Stripe product and price (test mode first)

1. Dashboard > Product catalogue > Add product (for example "Recepcionista"), recurring price, monthly, your currency.
2. Copy the **price id** (`price_...`) into `STRIPE_PRICE_ID`. The trial is set per Checkout Session from `BILLING_TRIAL_DAYS`, so do not
   configure a trial on the price.

### 2. Webhook endpoint

Developers > Webhooks > Add endpoint: `https://<DOMAIN>/api/billing/webhook`. Events to send:

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.trial_will_end
invoice.paid
invoice.payment_failed
```

Copy the signing secret (`whsec_...`) into `STRIPE_BILLING_WEBHOOK_SECRET`. It is a different secret from `STRIPE_WEBHOOK_SECRET`
(deposits); do not reuse it.

### 3. Customer Portal

Settings > Billing > Customer portal: enable it, then allow customers to update payment methods, view invoices and **cancel subscriptions**
(cancel at end of period is recommended). Leave plan switching off unless you add more prices. Set the default return link to
`https://<DOMAIN>/dashboard/billing`. Without a saved portal configuration Stripe refuses to create portal sessions (the route answers 502).

### 4. Environment

| Variable | Notes |
| --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_...` until you have gone live. Shared with deposit links. |
| `STRIPE_PRICE_ID` | recurring monthly price |
| `STRIPE_BILLING_WEBHOOK_SECRET` | billing endpoint signing secret |
| `BILLING_TRIAL_DAYS` | 0-90, default 7 |
| `BILLING_ENFORCED` | production: REQUIRED, `true` (enforce) or deliberately `false`; unset/invalid is refused by deploy.sh and compose. Outside production only `true` enforces |
| `BILLING_PAST_DUE_GRACE_DAYS` | default 5 |
| `PLAN_SMS_CAP`, `PLAN_CALL_MINUTES_CAP` | default monthly caps (500 texts, 300 minutes); per-business overrides win |
| `BILLING_PLAN_NAME` | label stored on subscribed businesses, default `standard` |
| `BILLING_ALLOW_PROMO_CODES` | `true` shows the promotion code box in Checkout |
| `APP_URL` / `PUBLIC_BASE_URL` | return URLs; required in production |

`deploy.sh` refuses to deploy when `BILLING_ENFORCED` is unset/invalid, and with `BILLING_ENFORCED=true` unless `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and
`STRIPE_BILLING_WEBHOOK_SECRET` are set. In production a missing key or price makes checkout answer 503; the local mock never runs there.

### 5. Grandfather existing businesses (before enforcing)

Every existing tenant has `billing_status='none'` and would be locked out the moment `BILLING_ENFORCED=true`. Comp them first, as an admin
(Bearer `ADMIN_TOKEN` or an admin session):

```sh
curl -sS -X POST https://<DOMAIN>/api/admin/billing \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"business_id":"<id>","billing_status":"active","plan":"grandfathered","note":"existing customer"}'
```

Optional fields: `trial_ends_at`, `current_period_end` (ISO date or `null`), `sms_cap_override`, `call_minutes_cap_override` (integer or `null`
for the plan default). Every call is audited (`billing.admin_override`). Comp accounts must not be linked to a Stripe customer: a later Stripe
event for a linked customer overwrites the status. Admins also bypass the provisioning gate, so you can provision on a customer's behalf.

#### Bulk: `scripts/grandfather-existing.ts` (recommended for more than a handful of tenants)

Comping gives away paid service, so the script is deliberately narrow and needs an explicit cutoff:

```sh
# DRY RUN (default): prints the ELIGIBLE and SKIPPED lists with reasons, writes nothing
bun scripts/grandfather-existing.ts --force-i-know --before 2026-11-25T00:00:00Z
# comps exactly the eligible list you just read
bun scripts/grandfather-existing.ts --force-i-know --before 2026-11-25T00:00:00Z --apply
```

- `--before <ISO instant>` is **required** with `--apply`: use the moment signup went live / the deploy time. Only businesses created before it are touched.
- Skipped (with the reason printed): a business whose owners have no verified email; a self-signup business (an `auth.signup` audit row; override
  `--include-self-signup`, only after reading the list); a business whose owner phone is set but **not verified** (override `--include-unverified-phone`);
  anything that already has billing state (trialing, active, past_due, canceled, a Stripe subscription).
- It **never marks an owner phone verified**. Owners verify in Settings; for a legacy tenant who cannot, use the explicit `OWNER_PHONE_GRANDFATHER` switch below.
- For each eligible business: `billing_status='active'`, `plan='legacy'`. Idempotent; each change is audited (`billing.grandfathered`).

Run it where `DATABASE_URL` points at the production database (on the production host, through the one-shot tools container: `docker compose -f compose.production.yaml --profile seed run --rm seed bun scripts/grandfather-existing.ts --force-i-know --before <iso> [--apply]`; this only runs the script, nothing is seeded).
It uses the same safe-database guard as `seed`/`db-reset`: databases without a whole `dev`/`test`/`scratch`/`local` word in the name need `--force-i-know`.

#### Owner phones without the script: `OWNER_PHONE_GRANDFATHER`

Owner alerts only go to a *verified* owner phone. `OWNER_PHONE_GRANDFATHER=true` treats existing unverified `owner_phone` values as verified until their owners
re-verify. It is dangerous (those numbers bypass opt-outs and the country allow-list and were never proven to belong to the owner), so in **production it is ignored
unless `OWNER_PHONE_GRANDFATHER_ACK=i-understand` is also set**, deploy.sh refuses the combination without the ack, and the app logs a startup warning either way.
Always time-box it: `OWNER_PHONE_GRANDFATHER_BEFORE=<ISO>` (only businesses created before that instant, e.g. the deploy time) and
`OWNER_PHONE_GRANDFATHER_UNTIL=<ISO>` (expires; an unparseable value disables it). It does not touch billing. Turn it off once owners have verified. The seeded demo
business is created already verified and `active`, so a demo install needs neither.

### 6. Turn it on

1. Verify in test mode (checklist below).
2. Comp the existing tenants (step 5: `scripts/grandfather-existing.ts --before <deploy time>`) and confirm with `GET /api/billing/status?business_id=<id>` (`provisioning_allowed: true`).
3. Switch to live keys (live price id, live webhook endpoint and secret), set `BILLING_ENFORCED=true`, redeploy.
4. Roll back by setting `BILLING_ENFORCED=false` (the explicit opt-out; unsetting it enforces in production). Texts/calls are not refused again for existing tenants and billing data is kept, but non-admin provisioning still needs a plan. Do not do this with open signup.

## Test-mode checklist (Stripe CLI)

```sh
stripe login
stripe listen --forward-to localhost:3000/api/billing/webhook \
  --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.trial_will_end,invoice.paid,invoice.payment_failed
# copy the printed whsec_... into STRIPE_BILLING_WEBHOOK_SECRET and restart the app
```

- [ ] Sign up, verify the email, open `/dashboard/billing`, click **Start free trial**; pay with `4242 4242 4242 4242`. After the redirect
      the page shows "Free trial" with the countdown (status `trialing`, `trial_ends_at` and `current_period_end` set).
- [ ] Replay the same event from the Stripe dashboard (Resend): the webhook answers `duplicate: true`, nothing changes.
- [ ] `stripe trigger customer.subscription.updated` and `stripe trigger invoice.payment_failed`: triggered events use fixture customers that
      are not linked to a business, so they answer `ignored: unknown customer` (expected). To test for real, use the test clock below.
- [ ] Failed payment: subscribe with `4000 0000 0000 0341` (attaches, then fails on charge), advance a Billing test clock past the trial end.
      Status becomes `past_due`, the owner gets the email, the banner shows the grace period; after `BILLING_PAST_DUE_GRACE_DAYS` provisioning
      and sends are refused. Pay the invoice from the portal: `invoice.paid` returns the account to `active`.
- [ ] `customer.subscription.trial_will_end` (3 days before the trial ends, or with a test clock) sends the "trial ends soon" email.
- [ ] Cancel from the portal (at period end): `cancel_at_period_end` shows on the page; cancel immediately: status `canceled`, email sent.
- [ ] Resubscribe after cancellation: checkout works and does **not** grant a second trial.
- [ ] With `BILLING_ENFORCED=true`, a business with `billing_status='none'` gets `402 {"error":"billing_required","checkout":"/api/billing/checkout"}` from a
      non-admin provisioning call, an admin does not.
- [ ] Wrong secret / old timestamp: `curl` the endpoint with a forged `Stripe-Signature`: 400. With the secret unset: 503.

Local development without Stripe: leave `STRIPE_SECRET_KEY` unset and set `DEMO_MODE=true`; checkout then goes to
`/api/billing/mock-activate`, which starts a local trial for the signed-in owner. It does nothing in production or when a Stripe key is set.

## Releasing canceled tenants (numbers, agents)

A business whose subscription ended keeps its Twilio number (monthly rent) and its ElevenLabs agent until an operator releases them.
`scripts/release-canceled-tenants.ts` does that safely; **dry run by default**:

```sh
# on the production host (tools container), after reading the output of the dry run add --apply; run it daily from cron
docker compose -f compose.production.yaml --profile seed run --rm seed bun scripts/release-canceled-tenants.ts --force-i-know
docker compose -f compose.production.yaml --profile seed run --rm seed bun scripts/release-canceled-tenants.ts --force-i-know --apply
# options: --grace-days 30  --notify-days 7  --include-recent  --business <id>
```

Rules (`src/lib/billing/release.ts`; tested in `tests/release-decision.test.ts` and `tests/db/release-tenant.test.ts`):

- Only `billing_status` **canceled** or **unpaid**. Never trialing, active, past_due or none, never an admin-comped plan (`legacy`, `grandfathered`), never a business without
  a dated end (`current_period_end`, else `trial_ends_at`; set it with `/api/admin/billing` if missing).
- **Grace**: release date R = the end of the paid period (or the last admin override/comp, whichever is later) + `--grace-days` (default 30).
- **Heads-up e-mail** to every active owner `--notify-days` (default 7; `0` = no notice) before R, recorded as audit `billing.release_notice` with `meta.notified_at`
  so it is sent once per cancellation (a re-cancellation after an earlier notice mails again). The release itself only happens when now >= R **and** now >= `notified_at` + notify-days, so a late run
  never mails and releases in the same run. A business with no owner e-mail address is skipped (use the admin API with `skip_notice`).
- **Recent activity**: a business with calls in the last 7 days is skipped unless `--include-recent`.
- **Shared resources**: a number that another business also holds (same E.164) is never released at Twilio (only this business's reference is dropped); the platform's own
  `TWILIO_PHONE_NUMBER` is never released. The ElevenLabs agent is deleted (the shared phone number is detached from it first, best-effort), and the
  workspace tools (`/api/voice/tools/*`, shared by every tenant) are deleted **only when no other business still has an agent**; provisioning recreates them.
- Provider calls are idempotent: a 404 (already gone) is success; mock mode (no `TWILIO_*` / `ELEVENLABS_API_KEY`, mock-pool numbers, `mock_agent_*` ids) calls nothing. A provider failure leaves
  that database reference set, exits 1, and the next run retries.
- On success the business loses `phone`/`phone_e164`/`phone_key`/`agent_id` and becomes `paused`; audit `billing.tenant_released` (last 4 digits of the number only). Resubscribing and re-provisioning
  buys a new number: a released number cannot be recovered, which the heads-up mail says.

One business by hand, as an admin (Bearer `ADMIN_TOKEN` or admin session). `dry_run` defaults to **true**; `dry_run:false` performs one step (the heads-up, or the release when due):

```sh
curl -sS -X POST https://<DOMAIN>/api/admin/release-tenant -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"business_id":"<id>"}'                                   # what WOULD happen
curl -sS -X POST ... -d '{"business_id":"<id>","dry_run":false}' # send the heads-up / release when due
# optional: grace_days, notify_days, include_recent, skip_notice (explicit override of the heads-up wait; audited as notice "skipped")
```

## Operations

- Audit trail: `billing.checkout_started`, `billing.subscription_updated`, `billing.payment_failed`, `billing.invoice_paid`,
  `billing.webhook_refused`, `billing.admin_override`, `billing.release_notice`, `billing.tenant_released`.
- Lost webhook delivery: Stripe retries for 3 days; use "Resend" in the dashboard for older ones. State can always be set by hand with
  `/api/admin/billing`.
- Out-of-order events are tolerated for status transitions on one subscription (the last delivered wins); the first `checkout.session.completed`
  re-reads the subscription from Stripe when `STRIPE_SECRET_KEY` is set.
