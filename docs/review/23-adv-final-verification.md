# 23. Adversarial final verification of the 19-22 fix commit

Scope: `dc68421 fix: close adversarial findings 19-22 ...` (`git diff HEAD~1..HEAD`), checked against the Resolution sections of `docs/review/19`-`22`. I also scanned once for Critical/High issues in the features this branch adds compared with `origin/main`.

Method:
- Source was read-only.
- I used my own database, `rev_final2_test`, with `prisma migrate deploy` from empty.
- `rev_final2b_test` held a v1-then-v2 upgrade.
- `rev_final2_shadow_test` was the shadow database.
- Throwaway repros are in the scratchpad (`repro/sender.test.ts`).
- All three databases were dropped at the end.

**Verdict.**
- One High regression was introduced by the H1 fix: cross-tenant misrouting of replies to the shared sender. It is reproduced below.
- One High operational regression is only documented: carrier filtering of unregistered tenant numbers.
- Three Medium issues: migration locks, the release circuit breaker, and the incomplete F3 gate.
- A handful of Lows.
- Every other claimed fix holds on the paths I checked.

---

## A. Findings (ranked)

### A1. HIGH: a reply to the shared sender is routed to a business that never used it (cross-tenant inbox leak, wrong-tenant "C" cancel, wrong STOP fan-out). Reproduced.

**Where:**
- `src/lib/messaging/sender.ts` `resolveInboundBusinesses`
- `src/app/api/sms/inbound/route.ts:49-66`
- `src/app/api/sms/gratitude-reply/route.ts:46`

**Cause.** `resolveInboundBusinesses` picks the business of the most recent `sms_log` row sent to the customer's number. Most of those texts now go out from the tenant's OWN number, and `sms_log` does not record which sender was used: `SendSmsResult.sender` is computed but never persisted. So "the last outbound text" is very often a text that did not come from the shared sender at all.

**Repro** (fake Twilio; B's number returns 21606, so B falls back to the shared sender):
1. The customer texts B. B's acknowledgement goes out from `+15005550006` (shared).
2. The customer texts A. A's acknowledgement goes out from A's own number.
3. The customer answers B's text, which they received from the shared number: "My budget for the remodel is 40k, my address is 12 Elm St".

Result:
- The message is stored in **A's** inbox and **forwarded to A's owner's phone**. B never sees it.
- `STOP` to the shared number opts the customer out of A, which never texted from the shared number. The unsubscribe confirmation names A.

**Consequences:**
- **Leak:** customer words are delivered to an unrelated tenant's owner.
- **Wrong-tenant cancel:** a bare `C` to the shared number runs `handleCancelReply(A, ...)`, which cancels A's single upcoming booking for that customer.
- **Wrong rating:** a 1-5 reply is applied to A's gratitude flow.
- **Over-broad STOP:** the fan-out also hits every business that texted the customer in 30 days from its own number. It errs on the side of compliance, but it silently stops confirmations and reminders for unrelated businesses.
- **Who is affected:** any customer who deals with two tenants within 30 days, where one of them fell back to the shared sender (21606/21212/21659/21660, or no real number).

The existing test `20 H1` only covers two mock-pool tenants that both used the shared sender, so it misses this case.

**Fix:**
- Persist the sender on `sms_log`: a `from_e164` or `sender` column set from `result.sender`, including the mock path.
- Have `resolveInboundBusinesses` consider only rows sent FROM the shared number.
- With more than one candidate, prefer asking ("Reply with the business name") or storing the text unrouted over guessing. Never run `C`-cancel or ratings on a shared-sender reply that has more than one candidate.
- Apply the same STOP fan-out in `gratitude-reply`; it currently opts out only `[0]`.

### A2. HIGH (operational, documented only): every customer text now depends on per-tenant A2P registration that nothing automates or detects

**Where:** `sendAndLog` → `sendSms(..., { from: tenantSmsSender(business) })`. Provisioning buys a number and never adds it to a Messaging Service or campaign; there is no `MessagingServiceSid` anywhere in `src`. There is also no delivery StatusCallback.

**Effect:**
- Before this commit, every customer text left from the one shared number, presumably the registered one (runbook section 3 checklist: 10DLC brand and campaign).
- After it, every booking confirmation, reminder, payment link, auto-reply, owner forward and owner alert leaves from a freshly bought, unregistered 10DLC number.
- US carriers block unregistered A2P 10DLC traffic after Twilio has accepted it. Twilio returns 201, the log says `sent`, the 21606 fallback never fires, and nothing in the app notices.
- `runbook.md:249` and `known-limitations.md:128` acknowledge this. In practice, though, deploying this commit without a manual per-tenant registration process silently degrades SMS delivery for every US tenant.

**Fix (any of):**
- Send through a `MessagingServiceSid` and add each purchased number to its sender pool at provision time.
- Gate the tenant sender behind an env flag (for example `SMS_FROM_TENANT_NUMBER=on`) and keep the default at the shared sender until registration is in place.
- Add a StatusCallback so 30034/30007 errors surface and fall back.

### A3. MEDIUM: migration `20261209120000` still blocks every SMS write, and booking reads and writes, for the length of the whole migration

The Resolution for review 22 M1 says: "the validation scans take SHARE UPDATE EXCLUSIVE locks, the GiST build holds only `bookings`". That is not what happens.

**How it runs:**
- Prisma applies a migration file as one implicit transaction. I verified this: a probe migration ending in `SELECT 1/0` rolled back its own `CREATE TABLE`.
- Every lock is therefore held until COMMIT.

**Locks held:**
- `CREATE INDEX "sms_log_to_e164_created_at_idx"` (non-concurrent) takes a SHARE lock on `sms_log`. I observed it held in `pg_locks` while the rest of the file ran. `sms_log` is likely the largest table.
- That SHARE lock is held through the index build, through every validation scan in block 3, and through the GiST rebuild of `bookings` under ACCESS EXCLUSIVE.
- Every `logSms` insert blocks for that whole time. Every send path writes `sms_log` after Twilio has already accepted the text, so request handlers hang while the texts have already gone out.
- `ALTER TABLE briefing_audio ADD COLUMN` takes ACCESS EXCLUSIVE on `briefing_audio`, also held to the end (minor).
- `lock_timeout = '10s'` only bounds lock acquisition, not hold time.

**Fix:**
- Move the `sms_log` index into its own migration file containing only `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. Prisma runs a single-statement file outside a transaction block, or the operator can pre-create the index.
- Put the GiST rebuild in its own file, so its ACCESS EXCLUSIVE does not stack on the other locks.
- Correct the runbook and the Resolution text.

**Other checks passed:**
- Zero drift: `migrate diff --from-migrations ... --to-schema-datamodel` and `--from-url` both report "No difference detected".
- A database that applied the v1 fixture of `20261208120000` upgrades through `migrate deploy` cleanly.
- `migrate status` is clean.
- The in-place edit changes the checksum. Only `migrate dev` on a developer database that ran v1 will complain, which is acceptable because v1 was never released.

### A4. MEDIUM: the release circuit breaker plus a permanent line error halts all tenant releases forever

**Where:** `src/lib/jobs/tenants.ts:66-80`, `src/lib/billing/release.ts:199-224`, `src/lib/voice/tenant-line.ts releaseTenantLine`

**Mechanism:**
- `releaseTenantLine` returns `ok:false` for conditions that never clear on their own:
  - the line id equals `ELEVENLABS_PHONE_NUMBER_ID`;
  - `ELEVENLABS_API_KEY` is not set (for example after a switch to `VOICE_LINE_KIND=webhook`);
  - the line belongs to another business.
- With the new "keep the agent while the line can't go" rule, such a business is `partial_error` on every run, and it stays a candidate.
- `listReleaseCandidates` orders by `createdAt asc`. The same oldest three stuck businesses are processed first every run, `erroring` reaches `MAX_RELEASE_ERRORS_PER_RUN = 3`, and every later canceled tenant is `deferred_to_next_run` indefinitely.

**Impact:**
- Canceled tenants' Twilio numbers and agents are never released, and the platform keeps paying for them.
- Nothing alerts on it beyond `deferred` counts.

**Fix:**
- Count only retryable or provider-5xx errors toward the breaker.
- Mark non-retryable line errors as `needs_operator`: skip the business in later runs and alert once.
- Or rotate the order, for example oldest attempt first.

**Positive check:** the new code cannot release a live tenant. Candidate selection and the decision logic did not change in this commit.

### A5. MEDIUM: the F3 guard against importing (and pausing forwarding) exists only in `repair-numbers`

**Where:**
- `src/lib/voice/agent-created.ts:20` (`finishCreatedAgent`: admin resync, and the owner-edit / agent-dirty resync when the agent was re-created after a 404)
- `src/app/api/businesses/[id]/provision/route.ts:355` (a re-run of provision on an existing business)

**Mechanism:**
- Both paths use `lineKindFor(business) === 'native'`, the import target. Under the unforced tenant-lines default that is `native` for a not-yet-imported tenant.
- Both call `ensureTenantLine` without the `call_mode === 'forward' && !forwardingSupported('native', ...)` check that `repair-numbers` has (`repair-numbers/route.ts:120`).
- For a forward-mode tenant whose agent is recreated, or who is re-provisioned, the number is imported, ElevenLabs takes the Voice URL, and `effectiveLineKindFor` becomes `native`. Callers then get the paused script: exactly the silent downgrade F3 describes.

**Fix:** move the forward-mode gate into `ensureTenantLine` itself, or into a shared `shouldImportLine(business)` helper used by all three callers.

**Other `effectiveLineKindFor` call sites are consistent:**
- call-mode view, label and `setCallMode`;
- the dashboard layout and page;
- the Settings card and `/line`;
- `voice/incoming` passes `'webhook'` and `initiation` / `tools` pass `'native'` explicitly, which matches the line that is actually answering.

### A6. LOW: the daily briefing-audio cap is bypassed whenever reuse does not actually happen

**Where:** `src/app/api/briefings/[id]/audio/route.ts:115-120`

**Mechanism:**
- The cap is skipped when `existing.text_hash !== null`, which is any hashed clip.
- `attachBriefingAudio` reuses only when the hash equals the current transcript AND the voice matches (`business.voice_id` against the stored resolved voice id).
- So after a voice change, a hashed clip still skips the cap but gets re-synthesized. An owner alternating between two voices synthesizes on every click, outside the 10/day cap. A stored voice id that `briefingVoiceId` normalised differently has the same effect.
- The bound is the per-business 20/hour limiter, roughly 480 syntheses a day instead of 10.

**Fix:** compute `wouldReuse` with the same predicate as `attachBriefingAudio`: export a `canReuse(existing, transcript, business)` helper.

**Range reads are fine:**
- `substring()` runs in Postgres.
- `size` comes from `octet_length`.
- 416 and 304 are handled from metadata only.

### A7. LOW: deposit races between the manual mark and the card webhook (read-then-write without a row lock)

1. **`markDepositPaid` misses a concurrent manual mark.** Its transaction reads `cur` (unpaid) before a concurrent `markDepositPaidManually` commits. The `updateMany` predicate `depositSource: 'manual'` then matches the re-read row and converts it, but `wasManual` was false. The result: no `paid_over_manual_deposit` audit, and the owner gets the ordinary "Deposit paid" text instead of "they paid twice".
2. **`unmarkManualDeposit` can erase a card payment.** It reads (manual, no Stripe refs) and then runs an unconditional `update({ where: { id } })`. A webhook that converts the row to `stripe` in between is overwritten to `depositPaid:false, depositSource:null`. The booking then shows unpaid while Stripe holds the money; the refs stay, so recovery is possible manually.

**Fix:** `SELECT ... FOR UPDATE` (or `updateMany` with the read state in the `where`) in both functions.

**Checked and fine:**
- The double-refund and lost-refund paths of the conversion:
  - the manual refund state is reset only when the previous mark was manual;
  - the card part can then be refunded through Stripe;
  - the cash part is the owner's.
- `setDepositAmountIfUnpaid`.
- Dead-on-arrival link deactivation.
- The durable `link-deactivate` queue: it accepts manual-paid rows and drops card-paid ones.

### A8. LOW: legacy owner-forward erasure by shape (false positives are bounded; some false negatives)

**False positives.** Deleting another customer's row requires both of these:
- the same last 4 digits;
- the same first 24 alphanumeric characters (at least 8) of one of the erased customer's own inbox texts.

That is roughly 1/10,000 per pair, times the chance of the same opening words (for example "Hello, what time do you open"). The rows removed are owner_alert log rows of the same business, not another customer's inbox. This is acceptable.

**False negatives (customer words that survive erasure):**
- a message whose opening is mostly non-Latin script or emoji (`alnum` strips it, so the fragment is under 8 characters);
- a message whose first 24 characters contained a link (the forward has `[link]`, the inbox has the URL);
- a legacy forward whose inbox row was already deleted.

Worth a line in known-limitations.

### A9. LOW: `ensureTenantLine` lease is 90 s with no renewal, and duplicate removal trusts only the DB

`removeDuplicateImports` deletes an un-owned import of the same E.164. The failure case:
1. A first run is slowed past the 90 s lease (provider timeouts on list, import and bind).
2. A second run imports.
3. The first run's cleanup can delete the second's import before the second stores it, leaving a stored id that no longer exists.

Next steps then re-import, so the state self-heals. The cleanup can never touch another tenant's line: the E.164 is per-tenant, the owner check runs against the DB, and the shared id is excluded. A still-unsaved import by a concurrent holder is the only victim.

---

## B. Claimed fixes verified as closing their finding

| Finding | Notes |
| --- | --- |
| 19 F1 | Repair passes `skipVoiceUrl` from the business. |
| 19 F2 | Everywhere except the gap in A5. |
| 19 F3 | Partial: see A5. |
| 19 F4 | Lease, then a single POST. |
| 19 F5 | Shared id and foreign agent refused; release refuses the env id. |
| 19 F6 | Name validator. |
| 19 F7 | Refresh option; shape still unverified, as stated. |
| 20 H1 | Partial: the tenant-number half is correct, the shared-sender routing is wrong (A1, A2). |
| 20 H2 | New rows hold no words; legacy rows per A8. |
| 20 M1, M2, M3, M4, L1, L2, L3 | |
| 21 H1, M1, M2, M3, L1, L2, L3 | See A7 for the remaining races. |
| 22 M1 | Partial: see A3. |
| 22 M2 | See A4. |
| 22 M3, M4, L1, L2, L3, L4, L5, L6 | 22 L5: see A6. |

Additional notes on individual fixes:
- **22 L2:** the timezone repair writes audit rows inside the migration and maps known legacy names.
- **20 M2:** the opt-out route uses the stored sender only and is tenant-scoped.

## C. Branch-wide scan (inbox, manual bookings/deposits, scheduling/crews, time zones, per-tenant line)

- **Authorization:** every new or changed tenant route calls `authenticate` plus `requireBusinessAccess` or `scopeBusinessId`. `pay/mock-complete` is gated by `DEMO_MODE` (pre-existing).
- **No other Critical or High found** beyond A1 and A2.
- **AI deposits:** percentage deposits now come from the catalog price matched to `booking.service`. The model can still pick which catalog service name to match, but the amount is bounded by the owner's own prices. Not a finding.

## D. Databases

`rev_final2_test`, `rev_final2b_test` and `rev_final2_shadow_test` were created for this review and dropped at the end. No `scratch*` database was touched.
