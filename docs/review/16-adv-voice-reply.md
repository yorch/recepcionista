# 16. Adversarial review: owner voice reply channel (64e46fa)

Scope: `src/lib/voice/owner/reply-*.ts`, `src/lib/messaging/owner-reply.ts`, the reply-code branch in `src/lib/voice/owner/sms.ts`, the
owner specs, prompt and tools, migration `20261205120000_owner_replies`, and the dashboard card `src/components/dashboard/owner-replies.tsx`.
Method: code reading plus repros. The repros ran on a private database (`rev_voicereply_test`, created, migrated with `prisma migrate deploy`
and dropped by this review; no `scratch*` database was touched) from throw-away test files in the session scratchpad. No repo files changed
apart from this report.

Verdict: the core send path holds up. The model never names a recipient. The atomic `proposed -> sending` claim stops replays and racing
YES texts for one code. Codes are scoped per business and per reply, and opt-out and quiet hours are re-checked when the text is sent. I
found no Critical. **One High:** a caller who spoofs the owner's number can read every lead, not just the five the docs promise, and can hide
those leads from the real owner. Two Medium findings and three Low ones follow.

| # | Severity | Area | One line |
| --- | --- | --- | --- |
| H1 | **High** (privacy/integrity, reproduced) | `reply-tools.ts` `handled` | `mark_lead_handled` has no limit and needs no confirmation, so a spoofed owner call can walk through every lead of the last 7 days (25 of 25 in one call in the repro) and leaves the real owner hearing "no recent customers" |
| M1 | Medium (reproduced) | `messaging/owner-reply.ts` catch block | A failure after the provider accepted the text marks the reply `failed`, tells the owner "could not be sent", leaves no `sms_log` row, and the duplicate guard then lets a second copy go out |
| M2 | Medium (reproduced) | `messaging/owner-reply.ts` daily cap | `OWNER_REPLY_DAILY_LIMIT` is a count-then-send check: 8 YES texts sent at once with the limit set to 3 delivered all 8 |
| L1 | Low (reproduced) | `reply-text.ts` scanner | Phone numbers and codes get past the scanner when written with `/` separators, full-width or Arabic-Indic digits, vanity numbers (`1-800-FLOWERS`), mixed spelled-out digits, homoglyphs (`gіft card`) or spaced-out brand names (`Zel le`, `C a s h A p p`) |
| L2 | Low | `reply-text.ts:265` confirmation SMS | The spoof warning says "Not you? Reply NO." with no code. A bare `NO` is silently ignored, so an owner who follows the warning cancels nothing |
| L3 | Low | `sending` rows / erasure residue | A crash between the claim and the send leaves a row in `sending` forever, and the dashboard shows it as "waiting". Erasure leaves the `owner-lead-handled` marker, an unkeyed and brute-forceable SHA-256 of the phone number |

---

## H1. A spoofed owner call can list every lead and hide them all from the real owner (High, reproduced)

**Where.** `src/lib/voice/owner/reply-tools.ts:174-182` (`handled`), `src/lib/voice/owner/reply-leads.ts:80-83,112` (`markHandled`, `isHandled`
filter in `collectLeads`). The only limit is `OWNER_REPLY_LISTS_PER_HOUR`, which is per call (`reply-tools.ts:79`).

**What.** `docs/owner-call-in.md` ("Privacy") accepts that a spoofed caller id "can still hear first names, last 4 digits and times of
**the five latest leads** (nothing else ...)". In practice the limit is not five:

1. `mark_lead_handled` has no rate limit, no per-call cap and no strike, and it needs no SMS confirmation. It writes a handled marker for
   the customer's number right away.
2. `collectLeads` leaves handled numbers out, so the next `list_recent_leads` returns the next five.
3. The list limiter is 6 per call per hour and the call id is part of its key. The unverified class gets 10 sessions a day, so a spoofer
   can list 6 x 5 = 30 leads per call and about 300 a day. That is more than `collectLeads` can ever reach (60 calls + 60 bookings in the
   7-day window), so in effect it exposes every recent lead.

Repro (scratchpad `adv.test.ts`, test A): 25 customer calls, then one owner call with no verstat (exactly what a spoofer presents). Five
rounds of list + `mark_lead_handled 1..5` disclosed **25 distinct leads** (first name, last 4 digits, kind, time). A second "real owner"
call then got *"There are no recent customers waiting for a reply."*

**Impact.** Spoofing caller id costs very little, and `OWNER_REPLY_REQUIRE_ATTESTATION` is off by default.
- **Privacy:** an attacker can list who contacted the business in the last week. In the dental vertical that means "an emergency call from
  Maria, ending 4821": a patient relationship plus urgency, which is health-adjacent data.
- **Integrity:** every lead can be silently marked handled. An emergency caller disappears from the owner's phone triage, and no SMS
  tells the real owner, because `handled` texts nothing.

**Fix (any of these, preferably combined).**
- Cap how many distinct leads one call and one trust class can disclose per 24 h (for example 5 per call and 10 per day for
  `unverified`). Count `mark_lead_handled` against the list budget.
- Make `mark_lead_handled` work only for `verified` calls, or require a YES code for it like the other writes. Alternatively, keep the
  marker per trust class, so that an unverified call only hides leads from unverified listings.
- Let the dashboard show and undo handled markers.
- Correct the docs claim, or turn `OWNER_REPLY_REQUIRE_ATTESTATION` on by default for healthcare verticals.

---

## M1. A failure after the send is reported as "not sent", and a second copy can follow (Medium, reproduced)

**Where.** `src/lib/messaging/owner-reply.ts:407-430`. `sendAndLog` (`src/lib/messaging/index.ts:116-155`) calls the provider first and
only then writes `logSms`. Any exception from `logSms`, from `finish()` or from `auditReply` lands in the catch block.

**What.** The catch block always runs
`updateMany({ status: 'sending' } -> { status: 'failed', refuseReason: 'error' })` and returns `{ kind: 'failed' }`. The owner is then
told *"The text could not be sent, and it will not be retried. Nothing more was done."* This contradicts the file's own comment ("The row
stays 'sending' unless the failure came before the provider call") and the docs ("the owner is not told it was sent").

The duplicate guard (`:400`) counts only `status: 'sent'`. An owner who believes the failure message drafts the same words again, gets a
new code, says YES, and the customer receives the message a second time.

**Repro** (test C). A database trigger in the private test DB made `INSERT` into `sms_log` fail for `kind='manual'`:
- The mock provider printed `IT Business ...: See you at 9. Reply STOP to opt out`, so the text went out.
- The usage counter rose (the reservation was not refunded, which happens only when `sendSms` itself throws or fails).
- The row ended up `failed/error` and the owner got "could not be sent".
- There was no `sms_log` row, so the dashboard and the audit trail show no delivered text.

**Fix.**
- Track whether `sendAndLog` got as far as the provider, for example by having `sendAndLog` return or throw a typed "sent but not
  logged" error. If it did, leave the row in `sending` (or a new `unknown` status), store the provider id, and tell the owner *"The text may
  have been sent; check the dashboard before sending again."*
- Make the duplicate guard also cover `sending` and `failed` with reason `error` within the hour.
- Inside `sendAndLog`, keep a provider success from turning into a thrown error (log the `sms_log` failure and return).

---

## M2. The per-business daily send cap is check-then-act and can be overrun (Medium, reproduced)

**Where.** `src/lib/messaging/owner-reply.ts:397-399`. The count `status: 'sent', sentAt >= day` runs before the send. Rows still in
`sending` are not counted, and no lock or reservation is taken.

**Repro** (test B). With `OWNER_REPLY_DAILY_LIMIT=3`, 8 `proposed` replies (8 customers) and 8 signed `YES <code>` webhooks sent at
once, **all 8 were sent** ("Sent to Maria" x8). That is within the 10-per-15-minute SMS attempt limiter.

**Impact.** The daily cap is the backstop against a stolen or compromised owner phone. Racing it removes the limit, up to the number of
waiting drafts, which can be up to 2 x limit per day because draft budgets are per trust class (`reply-tools.ts:110`). It is also cost
abuse against the plan's SMS allowance.

**Fix.** Reserve against the cap atomically before sending. For example, use the Postgres limiter
(`rateLimit('owner-reply:day:'+business, limit, 24h, {failClosed:true})`, released on refusal), or take a
`pg_advisory_xact_lock(business)` around count + claim. Also count `sending` rows.

---

## L1. The reply scanner misses several phone, code and payment shapes (Low, reproduced)

**Where.** `src/lib/voice/owner/reply-text.ts:188-213`.
- `DIGIT_RES` uses `\d`, which in a non-`u` JS regex matches ASCII 0-9 only.
- `SYMBOL_RE` explicitly allows `\p{N}` and `/`.
- `PAYMENT_RE` matches exact ASCII words only.

These bodies were all **accepted** by `validateReplyBody` (scratchpad `probe.test.ts`):

| Shape | Example |
| --- | --- |
| Slash-separated number | `Call 555/123/4567 today` |
| Full-width or Arabic-Indic digits | `Code: １２３４５６`, `Your code is ٤٥٦٧٨٩` |
| Vanity number | `Call 1-800-FLOWERS`, `call 1800 FLOWERS` |
| Mixed spelled-out digits | `Call 917 five five five 0199` |
| Link in words | `Pay your deposit at example dot com slash pay`, `visit bitly/abc12` |
| Homoglyph / spacing | `Send a gіft card today` (Cyrillic i), `Pay the invoice by Zel le`, `Send 200 dollars by C a s h A p p` |
| Credential / payment asks | `Please send your SSN to confirm`, `Your account is locked, reply with your login`, `Your card was declined, text back your card details`, `Pay with Apple Pay or Google Pay now` |

The owner sees the exact words and must YES them, so this matters only when the owner is malicious or careless, or the owner phone is
compromised. However, the docs present this scanner as "what stops the line being used to relay phishing or a phone number", and the
bypasses above are not exotic.

**Fix.**
- Apply `normalize('NFKC')` first, then fold every `\p{Nd}` to ASCII. Include `/` and `)` in the separator class of the digit-run regex.
- Reject vanity numbers (`\b1?[-\s]?8\d\d[-\s]?[A-Z]{4,}`).
- Reject letters outside Latin plus Spanish accents (this kills the homoglyphs).
- Run `PAYMENT_RE` on a whitespace-squashed fold too, and add `ssn|login|password|pin|card details|apple pay|google pay|deposit link`.
- Treat a mixed digit-word number like the spelled-out ones (`PHONE_RES` already spots fully spelled numbers).

---

## L2. The spoof warning in the confirmation text tells the owner to send a reply that does nothing (Low)

**Where.** `src/lib/voice/owner/reply-text.ts:265`. The warning reads ``Not you? Reply NO.`` (Spanish: ``Responda NO.``) with **no code**.
The knowledge-change version (`code.ts:67`) says `Reply NO ${code}`.

**What.** `parseOwnerSms` needs exactly a verb and a 6-character code. A bare `NO` from the owner phone returns `null`, gets past
`handleCancelReply` and the rating branch, and gets no answer. An owner who received a draft they did not make (the spoof case this line
exists for) follows it literally, sees no confirmation, and believes it was cancelled. The draft stays `proposed` for 30 minutes. It cannot
be sent without YES, so the harm is limited, but the warning gives the owner no way to act on it. The dashboard keeps showing "waiting".

**Fix.** Use `Not you? Reply NO ${o.code}.`, as in the knowledge-change texts, and check that the result still passes `ownerTextFits`.
Optionally, answer a bare `NO` or `YES` from the verified owner phone with "Please include the code."

---

## L3. Rows stuck in `sending`, and erasure residue (Low)

- **Stuck rows.** A crash or timeout between the claim (`owner-reply.ts:368`) and the catch block leaves `status='sending'` permanently.
  No reconciler touches `owner_replies` (grep: only the dashboard query, retention and erasure do). `publicReplyStatus` maps `sending` to
  `waiting` (`reply-view.ts:296`), so the dashboard says "waiting for your YES" for a reply that can never be sent. A YES answers "That text
  was already handled". The row also counts toward the per-call draft limit.
  **Fix:** show `sending` older than about 5 minutes as `unknown` (or have the reconcile job move it to `unknown`) and word the YES answer
  accordingly.
- **Erasure.** `eraseCustomerData` deletes `owner_replies` for the number (`compliance.ts:459`) but not the `owner-lead-handled`
  `processed_events` marker. Its id is `sha256("owner-lead|<businessId>|<e164>")[:24]` (`reply-text.ts:319`): unkeyed, so someone holding
  a DB dump and a business id can brute-force the number (about 10^10 candidates for one country). The marker lives up to 30 days (the
  general `processed_events` cleanup). The `owner-lead-ref` snapshots hold only row ids.
  **Fix:** key the hash with an HMAC sub-key of `APP_SECRET_KEY`, and delete the marker in `eraseCustomerData`.

---

### Checked and found sound (not findings)

- **Recipient.** The recipient is never taken from model input: `draft_reply` has no recipient argument, and `parseLeadRef` accepts only
  1-5. The recipient is re-derived from a business-scoped row at draft time and again at send time (`leadStillValid` requires the same
  `toE164`). A foreign, erased or anonymised lead refuses, and FK `ON DELETE SET NULL` leads to `lead_gone`.
- **Code replay and races.** Replaying a code, a Twilio retry, or racing YES texts for one code send at most once (atomic `updateMany`
  claim). The `existing owner-reply` test plus a re-run confirmed it.
- **YES from the wrong sender.** YES from a stranger or from the customer's own number is ignored, because the verified-sender check runs
  before the limiter.
- **Code guessing.** Brute force needs a forged Twilio-signed SMS from the owner number and faces 32^6 codes at 10 attempts per 15 minutes.
  Testing a guess against both the reply and KB scopes gives no meaningful gain.
- **Opt-out between draft and YES.** It is honoured. Quiet hours refuse rather than queue.
- **Injection through customer data.** Customer summaries and transcripts never reach the owner assistant. Names go through
  `firstNameOf` (one word of letters, at most 20 characters).
- **Audit rows.** They hold no number, name or body (`last4` only on `callback_sent`).
- **Migration.** Re-runnable, with CHECK constraints added `NOT VALID` and then validated. The dashboard card is escaped by React and
  shows last 4 digits only.
