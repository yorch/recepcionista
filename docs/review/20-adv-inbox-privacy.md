# 20. Adversarial review: inbound SMS inbox, auto-reply, owner forward, manual text, SMS log, privacy export/erase, review URL

Scope: the branch's work against `origin/main` (commits `f753f48`, `5fdd2e9`, `8f29743`) in this slice: `src/app/api/sms/inbound`,
`src/lib/messaging/{inbox,inbox-copy,inbox-view,manual,privacy-api}.ts`, `src/lib/db/inbound-messages.ts`, the
`/api/businesses/:id/{messages,privacy,review-url}` routes, the dashboard Messages page and components, the privacy tools, and the gratitude/template changes.
Design references: `docs/design/mock-replacement-contracts.md` and `docs/review/18f` section 5B.

Method: I read the code and reproduced the findings with a throwaway bun test (`rev20.test.ts` in the session scratchpad, not in the repo). It ran against my own
database `rev_inbox_test`, which had `prisma migrate deploy` applied and was dropped afterwards. All 5 repro cases ran as described below.

## Findings (ranked)

### H1 (High). Every inbox text goes out from the shared `TWILIO_PHONE_NUMBER`, so the two-way conversation does not work, and a STOP sent in reply is never recorded
- **Where:** `src/lib/providers/twilio.ts:105` (`From: process.env.TWILIO_PHONE_NUMBER`). This is reached from `sendAndLog` at `src/lib/messaging/index.ts:131`, which is the path for:
  - the auto-reply (`inbox.ts` `autoReply`),
  - the owner's reply (`messages/[messageId]/reply`),
  - manual texts (`messages/send`),
  - the owner forward.

  On the inbound side, `src/app/api/sms/inbound/route.ts:45` resolves the business from `To` with `getBusinessByPhone`. The platform sender belongs to no tenant, so the text is logged as `unrouted` and nothing else happens.
- **Scenario:**
  1. A customer texts tenant B's own line, `+1305...3068`.
  2. The auto-reply arrives from a different number (the platform sender). It says "Reply STOP to opt out".
  3. The customer replies STOP, or answers the owner's dashboard reply. That text goes to the platform sender.
  4. The repro (R5) shows the route answers `200 <Response></Response>` and the customer is **not** opted out at tenant B.
  5. The owner's next manual text or reply to that customer goes out anyway. The customer's answer never reaches the inbox either.

  In practice the "conversation thread" only works in a single-tenant deployment where the business line *is* `TWILIO_PHONE_NUMBER`.
- **Why it matters:**
  - The branch added three new customer-facing kinds (`inbox_autoreply`, `owner_inbox_reply`, `manual`). Each carries a STOP footer that cannot work from a multi-tenant sender.
  - This is a CTIA/TCPA opt-out failure and an A2P 10DLC reputation risk.
  - The pre-existing version for confirmations was noted in report 07 ("STOP to the platform sender does not map to any business"). The new inbox makes it the main path, and `known-limitations.md` does not mention it.
- **Fix:**
  - Send with `From = business.phone_e164` (the tenant's own Twilio number) whenever the tenant has one, and keep the platform sender only as a fallback. Or use a per-tenant Messaging Service.
  - Until that ships, handle inbound texts to `TWILIO_PHONE_NUMBER`: look up the last outbound `sms_log` row to that `From` to find the business, then apply STOP/START there (or opt the sender out platform-wide) and store the text in that business's inbox.
  - Add a test that sends STOP to the platform sender after an auto-reply.

### H2 (High). Erasure and export miss the owner-forward copy of the customer's text
- **Where:**
  - `src/lib/messaging/inbox.ts:139-140`: the forward body is `Customer text (...1234): "<up to 140 chars of the customer's words>"`. It is sent through `alertOwner`, which passes no `booking_id` (`src/lib/voice/owner-alert.ts:144`).
  - `src/lib/db/compliance.ts:412-421`, `locateCustomerRecords`: it matches `sms_log` rows by `to_*`, `booking_id`, the full national digits in the body, or owner alerts that contain the customer's *name*. The forward row matches none of these: it goes to the owner, has no booking, shows only 4 digits and has no name.
- **Repro (R1):**
  1. A customer texts "...call me back about the HIV test results".
  2. `exportCustomerData` returns only the `inbox_autoreply` row.
  3. `eraseCustomerData` deletes the inbox row.
  4. The `owner_alert` row with the quoted text **is still in `sms_log` after erasure**.

  The owner can also still read it in the Text log tab (`getMessageLog` direction `out`).
- **Fix:**
  - Link the forward to its source. Add `inbound_message_id`, or store the sender's E.164 in a column on the forward's `sms_log` row: pass `to_e164`-like metadata, or a `subject_e164` column.
  - Delete and export by that link. Alternatively, write the forward's log row with a redacted body (`[customer text]`) so the content lives only in `inbound_messages`.
  - Add a regression test: forward, then erase, then 0 `owner_alert` rows that quote the body.

### M1 (Medium). One phone number can block the inbox for every other customer; their texts are dropped without being stored
- **Where:** `src/lib/messaging/inbox.ts:94-97`. The business budget (`inbox:biz:*`, 300/h) is counted **before** the per-sender budget, and `rateLimit` counts rejected attempts too (`src/lib/ratelimit.ts` header: "Rejected attempts still count").
- **Repro (R2):**
  1. A single sender texts 301 times.
  2. Only 10 of those texts are stored.
  3. A real customer's "my AC is leaking, can someone come today?" is then dropped as `business_rate_limited`: not stored, not forwarded, not answered.

  A sender who keeps texting (about one every 12 s) keeps the business locked indefinitely, because the sliding window never drains. The cost is a few dollars of SMS from one SIM.
- **Fix:**
  - Check the per-sender limit first, and only call the business limiter for texts the sender limit allows. Use a "peek, then count on success" pattern, as `peekRateLimit` already exists.
  - Consider storing over-budget texts with `status='ignored'` and `handled_by='auto:flood'` rather than discarding them. Then only forwarding and auto-replies are limited, never the record.

### M2 (Medium). An opt-out request in free-form wording still gets the auto-reply
- **Where:** `src/lib/messaging/inbound.ts:58` only logs `possible_revocation`. `inbox.ts:120-121` then forwards the text and calls `autoReply` without checking `mentionsStopWord` or any revocation phrasing.
- **Repro (R3):** "Stop. Who is this?", "Don't text me again", "Please remove me from your list" and "unsubscribe me from this list now" each got an `inbox_autoreply` and stayed `opted_out: false`.

  The FCC's 2024 revocation rule (any "reasonable means") makes a marketing-style acknowledgement to these senders a compliance risk, and the reply came from a number the customer never texted (see H1).
- **Fix:**
  - In `handleInboundText`, skip the auto-reply when `mentionsStopWord(body)` is true or a small revocation lexicon matches ("don't text", "remove me", "no more texts", "leave me alone", "wrong number").
  - Flag the inbox row, for example `handled_by='auto:possible_revocation'`, so the owner sees it and can opt the sender out.
  - Optionally add an "Opt out this number" button in the detail view.

### M3 (Medium). The forward to the owner keeps bare-domain links, so the business line can be used to phish the owner
- **Where:** `src/lib/messaging/inbox-copy.ts:50`. `URL_RE` only strips `http(s)://...` and `www....`.
- **Repro (R4):** the input "URGENT Recepcionista billing: account suspended, re-verify at recepcionista-billing.com/login or bit.ly/3xYz now" is forwarded to the owner verbatim. Phones turn both strings into links.

  The text arrives from the platform number the owner trusts, which defeats the stated rule "never carries a link a stranger typed" (`inbox-copy.ts:4`). The `"` to `'` swap still allows near-convincing quote breaking.
- **Fix:**
  - Also replace `\b[\w-]+(\.[\w-]+)+(/\S*)?` (anything that looks like a domain) and bare IP addresses.
  - Or drop the quoted body entirely and send "New customer text from ...1234, open Messages".
  - Add a unit test with `bit.ly/x` and `evil.com/login`.

### M4 (Medium). A single sender can use up the owner-forward budget for the hour
- **Where:**
  - `inbox.ts:132`: the forward budget `inbox-forward:hour:<business>` is per business only, with a default of 10.
  - `inbox.ts:31`: the per-sender inbox limit is also 10 per hour.
- **Scenario:**
  1. One number sends 10 non-trivial texts, which the R2 setup confirms are all stored.
  2. All 10 forwards are spent.
  3. Every real customer text for the rest of the hour gets `forward: 'budget'`. It is never forwarded later (documented), so the owner is not told about it.
- **Fix:** cap forwards per sender, for example 2 per hour (then one "N more texts from ...1234" summary), before the per-business budget is spent.

### L1 (Low). The auto-reply and manual texts go to Caribbean and other high-rate +1 numbers
- **Where:**
  - `inbox.ts:80`: `e164Eligible` checks only the length.
  - `manual.ts:62-70`: no destination vetting beyond `SMS_ALLOWED_COUNTRY_CODES`, whose default "1" includes +1 876/809/268... .
- **Scenario:** inbound texts from attacker-owned NANP Caribbean numbers each earn one auto-reply per 24 h (up to the 300/h business budget). That is a small SMS-pumping and revenue-share surface on the tenant's plan cap and the platform's Twilio bill.
- **Fix:** reuse the forward-number NANP deny list (`forward-vet.ts`: Caribbean, 670/671/684, toll-free, 900/976) for `inbox_autoreply`, and require it for `manual` unless a booking exists for that number.

### L2 (Low). Values derived from the erased number survive erasure for up to 3 hours
- **Where:** the `rate_limit_buckets` keys `inbox:sender:<biz>:<E.164>` and `manual-sms:to:<biz>:<E.164>` (`inbox.ts:96`, `manual.ts:75`). They are kept until `CLEANUP_HORIZON_MS` (3 h).
- **Fix:** delete `rate_limit_buckets` rows whose key ends with `:<e164>` inside `eraseCustomerData`, or hash the number in the key.

### L3 (Low). A long review URL that passes validation is cut off in the review text
- **Where:**
  - `validateReviewUrl` allows 300 characters (`business-config.ts:16`).
  - `reviewRequestSms` clips the body to 300 (`templates.ts:94-95`).
  - `withStopFooter(body, 300)` then trims the body again to fit the footer, cutting from the end, so the link breaks first after the signature.
- **Scenario:** any review link longer than about 200 characters (Google's long `search?...#lrd=` share links are common) reaches the customer cut off with `...`. The link is dead.
- **Fix:**
  - Lower `REVIEW_URL_MAX` to around 120 and say so in the UI. Google's `g.page/r/...` short links fit.
  - Or build the text so the link is never trimmed: trim the name and signature first.

`validateReviewUrl` itself is sound: it requires `https:`, rejects `javascript:`, credentials and whitespace, and the dashboard never renders the link as an `href`.

## Checked and found sound (not findings)
- **Tenant isolation.**
  - Every inbox, log, reply and triage query is scoped by `businessId`.
  - `getInboxDetail` re-checks that the booking belongs to the business, and `linkInboundToBooking` checks the booking's business.
  - The reply recipient is taken from the stored message, never from the client.
  - A sid already owned by another business is refused.
- **Sid dedupe.** There is a global unique index, and a P2002 race returns the existing row. Redeliveries skip the flood budgets but cannot re-forward or re-reply, because both are first-stamp-wins.
- **STOP ordering.**
  - STOP, START and HELP are handled before the owner code, cancel, rating and inbox steps.
  - Keyword texts are never stored.
  - Texts from the owner's own phone and from the business line are not stored.
- **Quiet hours, opt-out and cap.**
  - Manual texts and replies refuse quiet hours in `manual.ts`.
  - `sendAndLog` enforces opt-outs and reserves the cap atomically.
  - The auto-reply is customer-initiated, so it is not held to quiet hours, which is acceptable.
- **XSS.** Inbound bodies are rendered as React text only. There is no `dangerouslySetInnerHTML` in the messages or privacy components, and the only `href` is `tel:${from_e164}`, built from a CHECK-constrained E.164 value.
- **Privacy routes.**
  - All three are owner-only.
  - Export and erase require step-up (`requireRecentAuth`) before any budget is spent.
  - The typed word `ERASE` is checked on the server; the client check is only cosmetic.
  - Each route has its own failClosed hourly budget.
  - Audit rows carry the last 4 digits only, and the number travels in the POST body, not the URL.
- **Retention.** `purgeExpiredData` deletes `inbound_messages` by `retention_days`.
- **Erasure of `inbound_messages` and outbound replies.** Both are deleted: the replies by `to_e164`. The only exception is H2.
- **Leftover mocks.** None remain in the production paths here. The auto-reply and manual texts count `mock` as delivered only outside production (`smsDelivered`, `mockSmsAllowed`), and owner-verification codes are withheld from `sms_log`, so the staff-visible log never shows them.

## Resolution

Every finding is fixed, with the residuals listed under it. Tests: `tests/review19-pure.test.ts`, `tests/integration/review19.test.ts`, `tests/messaging-inbox-pure.test.ts`, `tests/integration/messages-inbox.test.ts`.

| Finding | Status | Fix and evidence |
| --- | --- | --- |
| H1 shared sender loses STOP and replies (High) | Fixed | Every `sendAndLog` text (auto-reply, owner reply, manual, owner forward, confirmations, payment links...) goes out FROM the tenant's own purchased number (`tenantSmsSender`: a real number, not mock-pool, not the shared sender). `sendSms` retries once from the shared sender when Twilio refuses the number as a sender (21212 / 21606 / 21659 / 21660). The shared sender (`TWILIO_PHONE_NUMBER`) stays the fallback for a tenant without a real number and for owner verification codes; `/api/sms/inbound` (and the legacy gratitude route) route a text sent TO the shared sender by the LAST OUTBOUND text to that customer (30 days, new index `sms_log (to_e164, created_at)`), and a STOP there opts the customer out of every business that texted them from it. Tests `20 H1` x3 (tenant From on forward, auto-reply and manual; STOP to the tenant number; mock-pool fallback and last-outbound routing incl. two businesses and an unrouted stranger; 21606 retry), pure `20 H1`. Residual: carriers filter unregistered A2P numbers (register them, runbook section 8; documented). |
| H2 erasure / export miss the owner-forward copy (High) | Fixed | The forward's sms_log row keeps NO customer words (`sendAndLog({ log_body })`, `ownerForwardLogText`): the words live only in `inbound_messages`, which export and erasure already cover. Forward rows written by the old code are matched by shape + last 4 digits + the opening words of one of THAT customer's own inbox texts (another customer with the same last 4 is never matched). Test `20 H2` (no words in the log, export contains the legacy row, erasure deletes it, the other customer's row survives). Residual: the SMS the owner receives still quotes up to 140 characters (it is the point of the forward); documented. |
| M1 one number blocks the inbox (Medium) | Fixed | The per-sender budget is checked first and the business budget is spent only by texts it lets through. Test `20 M1` (25 texts from one number: 10 stored, the next customer stored, business bucket <= 11). |
| M2 free-form opt-out gets the auto-reply (Medium) | Fixed | `looksLikeRevocation` (stop words plus a plain-language lexicon, EN/ES): no auto-reply, the row is flagged `auto:possible_revocation`, the owner's forward starts with "Possible opt-out", the inbox shows a badge and a one-tap "Opt this number out" (`POST .../messages/:id/opt-out`, audited with the last 4 only). Not an automatic opt-out ("stop by at 5" is ordinary): documented. Test `20 M2`, pure `20 M2`. |
| M3 bare-domain links in the forward (Medium) | Fixed | `URL_RE` masks scheme / www links, bare domains with an optional path, shorteners and IPs (`[link]`); decimals, times and phone numbers are kept. Pure `20 M3`. |
| M4 one sender spends the forward budget (Medium) | Fixed | At most 2 forwards per sender per hour (`INBOX_SENDER_FORWARD_HOURLY_LIMIT`), checked before the business budget, so the business budget is only spent by texts that went out. The optional "N more texts" summary was not built (the inbox badge counts them). Test `20 M4`. |
| L1 Caribbean / premium destinations (Low) | Fixed | `highRateNanpDestination` (the forward-number deny list + 976): no auto-reply, and a manual / reply text there needs a booking (`high_rate_destination`, HTTP code `not_allowed`). Test `20 L1`, pure `20 L1`. |
| L2 number-derived limiter keys survive erasure (Low) | Fixed | `eraseCustomerData` deletes `rate_limit_buckets` keys that end with `:<business>:<e164>`. Test `20 H2`. |
| L3 long review link cut (Low) | Fixed | Limit 120 characters in the API/UI (the DB CHECK still allows 300 for links saved earlier) and `reviewRequestSms` never cuts the link: the words around it shrink in tiers, and a link that cannot fit gives the text without a link. Pure `20 L3`, `tests/business-config.test.ts`. |
