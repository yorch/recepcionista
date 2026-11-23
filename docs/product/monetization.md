# Monetization proposal

- **Date:** 2026-11-23
- **Status:** proposal. Nothing here is priced in Stripe yet. The app ships with an env-driven price (`STRIPE_PRICE_ID`) and a free-text display string (`NEXT_PUBLIC_PLAN_PRICE_DISPLAY`).
- **Rule for this document:** every external vendor price is a placeholder or range and must be checked against the vendor's current pricing page before use. Nothing here is a vendor price fact.

---

## 1. What the product sells today (from code)

| Element | Implemented value | Source |
| --- | --- | --- |
| Plans | One monthly recurring price (Stripe `STRIPE_PRICE_ID`), plan label `BILLING_PLAN_NAME` (default `standard`) | `docs/billing.md`, `src/lib/providers/stripe-billing.ts` |
| Free trial | `BILLING_TRIAL_DAYS`, default **7**, range 0 to 90. Card on file required at Checkout. | `src/lib/providers/stripe-billing.ts` (`DEFAULT_TRIAL_DAYS = 7`) |
| One trial per person | Normalised owner email and Stripe card fingerprint, stored as HMAC. A repeat starts paid. | `src/lib/billing/trial.ts`, `docs/billing.md` |
| Monthly text cap | `PLAN_SMS_CAP`, default **500** per business per calendar month (business time zone). Per-business override column wins. | `src/lib/db/usage.ts` |
| Monthly call-minute cap | `PLAN_CALL_MINUTES_CAP`, default **300** minutes per business per month. Per-business override wins. | `src/lib/db/usage.ts` |
| Past-due grace | `BILLING_PAST_DUE_GRACE_DAYS`, default **5** days of continued service | `src/lib/db/usage.ts` |
| Gate | No number or agent is provisioned without an active or trialing plan in production | `src/lib/billing/gate.ts` |
| Over cap | Texts are logged `blocked_cap` (owner alerts and STOP/HELP replies still go out and count). Calls get an out-of-service line and a 60-second cut-off. | `docs/compliance.md` |
| Customer billing | Stripe Checkout, Customer Portal (cancel at period end), dunning emails on failure | `src/app/api/billing/*`, `docs/billing.md` |

**Counting detail that affects cost.** The text cap counts one unit per message send, not per SMS segment (`src/lib/messaging/index.ts`, `meterSms(businessId, n = 1)`). A long message is billed by the carrier per segment, so the cap understates real text cost. Call minutes are added once per conversation by the post-call webhook. A conversation whose post-call never arrives is not metered, which understates call cost.

**Not built:** add-on minute packs, extra numbers per business (each business has one `phone` field), annual prepay, per-location pricing, trial-specific caps. See section 6.

## 2. Pricing model proposal

**Recommendation: one plan, flat monthly fee, included caps, overage blocked rather than billed.** This matches the current code. Overage billing would need metered Stripe prices and usage reporting, which are not built.

| Plan element | Proposal | Rationale |
| --- | --- | --- |
| Monthly price | **$149/mo** (placeholder; test $99, $149, $199 in the trial cohort) | The cap cost (section 3) must sit well under the price. Competitors in this range are listed in `docs/product/competitors.md`. |
| Included texts | 500 per month (current default) | Roughly 150 bookings at about three texts each (confirmation, payment link, follow-up). |
| Included call minutes | 300 per month (current default) | At an assumed 3-minute average call, about 100 calls per month. |
| Trial | 7 days, card on file (current default) | See section 5 for the trial-cost issue. |
| Overage | Blocked at cap with an honest out-of-service line. Upsell path in section 6. | Matches code. Predictable bill for the owner. |
| Setup fee | None | Keeps trial-to-paid simple. Re-evaluate if provisioning cost rises. |

Set `NEXT_PUBLIC_PLAN_PRICE_DISPLAY` to the chosen string (for example "$149/month after a 7-day free trial") only after the Stripe price exists. The current display copy in `src/app/site-config.ts` is a generic placeholder.

## 3. Unit economics (sketch with labelled assumptions)

### 3.1 Cost lines per business per month

Every line is a placeholder. Replace each with the current vendor price on the day you model it.

| Cost line | Unit | Assumed cost (ASSUMPTION) | How to verify |
| --- | --- | --- | --- |
| Phone number (Twilio local, US) | per number per month | ~$1-2 (verify current pricing) | Twilio console price list |
| Inbound voice minutes (telephony) | per minute | ~$0.01-0.02 (verify current pricing) | Twilio Voice price list |
| Agent conversational minutes (ElevenLabs Agents) | per minute | ~$0.08-0.25 (verify current pricing; plan-dependent) | ElevenLabs pricing page |
| LLM tokens for the agent | per call | ~$0.005-0.03 (verify current pricing; model-dependent) | OpenAI or Anthropic pricing pages |
| Outbound SMS (US) | per segment | ~$0.008-0.015 (verify current pricing; 10DLC fees extra) | Twilio Messaging price list |
| 10DLC brand and campaign fees | monthly, per campaign | verify current pricing | Twilio 10DLC pricing |
| Briefing TTS (ElevenLabs) | per briefing | small (verify current pricing) | ElevenLabs pricing |
| Hosting, database, email, monitoring | per tenant (shared) | ~$5-15 per tenant at 50 tenants (ASSUMPTION; infra-dependent) | Your own hosting bills |
| Payments | per charge | Stripe standard card fee, verify current pricing | Stripe pricing page |

**Third-party reference points, fetched 2026-11-23 and not verified against the vendor's own pricing page:** the Vapi pricing page lists Deepgram transcription at $0.0095 to $0.0099 per minute, OpenAI model cost at $0.0077 to $0.0452 per minute, and ElevenLabs voice at $0.0146 to $0.0238 per minute (`https://vapi.ai/pricing`). Retell AI lists AI voice agents at $0.07 to $0.31 per minute (`https://www.retellai.com/pricing`). Both are platform rates that include their own margin and differ from what this app pays. Use them only as sanity checks.

### 3.2 Cost at the cap (worst case per business per month)

Assumptions for the table below (ASSUMPTION): voice all-in cost $0.10 to $0.30 per minute (telephony, agent, LLM); SMS $0.01 to $0.02 per segment with 1.5 segments per text on average; one number at $1.50.

| Scenario | Calculation | Cost range |
| --- | --- | --- |
| 300 call minutes at cap | 300 x $0.10 to $0.30 | $30 to $90 |
| 500 texts at cap (1.5 segments each) | 500 x 1.5 x $0.01 to $0.02 | $7.50 to $15 |
| One number | fixed | ~$1.50 |
| Shared hosting per tenant | placeholder | $5 to $15 |
| **Total at full cap** | | **~$44 to $122** |

**Reading:** at $149 a month, a business that uses its full cap costs between about 30% and 80% of the price before payment fees. Most businesses should use less than the cap (to be measured). The top of the range leaves little margin, so the cap is the control that protects the margin.

### 3.3 Break-even

Let price be P, payment fees f (percentage plus fixed), usage cost at expected usage v, and fixed platform costs F per month (DPAs, legal review, monitoring, tooling; placeholder).

- Contribution per business = P − f·P − v − h, where h is hosting per tenant.
- Break-even businesses = F ÷ contribution per business.

Example with placeholders: P = $149, f = 3% + $0.30 (verify current Stripe fees), v = $25 (expected usage, ASSUMPTION), h = $8, F = $1,500/month. Contribution ≈ $149 − 4.77 − 25 − 8 ≈ $111. Break-even ≈ 14 paying businesses. Recompute once measured usage replaces v.

### 3.4 Cap-setting guidance

1. Start with the current defaults (500 texts, 300 minutes) and do not change them before measuring. The app already counts usage per business.
2. After 30 days with real traffic, set the cap at about the 90th percentile of usage for paying businesses, not the average.
3. Use the per-business override columns for exceptions (for example a high-volume plumber). Do not change the global default for one customer.
4. Warn the owner at 80% of each cap. There is no warning email today. Add one before the first paid cohort.
5. Make the trial cap lower than the paid cap (section 5).

## 4. Upsell paths (none built; order of build)

| Path | What it needs | Notes |
| --- | --- | --- |
| **Minute packs** (for example +100 min for a fixed fee) | Second Stripe price; a per-business cap override bump on payment; webhook handling | Cheapest path. Keeps the flat-plan model. |
| **Text packs** (+500 texts) | Same as minute packs | Count segments before selling this (section 6). |
| **Extra numbers** (second line or department line) | Multiple numbers per business. Today each business has one `phone` field and one agent. | Real engineering work in provisioning and routing. |
| **Multi-location** | Multiple businesses under one billing account. Today one owner account equals one business. | Largest change. Defer until demand is proven. |
| **Live human backup** (human answers after hours, or on transfer) | Human-answering partner or in-house on-call; live transfer is not built | Competitors sell this as the premium tier (see `competitors.md`). Adds cost and an operations burden. |
| **Annual prepay** | Annual Stripe price with discount (for example 2 months free) | Improves cash and churn. Simple to add. |

## 5. Trial and churn considerations

**Trial cost exposure.** A trialing business can use the full monthly cap (300 minutes, 500 texts) within the trial period. That is the cost in section 3.2, with no revenue yet. The code has no trial-specific cap; the only controls are the per-business override columns. Recommendation: set a lower default override at trial start (for example 60 minutes and 100 texts) and raise it on conversion. This needs a small code change in `src/lib/db/usage.ts` and is not built.

**Trial length.** Seven days is short for an owner who must verify a phone, review the knowledge base, and forward the line. The "Connect" step can take days if the carrier's forwarding is unclear. Test 14 days against 7 days in the first cohort and watch the activation metric (PRD section 10).

**Card-on-file and abuse.** Checkout requires a card, which helps. The one-trial-per-person rule uses email and card fingerprint. A determined user can still create new emails and cards. The trial cap is the real limit.

**Churn drivers to watch:**

- Calls not forwarded (owner never completes the Connect step). Measure time from paid to first call.
- Callers who decline the recording disclosure, which removes transcripts from the dashboard. Owners may read that as the product failing.
- Owner alert phone not verified, so emergency alerts never reach them. Show this as a banner until fixed.
- Past-due cancellations. The 5-day grace period plus dunning emails are the controls; measure recovery rate.
- Over-cap moments. A blocked call is a visible failure to the owner. Alert before the cap, not after.

**Cancellation.** Portal cancellation runs at period end (`cancel_at_period_end`), which is the right default. Do not add a pause option until there is demand; a pause would need a new billing state.

## 6. Gaps that block the pricing model

1. **Segment-based text metering.** Without it the text cap undercounts cost. Fix before the first paid cohort.
2. **Trial-specific caps.** Section 5. Fix before opening signup widely.
3. **Missed post-call metering.** A call whose post-call webhook never arrives is never metered. Add a reconciliation or a fallback duration from the provider.
4. **Cap warnings to the owner.** Section 3.4.
5. **Mock number fallback.** A failed Twilio purchase assigns a fake number and sets the business live (see PRD section 9). A fake number consumes no cost but also gives the owner a line that never rings. This is a churn risk and a billing-trust risk.

## 7. Items to verify before any public price

- [ ] Stripe price created in live mode; `STRIPE_PRICE_ID` set; webhook secret configured (`docs/billing.md` step 6).
- [ ] Current Twilio, ElevenLabs, OpenAI or Anthropic, and Stripe prices, recorded with the date.
- [ ] Counsel review of the trial and auto-renewal disclosures (state auto-renewal laws; Florida rules; verify).
- [ ] Cap defaults reviewed against measured usage from at least 30 days of paying businesses.
- [ ] Refund policy written and linked from Checkout.
