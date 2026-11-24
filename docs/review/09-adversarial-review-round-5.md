# Adversarial review, round 5 (commit 63a6124)

Scope: commit `63a6124` only. That covers (1) the pause/forward call modes, (2) the calendar and booking actions, and (3) the db-layer retyping and pagination refactor. The files another agent is editing concurrently (Twilio provisioning, messaging, jobs) were not reviewed.

**Baseline at HEAD:**
- `npx tsc --noEmit` passes with exit 0.
- `TEST_DATABASE_URL=…/scratch bun test` reports 660 pass, 0 fail.

**How the findings were proven:**
- Proof tests live outside the repo, in `/tmp/claude-0/-home-user-recepcionista/59b1eb07-88a1-5d65-bce8-a60fd41cc4aa/scratchpad/proofs.test.ts` (P1–P5) and `/tmp/claude-0/-home-user-recepcionista/59b1eb07-88a1-5d65-bce8-a60fd41cc4aa/scratchpad/cal.test.ts`. Run them from the repo root with `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/scratch bun test <abs path>`. All 5 proofs pass, which means each bug reproduces.
- For the browser pass, I made a production build of a clean worktree at 63a6124 and ran `next start` against a seeded throwaway database (`scratch_r5`, now dropped). I then drove it with Chrome 153 through puppeteer-core, as the owner and as staff, at 1280px and 390px.

## Verified findings

### H1 (High): the verified owner-phone path forwards calls to international-rate and Caribbean "one-ring" numbers, bypassing `validateForwardNumber`
- **Where:**
  - `src/lib/voice/call-mode.ts:28-34`: `trustedForwardNumber` trusts any number equal to the verified owner phone.
  - `src/lib/db/call-mode.ts:90` (`adoptOwnerPhoneAsForwardNumber`)
  - `src/app/api/businesses/[id]/forward-number/route.ts` (PUT)
  - `src/app/api/businesses/[id]/owner-phone/verify/start/route.ts`: this route only runs `toE164` plus the SMS country list. It has no premium, Caribbean, N11 or own-line filter.
- **Reproduction (proof P1):**
  1. Owner verifies `+18765550142` (Jamaica) as the alert phone. The start and confirm calls both return 200.
  2. `PUT /forward-number {use_owner_phone:true}` returns 200.
  3. `PATCH /call-mode {mode:'forward'}` returns 200.
  4. A signed inbound call to the business line now gets `<Dial …><Number>+18765550142</Number></Dial>`.

  The same number is refused by `/forward-number/verify/start` with "premium-rate and international-rate numbers cannot be used".
- **Other ways in through the same gap:**
  - Setting `FORWARD_ALLOWED_COUNTRY_CODES` narrower than `SMS_ALLOWED_COUNTRY_CODES` is not enforced either.
  - The validator is never re-applied at dial time. A number that was legal when stored keeps being dialled after the block list or country list changes.
- **Impact:** an owner or trial tenant (or a compromised owner session) can make the platform place outbound legs to international-rate NANP destinations. That is classic IRSF/one-ring revenue-share fraud. It applies wherever a line posts to `/api/voice/incoming` (the runbook §8 "Twilio line").
- **Fix:**
  1. Run `validateForwardNumber(e164, country, { ownLines: [phone_e164] })` inside `trustedForwardNumber`/`resolveCallRoute`. Fail closed to AI and log `forward_number_rejected`.
  2. Run the same check inside `adoptOwnerPhoneAsForwardNumber`/PUT.
  3. Add a test for a Caribbean owner phone.

### H2 (High, on a Twilio line): forwarded minutes are never metered and ignore the minutes cap
- **Where:**
  - `src/app/api/voice/incoming/route.ts:101`: `gate.ok || gate.reason !== 'no_plan'` lets `cap_reached` through.
  - `src/app/api/voice/voicemail/route.ts:43-45`: `DialCallDuration` is written to `duration_sec`, but `recordCallSeconds` is never called. Only `postcall.ts:367` meters calls.
- **Reproduction (proof P2):**
  - A `trialing` tenant has `call_minutes_cap_override: 1` and has already used 600 s. `BILLING_ENFORCED=true`.
  - Three forwarded calls each return `<Dial>` and each reports `DialCallDuration=3000` (50 min).
  - Afterwards `getUsage().call_seconds` is still 600.
- **Impact:**
  - Each forwarded call costs an inbound leg plus an outbound PSTN leg, with no ceiling, even on trial or over cap.
  - Voicemail `<Record>` (90 s each) is also unlimited.
  - Combined with possession-only verification (the attacker controls the destination, e.g. a US traffic-pumping number), this is a cost and toll-fraud amplifier.
  - The existing test (`call-mode.test.ts:168`) asserts this behaviour as intended.
- **Fix:**
  1. Meter forwarded and voicemail seconds, or count them in a separate `forward_seconds` counter with its own cap.
  2. Refuse `forward` when `cap_reached` (fall back to paused/voicemail).
  3. Consider no forwarding at all while `trialing`.
  4. Rate-limit forwarded calls per business per hour.

### M1 (Medium): "Paused" on the native ElevenLabs path (the production path) still books jobs, texts customers and can take deposits
- **Where:** `src/app/api/voice/tools/[tool]/route.ts:117-120`. Tools are gated only by `callGate`, never by `call_mode`. `src/app/api/voice/initiation/route.ts` only swaps the first message.
- **Reproduction (proof P4):** with the business in `callMode='paused'`:
  - The initiation first message says "We are not taking bookings by phone right now".
  - The `create_booking` tool returns `ok:true` ("You're all set for Saturday at 10 AM").
  - A confirmation SMS is sent to the caller (seen in the mock log).
- **Impact:** an owner who pauses (vacation, sick, fully booked) still gets bookings and customer texts. That contradicts the UI ("the receptionist does not answer") and the script the caller hears.
- **Fix:**
  - In the tools route, when `resolveCallRoute(business).action !== 'ai'`, refuse every tool except `handoff_to_human` and `flag_emergency` (the same mechanism as `CAPACITY_EXEMPT_TOOLS`).
  - Also pass a paused prompt override, not just `first_message`.

### M2 (Medium): "Forward" never forwards in the documented production setup, but the dashboard says it does
- **Where:**
  - `src/lib/voice/call-mode.ts:61` (`Forwarding to +1 ••• 0142`)
  - `src/components/dashboard/call-mode.tsx` (toast "Calls now forward to your number")
  - `docs/runbook.md:30`: production numbers are native ElevenLabs, and ElevenLabs owns the Voice URL.
- **What goes wrong:**
  - On the native path, `forward` is silently turned into the paused script. The caller hears "we are not taking bookings", is cut off at 60 s, and the owner's phone never rings.
  - The runbook §8 table also claims a "Twilio line (`/api/voice/incoming`)" answers with the AI in `ai` mode. That route returns JSON (`return ok({...})`, `incoming/route.ts:174`), not TwiML, so a Twilio number pointed at it fails in `ai` mode (Twilio cannot parse it). The "Twilio line" deployment that forwarding depends on cannot serve AI calls at all.
- **Fix:**
  - Store or derive the line type and make `callModeLabel` say "Forwarding is not available on this line; callers leave a message".
  - Or implement the ElevenLabs transfer tool.
  - Correct the runbook table.

### M3 (Medium): voicemails are stored but never shown to the owner; raw recording URLs are exposed to staff through the API
- **Where:**
  - `src/app/api/voice/voicemail/route.ts:61` stores `recording_url`.
  - No `.tsx` file reads `recording_url` (grep for `recording` in `src/components` and `src/app/dashboard` returns nothing relevant).
  - The new `GET /api/calls` (`src/app/api/calls/route.ts:19`) returns full `Call` rows to staff, including `recording_url` and `transcript`.
- **Impact:**
  - The flag says "Voicemail left: please call back", but the owner has no way to listen. The route comment ("so the owner sees it in Calls") is false.
  - Twilio recording URLs are fetchable without auth unless the operator enabled media HTTP auth, so the URL itself is a bearer link handed to every staff member.
- **Fix:**
  - Add an owner-only `GET /api/calls/:id/voicemail` that proxies the media with the Twilio credentials.
  - Render a player in the call detail.
  - Strip `recording_url` from API and staff payloads.

### M4 (Medium): calls can be redirected by a single owner session with no step-up and no notification
- **Where:** `forward-number/verify/*`, `forward-number` PUT, `call-mode` PATCH.
- **What goes wrong:**
  - Verification only proves the session holder controls the destination.
  - An attacker with an owner session (stolen cookie, or a malicious co-owner) verifies their own phone and switches to `forward`, so all of the business's inbound calls ring the attacker.
  - There is no password or TOTP re-entry, no email or SMS to the verified owner phone, no cooling-off, and no audit when `verify/start` silently drops `forward` back to `ai` (`verify/start/route.ts:53`, `clearForwardNumber`).
  - The PUT and PATCH routes do not require `verifiedEmail`.
- **Fix:**
  - Require recent re-authentication (or TOTP when enrolled) to set a forward number or enable `forward`.
  - Notify the owner email and the verified owner phone on every forward-number or mode change.
  - Audit implicit mode changes.

### L1 (Low): a job that ends exactly at local midnight is drawn as 15 minutes
- **Where:** `src/lib/calendar.ts:133`. When `endMs == dayRange.lt`, `continuesAfter` is false and `wallMinutes(midnight)` is 0, so the 15-minute guard yields `startMin+15`.
- **Reproduction:**
  - `cal.test.ts`: a 22:00 job of 120 minutes gives `{startMin:1320, endMin:1335}`.
  - In Chrome, "Midnight Job" (22:00–24:00) renders 14 px tall in the week and day grids at 1280px, against 62 px for a 60-minute job.
- **Fix:** `const endMin = endMs >= lt.getTime() ? MINUTES_PER_DAY : wallMinutes(endMs, tz)`.

### L2 (Low): a job in progress appears in both the "upcoming" and "past" agenda lists
- **Where:** HEAD `src/lib/db/index.ts:882` (`past` uses `scheduledAt < now`), while `upcoming` prepends running jobs.
- **Reproduction (proof P5):** a job started 30 minutes ago and lasting 120 minutes is listed in both `upcoming` and `past`.
- **Fix:** have `past` exclude jobs whose `scheduled_at + duration > now` (same filter as `bookingInterval`).

### L3 (Low): `listAllBusinesses` stops early if the cursor row is deleted mid-walk
- **Where:** HEAD `src/lib/db/index.ts:267-287`. Prisma `cursor:{id}` on a deleted id returns an empty page.
- **Reproduction (proof P3):** `listBusinessesPage({cursor: <deleted id>})` returns 0 items with `next_cursor: null`.
- **Impact:** the jobs (briefing, gratitude, retention: `jobs/index.ts:182,238,413`) silently skip every later tenant in that run.
- **Fix:** use a keyset `where: { OR: [{createdAt > c.at}, {createdAt = c.at, id > c.id}] }` with a `<iso>~<id>` cursor, like the other pages.

### L4 (Low): keyboard focus is lost after changing the call mode
- **Where:** `src/components/dashboard/call-mode.tsx:94`. The pressed button becomes `disabled` while saving, so focus falls to `<body>`.
- **Reproduction (Chrome, keyboard only):** Today → Change → focus "Pause" → Enter. `document.activeElement` is then BODY.
- **Fix:** use `aria-disabled` plus a busy guard instead of `disabled`, or restore focus after the request.

### L5 (Low): the "forward only during business hours" checkbox re-sends a stale mode
- **Where:** `call-mode.tsx:165` sends `{ mode: view.call_mode, … }`.
- **What goes wrong:**
  - If another tab or owner changed the mode, toggling the checkbox silently reverts it.
  - If the forward number became unverified while `call_mode='forward'`, the toggle always fails with 422.
- **Fix:** let PATCH accept `forward_during_hours` without `mode`.

### L6 (Low): `GET /api/bookings?view=month&date=9999-12-15` returns 500
- **Where:** `rangeFor` throws "bad date key: 10000-01-01".
- **Fix:** bound `date` to a sane range (for example ±50 years) and return 422.

### L7 (Low): forward-number coverage gaps
- **What passes validation:**
  - NANP territories `+1 670/671/684` (CNMI, Guam, American Samoa), which carry higher Twilio "US-other" rates.
  - Toll-free `8XX` numbers.
  - Legacy local premium exchanges (`NXX 976` within any area code, e.g. `+1 305 976 0142`).
- **What already works (verified):** Unicode, fullwidth and Arabic-Indic digits all normalise to the same ASCII E.164 before filtering, so they are no bypass.
- **Fix:** add 670/671/684 to the rate-review list, reject `976` exchanges, and decide explicitly about toll-free numbers.

## Claims verified OK
- **Challenge purpose separation:** keys are derived per purpose (`owner-verify.ts`), so an owner-phone challenge cannot confirm a forward number or vice versa (existing test plus code review). Codes are bound to (business, e164, exp, nonce).
- **Verify/change race:** a concurrent `setCallMode('forward')` and a change of number can leave `mode=forward` with an unverified number, but `resolveCallRoute` re-checks trust on every call, so an unverified number is never dialled (it falls back to the AI).
- **Formatting tricks:** extensions, `;`, `,`, `#`, letters, zero-width characters, extra digits, 456/880/950/710 numbers, 900 numbers, and Caribbean numbers entered directly are all refused by `/forward-number/verify/start`.
- **Voicemail callback:** requires a Twilio signature (it is on the PUBLIC list, but `verifyTwilioSignature` is mandatory). The tenant comes only from the CallSid row, and a foreign or non-Twilio `RecordingUrl` is not stored, so there is no SSRF (the server never fetches the URL).
- **Consent:** forwarded calls never set `recording_disclosed`. Paused and voicemail TwiML speaks "will be recorded" before `<Record>`, a `declined` status stays sticky, and the native paused script starts with `disclosureFor`.
- **Missed-call texts:** owner texts are rate-limited (1 per 10 min, 6 per hour per business, fail-closed) on every paused, forward and out-of-service path.
- **Plan lapse:** a lapsed plan (`no_plan`) stops paused and forward as well.
- **Booking routes:**
  - Every booking route returns 404 for another tenant's booking (`requireBusinessAccess` on the row's business).
  - PATCH and resend are owner-only, and staff see no actions (checked in Chrome).
  - Complete-before-start returns 409. Cancel-after-complete returns 409. A double cancel returns 200 with `changed:false`.
  - Concurrent transitions are made safe by a status-conditional `updateMany`.
- **Pagination:** every cursor column is `timestamp(3)`, so the ms ISO cursors are exact. Ordering ties are broken by `id`. A tampered or foreign cursor only moves within the caller's own `businessId`. `listBookingsInRange` widens by `MAX_DURATION_MIN`, so overlaps are kept.
- **Calendar time-zone and DST maths:** the fall-back week is 169 h and the spring day is 23 h. Week start follows country, with a viewer override in try/catch localStorage. Invalid dates such as `2026-02-30` are rejected.
- **XSS:** customer name, service and address containing `<img onerror>`, `"><script>` and `javascript:` render as text in the grid, panel and day list. No dialog fired and no `dangerouslySetInnerHTML` is used. `tel:` hrefs are prefixed, so `javascript:` cannot run.
- **Browser pass:** no console errors, CSP violations, page errors or 4xx/5xx responses. There was no horizontal overflow at 390px on Today, Calendar (week, day, month) or Settings. The booking panel traps focus, closes on Escape and returns focus to its opener.
- **db refactor:** the `update*` helpers now throw on non-P2025 errors, where they used to return null. Every call site I reviewed in scope either awaits inside a try block or wants the failure surfaced. Mappers keep every field and add the call-mode fields.

## Unverified suspicions
- An owner phone set to another tenant's AI number (or its own) and adopted as the forward number could create a call loop between Twilio lines. `ownLines` only checks the business's own `phone_e164`, and only on the validator path (H1). Not tested: it needs the verification SMS to that Twilio number to be readable.
- The `updateCall` change from swallowing errors to throwing them can now turn a transient database error in `/api/voice/incoming` or `markForwarded` into a 500, which drops the call instead of forwarding it. I could not trigger this with valid inputs.
- `listBusinesses()` is now capped at 1000 rows without a cursor in the admin switcher (`dashboard-context.ts:38`) and in onboarding resume. Tenants beyond 1000 silently disappear from the admin UI.
- `getDashboardStats.bookings_upcoming` loads up to 5000 rows and counts them in JS, so it silently caps at 5000.
