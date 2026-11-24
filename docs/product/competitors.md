# Competitive landscape: AI receptionists for small home-service businesses

- **Research date:** 2026-11-23 (all retrieval dates below are this date)
- **Method:** vendor pages fetched directly with WebFetch, plus one WebSearch to find candidates. Search-result snippets from third-party blogs and review sites were **not** used for any price in this document. Where a vendor page was unavailable or unclear, the item is marked unverified.
- **Caveat:** pricing pages change often and some vendors show different prices on different tabs or pages. Re-check each row before using it in a pitch or a pricing decision.

## 1. Verified competitor pricing

| Vendor | Category and positioning | Verified pricing (as fetched) | Source | Verification |
| --- | --- | --- | --- | --- |
| **Smith.ai** | Hybrid: AI receptionist plus live human answering. The AI page lists booking, warm transfer, call recording, English and Spanish, and integrations including Clio (legal practice software). | AI Receptionist page: **Free** $0/mo, 25 calls/mo, $3.00/call overage (off by default); **Pro** $150/mo, overage $2.00/call, included calls not stated; **Enterprise** $500/mo, overage $1.67/call. Live-human add-on priced per call; not included by default. | `https://smith.ai/ai-receptionist` (2026-11-23) | Verified for that page. **Conflict:** `https://smith.ai/pricing` (2026-11-23) lists Starter $300/mo for 30 calls ($11.50/call over), Basic $810/mo for 90 calls, Pro $2,100/mo for 300 calls, with no setup fee. The page does not say which tab (AI-first, hybrid or human-first) it shows. Treat as two different products. |
| **Goodcall** | AI phone agent for small businesses. Meters by **unique customer**, not by minute. | Starter $79/mo, 100 unique customers, $0.79 per extra customer. Growth $129/mo, 500 customers, $0.26 each. Scale $299/mo, 2,000 customers, $0.15 each. Enterprise: volume pricing, not listed. No penalty rate on overage. No traditional free trial; a free demo agent can be built and tested, and billing starts when a number is connected. | `https://www.goodcall.com/pricing` (2026-11-23) | Verified |
| **Ruby** | Live, trained human receptionists. AI is an optional add-on, not the core product. | Startups $250/mo, 50 minutes. One-person businesses $395/mo, 100 min. Small businesses $720/mo, 200 min. Larger $1,725/mo, 500 min. Live chat plans from $143/mo. Overage rates not stated. | `https://www.ruby.com/pricing` (2026-11-23) | Verified. Included as the human-answering benchmark. |
| **Slang.ai** | Priced **per location**. The page mentions Airbnb Superhost status, which suggests a short-term-rental focus. Not confirmed as a home-service product. | Core $399/mo ($379 annual). Premium $599/mo ($539 annual, includes Superhost). Enterprise: custom. No included minutes or calls stated. | `https://slang.ai/pricing` (2026-11-23) | Verified for prices. Vertical fit **unverified** (inferred from the Superhost reference). |
| **Retell AI** | Developer platform for building voice agents. Would need work to become a product for a small business. | Pay as you go: no base fee; AI voice agents $0.07 to $0.31 per minute; $10 free credits; 20 concurrent calls included; additional concurrency $8 per concurrent call per month. Enterprise: custom. Currency is not stated on the page (assumed USD). | `https://www.retellai.com/pricing` (2026-11-23) | Verified. Platform, not a turnkey receptionist. |
| **Vapi** | Developer platform for voice agents. Provider costs are passed through. | No-success plan $0 base, $0.05/min hosting, $5 free credit. Core $29/mo (10 concurrent calls, 5 numbers). Pro: 10% of hosting fee, $999/mo minimum. Model and voice rates are listed per minute: Deepgram transcription $0.0095 to $0.0099; OpenAI model $0.0077 to $0.0452; ElevenLabs voice $0.0146 to $0.0238. | `https://vapi.ai/pricing` (2026-11-23) | Verified. Platform, not a turnkey receptionist. |
| **PolyAI** | Enterprise voice AI. Targets large volume: consumer services, financial services, healthcare, hotels, telecom, utilities. Named customers are large brands. | No prices on the homepage. Links to a pricing page that was not fetched. | `https://www.polyai.com/` (2026-11-23) | Homepage verified. **Pricing unverified.** Not a fit for SMB home services on positioning alone. |

## 2. Candidates with no verified pricing

| Vendor | Why it matters | What is unverified | Action |
| --- | --- | --- | --- |
| **Rosie** (AI answering for home services) | Closest to this product's segment | `https://www.rosieai.com/pricing` returned **HTTP 404**. The homepage (fetched 2026-11-23) says "Start free" and "No credit card" but shows no prices. Third-party blog snippets (search results, not fetched) cite a $49 starting price and plan tiers. **Those numbers are not used here.** | Find the live pricing or demo flow and record it with a date. |
| **Smith.ai** (other tabs) | Human-first tabs may matter for the owner's comparison | Which tab is current, and whether the $150 Pro and $300 Starter are the same product | Confirm with the vendor's sales or pricing page. |
| **Podium, Housecall Pro (AI features)** | Field-service software with AI call or text features. Could be bundled by owners who already pay for them. | **Not researched in this pass.** No prices or features recorded. | Research separately. Do not cite until verified. |
| **Slang.ai vertical** | Whether it serves home services | Vertical is inferred, not verified | Check the vendor's industry pages. |
| **Answering services generally** (for example, dozens of regional human services) | Price anchor for owners who use one | Not researched | Optional. Ruby and Smith.ai cover the price range. |

## 3. Price positioning (verified figures only)

| Band | Verified examples | Model |
| --- | --- | --- |
| Live human answering, roughly $250 and up per month | Ruby $250 to $1,725 | Included minutes, human staff |
| Hybrid or human-first, roughly $300 and up per month | Smith.ai Starter $300 (30 calls) | Per call, included calls |
| AI-first, roughly $79 to $150 per month | Goodcall $79 to $299 (by customers); Smith.ai Pro $150 | Per customer, or per call |
| Per location, $379 to $599 per month | Slang.ai | Per location, no minutes stated |
| Usage-based builders, cents per minute | Retell $0.07 to $0.31 per minute; Vapi $0.05/min plus pass-through | Per minute, no product |

**Implication for this product:** a flat plan around $149 per month (see `docs/product/monetization.md`) sits in the AI-first band, above Goodcall's entry plan and level with Smith.ai's AI Pro. The product's caps (300 minutes, 500 texts) are a clearer promise than Goodcall's per-customer metering, but they are not better value unless the owner's call volume fits under them. This is a judgement, not a measured comparison.

## 4. Differentiation for this product

Only features that are in the code today are listed. Each item cites its evidence. Competitor feature claims come from their public pages and are not tested.

| Differentiator | Evidence in this repo | Strength | Caveat |
| --- | --- | --- | --- |
| **Booking in local business time**, against the business's hours and existing bookings, with slot checks | `src/lib/scheduler.ts`, `src/lib/voice/tools.ts`, `tests/integration/` | Solid, tested | Competitors also book. Not a unique claim. |
| **Deposit payment links by text** to the caller's own number, capped at $500, Stripe-hosted (no card data over the phone) | `src/app/api/sms/payment-link/route.ts`, `src/lib/voice/tools.ts`, `src/app/api/payments/webhook/route.ts` | Strong for trades that need a deposit before a visit | No refund or dispute policy yet. |
| **Post-job gratitude and review texts**, consent-gated, with 4-5 star ratings sent to the review link and 1-3 star ratings routed to the owner | `src/lib/gratitude/index.ts`, `src/lib/gratitude/reply.ts`, `docs/compliance.md` | Strong if competitors lack it. Not verified against competitor features. | Runs hourly through the job runner (quiet hours and consent enforced); a manual `POST /api/gratitude/run` also exists. |
| **Daily briefing** of calls, bookings, revenue and flags | `src/lib/briefing/index.ts`, `src/app/api/briefings/generate/route.ts` | Useful for owners who are on job sites | Generated at 18:00 local time by the job runner (also on demand), and the owner is texted a link. Audio requires an ElevenLabs key. |
| **Compliance by design**: AI and recording disclosure before the greeting (English and Spanish), sticky declined-recording handling, STOP/START/HELP, texts only to verified owner phones for alerts, E.164 matching, retention controls | `src/lib/voice/elevenlabs.ts` (`firstMessageFor`), `src/lib/messaging/keywords.ts`, `src/lib/voice/owner-alert.ts`, `docs/compliance.md` | Strong and auditable within this codebase. Competitors' compliance features are **not verified**. | Legal review is still required. 10DLC registration is an operator task. |
| **911-first emergency rule** for gas, carbon monoxide, fire and smoke, in every production prompt | `src/lib/voice/emergency.ts`, `src/lib/kb/index.ts` | Matters for HVAC and plumbing | The agent is not an emergency service. |
| **Owner-controlled knowledge base** built from the website, editable before go-live | `src/app/api/extract/route.ts`, `src/components/dashboard/knowledge-editor.tsx` | Fast onboarding | Quality of extraction depends on the website. |

**Gaps versus the field** (verified on competitor pages, not on this product):

- **No live human transfer.** Smith.ai offers warm transfers, and Ruby is staffed by humans. This product flags a callback and texts the owner (`handoffToHuman` in `src/lib/voice/tools.ts`). For an emergency caller who wants a person, this is a real gap.
- **No recording player or live transcript** in the dashboard. Smith.ai lists call recording.
- **No proven accuracy.** No call-quality or booking-rate data exists yet.

## 5. Sources

Retrieved 2026-11-23 unless noted.

1. Smith.ai AI Receptionist: https://smith.ai/ai-receptionist
2. Smith.ai pricing: https://smith.ai/pricing
3. Goodcall pricing: https://www.goodcall.com/pricing
4. Ruby pricing: https://www.ruby.com/pricing
5. Slang.ai pricing: https://slang.ai/pricing
6. Rosie AI homepage: https://www.rosieai.com/ (pricing URL https://www.rosieai.com/pricing returned 404)
7. Retell AI pricing: https://www.retellai.com/pricing
8. Vapi pricing: https://vapi.ai/pricing
9. PolyAI homepage: https://www.polyai.com/

Search-result pages (WebSearch, not fetched, used only to find candidates; no figures taken from them): third-party comparison blogs and review sites for Smith.ai, Ruby, Goodcall and Rosie. They were not used for any price.
