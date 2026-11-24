# 07 — Adversarial review, round 3 (branch `claude/serene-clarke-fowr2c`)

Scope: `git diff origin/main` (235 files, +16.5k/-1.5k): self-signup, email verification, password reset, invites, TOTP 2FA and
recovery codes, DB-backed admin sessions, team management and audit, Stripe subscription billing and usage caps, E.164 matching,
owner-phone verification, the ElevenLabs initiation webhook, the new onboarding, nonce CSP via `src/proxy.ts`, the grandfathering
script and the verify-deploy tooling. Prior context: `05-adversarial-review.md`, `06-adversarial-review-round-2.md`.

PoC scripts are in the reviewer scratchpad,
`/tmp/claude-0/-home-user-recepcionista/59b1eb07-88a1-5d65-bce8-a60fd41cc4aa/scratchpad/r3/`. They import the real route
handlers and libraries and run against a throwaway database (`r3poc` / `r3mig` on the scratch Postgres). Run them like this:

```sh
cd /tmp/claude-0/-home-user-recepcionista/59b1eb07-88a1-5d65-bce8-a60fd41cc4aa/scratchpad/r3 && . ./env.sh && bun <script>.ts
```

`env.sh` sets `DATABASE_URL=…/r3poc`, a dummy `ADMIN_TOKEN` and `APP_SECRET_KEY`. No provider keys are set, so Twilio,
ElevenLabs and Stripe run in mock mode unless the script stubs `fetch`. The browser checks used `next build` plus
`next start -p 3917`, with a local SMTP sink (`smtp-sink.js`) and Playwright (`journey.js`, `signup-dos.sh`).

## Baseline

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass (exit 0) |
| `TEST_DATABASE_URL=…/scratch bun test` | **435 pass, 0 fail**, 39 files |
| `bun test` without `TEST_DATABASE_URL` | 205 pass, 268 skip, exit 0. CI sets `TEST_DATABASE_URL` (`.github/workflows/ci.yml:72`), so the gate is fine in CI. The 4-per-file count difference between the two runs is only skipped hooks being counted. |
| `next build` (dummy DB URL, `ADMIN_TOKEN`) | pass. Every page is dynamic (ƒ) except `robots.txt` and `sitemap.xml`, so no prerendered page carries a stale nonce |
| Migration chain from scratch (`prisma migrate deploy` on an empty DB) | applies cleanly |
| Upgrade path: old schema (six earlier migrations applied with `psql`, seeded rows), then `20261125120000_…` | applies cleanly, **but legacy opt-outs are corrupted. See H4.** |
| Browser journey at 390 px, keyboard only for signup: signup → email → confirm → sign in → onboarding → dashboard → billing | works. Tab order on signup is business → email → password → "Create account", and the honeypot is not tabbable. Billing answers "billing is not configured" in production without Stripe, as expected |

---

## Blocker

### B1. Signup is open on deploy, but billing is off by default. Every stranger gets a free phone number and AI agent with no caps, and the documented rollout script then comps them permanently with an unverified, possibly premium-rate alert number
- **Where:**
  - `src/lib/db/usage.ts:26` (`billingEnforced` is true only for `BILLING_ENFORCED === 'true'`) and `:136` (when billing is not enforced, `decide()` returns `ok` before any cap check, so caps are off too).
  - `src/lib/billing/gate.ts` with `src/app/api/businesses/[id]/provision/route.ts:64,106`: an owner with a verified email may buy a number and create an agent.
  - `deploy.sh:106`: only `BILLING_ENFORCED=true` is checked. When it is unset there is no warning or refusal, although signup is unconditionally public (`src/lib/auth.ts` `PUBLIC_API_EXACT`, and there is no `SIGNUP_ENABLED` switch).
  - `docs/billing.md` §4/§6 says to leave `BILLING_ENFORCED` "unset until step 6", so signup is live and free during the whole rollout.
  - `scripts/grandfather-existing.ts:32-33`: comps **every** business with `billing_status='none'` and marks **every** unverified `owner_phone` as verified. It has no cutoff date and no "created by self-signup" filter.
  - `PATCH /api/businesses/[id]` (`route.ts:21`) accepts any E.164 `owner_phone` with no country allow-list.
  - Owner alerts bypass both the cap and the country allow-list (`src/lib/messaging/index.ts:92,103`).
  - `OWNER_PHONE_GRANDFATHER=true` (`src/lib/messaging/owner.ts:23`) has the same effect for **all** businesses, including ones created after rollout.
- **Exploit:**
  1. During the rollout window, sign up with any mailbox (30/h platform-wide).
  2. Verify the email and provision. The platform buys a real Twilio number and creates an ElevenLabs agent. No plan and no caps apply.
  3. PATCH `owner_phone` to an international premium-rate number.
  4. The operator runs the grandfather script exactly as `docs/billing.md` §5 says. The business becomes `active`/`legacy` forever, and the premium number becomes a "verified" alert destination that bypasses the cap and the country allow-list. Every call that triggers handoff, emergency or out-of-service then texts it.
- **Repro:**
  - `provision-secret.ts`: a self-signup owner with `BILLING_ENFORCED` unset provisions and gets `status 200 … phone +13055552618`.
  - `grandfather-signup.ts before`, then `bun scripts/grandfather-existing.ts --force-i-know --apply`, then `grandfather-signup.ts after`:
  ```
  PATCH owner_phone=+88213000000 -> 200
  before: billing none owner_phone +88213000000 verified null
  UPDATE d05c6005-… "Totally Real Plumbing": billing_status none -> active, plan 'legacy'; owner phone -> verified
  after: billing active plan legacy verified 2026-11-23T19:51:48.281Z
  [sms:mock] -> +88213000000
  owner_alert to +88213000000 -> mock          (passed the recipient check: any country, uncapped)
  ```
- **Fix:**
  - Gate signup behind an explicit `SIGNUP_ENABLED=true`, default off.
  - Make `deploy.sh` refuse `SIGNUP_ENABLED=true` without `BILLING_ENFORCED=true`, or at least print a loud warning, and make `/api/health` report it.
  - Or make `isProvisioningAllowed` refuse self-signup businesses whenever billing is not enforced, for example with a `businesses.origin='signup'` column.
  - Give the grandfather script a mandatory `--created-before <ISO>` (deploy time), and skip businesses that have an `auth.signup` audit row.
  - Never auto-verify an owner phone outside `SMS_ALLOWED_COUNTRY_CODES`.
  - Make `OWNER_PHONE_GRANDFATHER` apply only to rows with `created_at` before a configured cutoff.
  - Apply the country allow-list to `owner_phone` in the PATCH route.

---

## High

### H1. Owners can now provision, so the platform-wide ElevenLabs post-call webhook signing secret is returned to tenants, and a transient list error creates duplicate webhooks
- **Where:** `src/app/api/businesses/[id]/provision/route.ts:64` was `role: 'admin'` on `origin/main` (that response was documented as "admin-only"). It is now any owner with a verified email. `:229,258` return `webhook_secret` in the owner's response. `src/lib/voice/postcall.ts:76-88`: if `GET /workspace/webhooks` is not `ok` (429, 5xx), the code falls through and **creates** another workspace webhook, binds the new agent to it, and returns its secret.
- **Exploit:** On a fresh workspace, the first self-signup owner to provision receives the signing secret for the workspace webhook. Later, whenever the list call fails (for example an ElevenLabs 429), a stranger receives the secret of a new webhook. The operator is told by log `webhook.secret_unsaved` to copy "the secret from the provision response" into `ELEVENLABS_WEBHOOK_SECRET`. The operator never sees that response, so either post-call stays broken or the tenant holds the HMAC key and can forge post-call webhooks (transcripts, call outcomes) for **every** tenant. Meanwhile the new tenant's agent is bound to a webhook whose secret ≠ `ELEVENLABS_WEBHOOK_SECRET`, so all of its post-calls are rejected.
- **Repro:** `provision-secret.ts` stubs ElevenLabs (list → 429, create → secret):
  ```
  status 200 principal=self-signup owner, BILLING_ENFORCED= (unset)
  webhook_secret in owner response: wsec_PLATFORM_WIDE_HMAC_SECRET | agent agent_poc_… | phone +13055552618
  provider calls: … GET /workspace/webhooks ; POST /workspace/webhooks ; PATCH /convai/agents/agent_poc_…
  ```
- **Fix:**
  - Never include `webhook_secret` unless `principal.kind === 'admin'`.
  - Do not create a webhook from a tenant request. Require it to exist (operator setup step or admin-only endpoint) and fail provisioning otherwise.
  - In `ensurePostCallWebhook`, treat a failed list as an error and do not fall through to create.

### H2. An unverified signup can use owner-phone verification as an SMS relay: arbitrary destinations, with the attacker's text in every message
- **Where:**
  - `src/app/api/businesses/[id]/owner-phone/verify/start/route.ts:28` authenticates `role: 'owner'` **without** `verifiedEmail`.
  - `:55` uses the body `` `${business.name}: your verification code is …` ``, and `business_name` is 120 attacker-chosen characters (`validateBusinessName` allows URLs and phone numbers).
  - Limits are per business (10/h) and per business+phone+client (5/h). Businesses are free to mint (30/h platform-wide, no email proof), and every business's hourly budget renews, so total volume grows with the number of businesses ever created.
  - The text is metered but not capped (`sendOwnerVerificationCode`).
- **Repro:** `unverified-sms.ts`:
  ```
  email_verified_at = null
  [sms:mock] -> +13055551000
  Chase Fraud Alert: card locked, call 1-888-555-0100 or visit chase-verify.example: your verification code is 295104. It expires in 10 minutes.
  12 starts to 12 different numbers -> 200,200,200,200,200,200,200,200,200,200,429,429
  texts sent by this one unverified business: 10
  ```
- **Impact:** Phishing/smishing from the platform's own number. It burns Twilio spend and A2P/10DLC reputation, and gets the number carrier-blocked. A victim number can receive 5/h from **each** attacker business, and STOP to the platform sender does not map to any business.
- **Fix:**
  - Require `verifiedEmail: true` on start/confirm.
  - Do not interpolate the free-text business name. Use a fixed template ("Recepcionista verification code: 123456").
  - Add a global and per-destination (across businesses) daily cap for verification texts.
  - Count these texts against the plan cap after the first few.

### H3. The `+52` Mexican customers who texted STOP before the upgrade are texted again; their opt-out is re-assigned to an unrelated US number
- **Where:**
  - Migration `20261125120000…/migration.sql:206` backfills `sms_opt_outs.phone_e164 = _rc_to_e164(phone_key)`.
  - Legacy rows only hold the **last 10 digits** of whatever number sent STOP. Any non-NANP number whose last 10 digits look like NANP (`+52 55 1234 5678` → `5512345678`, `+44 20 7946 0958` → `2079460958`) becomes `+15512345678` / `+12079460958`.
  - `src/lib/db/compliance.ts:92` then matches only `phone_e164` for non-NANP numbers, so even rows the backfill left NULL are never matched for them. The old `isOptedOut` matched by `phone_key`, so these people were protected before.
- **Repro:** old schema plus two legacy opt-outs, then the migration, then `optout-mig.ts` (DB `r3mig`, `SMS_ALLOWED_COUNTRY_CODES=1,52`):
  ```
   phone_key  |  phone_e164
   5512345678 | +15512345678
   2079460958 | +12079460958
  +525512345678 isOptedOut = false
  +442079460958 isOptedOut = false
  +15512345678 isOptedOut = true          <- a stranger is now suppressed instead
  confirmation to the Mexican customer who texted STOP before the upgrade -> mock NOT BLOCKED
  ```
- **Impact:** This only bites when `SMS_ALLOWED_COUNTRY_CODES` includes non-`1` codes. That is plausible for a bilingual product serving Miami/Hispanic customers.
- **Fix:**
  - In the migration, backfill `phone_e164` from `sms_log.to_e164` / `calls.caller_e164` / `bookings.phone_e164` of the same business where the last 10 digits match. Leave the row NULL where it is ambiguous.
  - In `optOutWhere`, keep matching legacy (`phone_e164 IS NULL`) rows by `phone_key` for **all** countries (fail safe, as the old code did).
  - Add a migration test with a `+52` legacy opt-out.

---

## Medium

### M1. The owner-phone confirm limit is easy to bypass: a malleable challenge allows an unlimited code brute force, so an owner can "verify" a stranger's number
- **Where:** `src/app/api/businesses/[id]/owner-phone/verify/confirm/route.ts:41` keys the 5-attempt limit on `sha256(challenge string)`. `src/lib/messaging/owner-verify.ts:62` decodes the signature with `Buffer.from(sig, 'base64url')`, which ignores whitespace and `=`. So `challenge + ' '`, `challenge + '  '`, … are all valid and each gets a fresh bucket. There is no per-business or per-phone confirm limit.
- **Repro:** `owner-phone-brute.ts`:
  ```
  same challenge, 7 wrong guesses -> 400,400,400,400,400,429,429
  padded variants: 200 guesses, statuses: 400 (no 429)
  correct code on a padded variant -> 200 {"ok":true,"verified_at":"…"}
  owner_phone now +13055550199 verified_at …
  ```
  The code space is 10^6 in a 10-minute window (about 1.7k req/s for certainty), and each `/start` buys another window.
- **Impact:** A verified owner phone receives owner alerts, which are **exempt from opt-out** (`policy.ts` `classify`). A victim's number made "verified" can therefore never STOP them.
- **Fix:**
  - Reject non-canonical encodings: require `sig === hmac(payload).toString('base64url')` as a string compare, and `challenge.length` exactly as issued.
  - Key the limiter on `(business, phone)` and add a per-business confirm cap (for example 20/h).
  - Better still, store challenges server-side and burn one after 5 attempts.

### M2. Anyone can switch signup off for the whole platform with 30 requests an hour
- **Where:** `src/app/api/auth/signup/route.ts:49` calls `takeGlobalSignupSlot()`, a single shared bucket with `SIGNUP_MAX_PER_HOUR` default 30. It is taken for any well-formed request (an existing address counts too), after per-IP limits that allow 5/h behind a trusted proxy and **100/h** without one. Turnstile is optional.
- **Repro:** `signup-dos.sh` against `next start` (one client, no captcha):
  ```
  attacker:  200 200 … (30×) 200
  real customer afterwards: {"ok":false,"error":"signups are temporarily unavailable, try again later"} 429
  ```
  With `TRUSTED_PROXY=true` the same attack needs 6 IPs.
- **Fix:**
  - Count the global cap only for requests that actually create an account. Existing-address and honeypot requests should not count.
  - Raise the default, and use the global cap as an alert threshold (log/notify) rather than a hard lockout, or make it per-/24.
  - Make Turnstile mandatory when signup is enabled in production (deploy.sh).

### M3. Turning on Turnstile, the documented anti-abuse control, breaks every signup because the CSP blocks its iframe
- **Where:** `src/lib/csp.ts:30` has no `frame-src`, so it falls back to `default-src 'self'`. `src/components/auth/turnstile.tsx:10` loads `challenges.cloudflare.com`, whose widget is an iframe from that host. In `CSP_REPORT_ONLY=true` mode the enforced moderate policy (`script-src 'self' 'unsafe-inline'`) also blocks `api.js` itself, because there is no `'strict-dynamic'`.
- **Repro:** `journey.js` (Playwright, production build) injects the Turnstile iframe on `/signup`:
  ```
  CSP violations: [ "Framing 'https://challenges.cloudflare.com/' violates the following Content Security Policy directive: "default-src 'self'". The request has been blocked. Note that 'frame-src' was not explicitly set …" ]
  ```
- **Impact:** The widget never produces a token, and the server fails closed (`captcha_failed`), so 100% of signups fail as soon as `TURNSTILE_SECRET_KEY` is set. No test renders the widget under the CSP.
- **Fix:**
  - When `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set, add `frame-src https://challenges.cloudflare.com`, plus `script-src https://challenges.cloudflare.com` in the moderate policy, as Cloudflare documents.
  - Add a csp unit test for that case.

### M4. Pre-account squatting: anyone can register a victim's address and plant 2FA, and resetting the password does not remove it, so the real owner is locked out permanently
- **Where:**
  - Signup needs no proof of the mailbox to **sign in** (`login/route.ts` does not check `email_verified_at`).
  - `src/app/api/auth/2fa/enroll/route.ts:20` allows enrolment on an unverified account.
  - `reset-password/route.ts:40` changes the password and marks the email verified, but leaves `totp_enabled_at`.
  - Signup for that address now only sends "exists" notices, and an employer's invite to it fails with `409 account_exists`.
- **Repro:** `squat-2fa.ts`:
  ```
  attacker signup -> 200
  attacker login (email unverified) -> 200 {…"email_verified":false}
  attacker enrols 2FA -> 200
  victim resets password -> 200
  victim login -> 200 {"authenticated":false,"mfa_required":true}
  state: email_verified_at 2026-11-23T… totp_enabled true (attacker still holds the TOTP secret)
  ```
- **Fix:**
  - Require a verified email before 2FA enrolment, or before any session at all.
  - If a password reset is completed for an account that was **never verified**, also wipe the TOTP secret, recovery codes and the attacker-created business data (or start a fresh business).
  - Expire unverified accounts after 24-48 h so the address is freed.

### M5. TOTP brute force has no per-account limit and the account owner is never told
- **Where:** `src/app/api/auth/mfa/route.ts:45-46` counts failures per (user, client IP) pair (`mfaPairKey`) and per pending session (5). `src/lib/login-throttle.ts:115` (layer 3) only logs. No email is sent on MFA failures.
- **Repro:** `mfa-distributed.ts` (`TRUSTED_PROXY=true`, 60 `X-Forwarded-For` addresses, password known):
  ```
  180 wrong TOTP guesses from 60 addresses in one burst -> statuses {"401":180}
  auth.mfa_failed audit rows: 180 (no email/notification path exists for these)
  ```
- **Impact:** With ±1 step accepted (about 3/10^6 per guess), a modest botnet of ~1k IPs at roughly 10 guesses/IP/h reaches about 50% in a day.
- **Fix:**
  - Add a per-account MFA failure cap (for example 10/15 min and 30/day) that falls back to a recovery code or an emailed unlock link.
  - Email the user after N failed second-factor attempts, since the password is evidently compromised.

### M6. Over the cap, or with no plan, every call is still answered for up to 15 minutes and still sends an owner SMS
- **Where:** `src/app/api/voice/initiation/route.ts:93-96` only swaps the first message and sends `alertOwner` once per call, with no rate limit. `src/lib/voice/elevenlabs.ts:390` sets `max_duration_seconds: 900`. Tools `flag_emergency` and `handoff_to_human` stay exempt. `src/lib/voice/capacity.ts:4` claims "Nothing is billed beyond the cap". Canceled or trial-expired tenants keep their Twilio number and agent; nothing deprovisions them.
- **Repro:** `overcap-alerts.ts` (`BILLING_ENFORCED=true`, business `canceled`):
  ```
  25 calls to a canceled business -> owner_alert SMS sent: 25 | agent still answers with: [ "…and transcribed. Esta llamada es atendida por un asistente…" ]
  ```
- **Impact:** ElevenLabs minutes and owner SMS are unbounded for tenants that do not pay. Combined with B1/M1 this is an SMS-pumping path.
- **Fix:**
  - When out of service, override the agent with a short `max_duration_seconds` / `end_call` after the message, or reject the call at `/api/voice/incoming`.
  - Rate-limit the "MISSED CALL" alert per business (for example 1 per 10 min plus a daily digest).
  - Release numbers and agents some grace period after `canceled`/`unpaid`.
  - Correct the comment and the docs.

---

## Low

### L1. One free trial per business means unlimited trials per person
`src/app/api/billing/checkout/route.ts:48`: `withTrial = !business.trial_ends_at && !business.stripe_subscription_id`. A new signup gives a new business and a new trial with the same card. There is no card-fingerprint, email-domain or IP check. Every trial provisions a real number and agent.
- **Fix:** keep a `trial_fingerprints` table (Stripe `payment_method.card.fingerprint`, read in `checkout.session.completed`, and a normalized email). Cancel or skip the trial when either was seen before.
- Not run against Stripe; verified in code.

### L2. Team invites carry attacker-chosen text in the platform's email
`inviteTemplate` interpolates `businessName` (120 free characters, URLs allowed) into an email from `EMAIL_FROM`. A verified owner can send 20 such emails an hour per business to arbitrary addresses. The content is escaped HTML, so this is phishing text rather than an injection.
- **Fix:** restrict business names in outbound mail (strip URLs/phone numbers) or quote them clearly ("an account named …").

---

## Claims verified OK

- **Cross-tenant on every new route** (`idor-new.ts`): an owner of A gets **404** against B on onboarding-status (GET/knowledge PUT), knowledge PUT, settings GET/PATCH, owner-phone start/confirm, provision, billing checkout/portal/status, team GET, audit, invite, invite DELETE/resend, user PATCH/DELETE/revoke-sessions and extract. B's staff user was untouched.
- **MFA-pending confinement:** only `session.ts` (`resolvePrincipal` → 401 `mfa_required`), `/api/auth/mfa`, `logout` and `login/mfa/page.tsx` read session tokens directly. Every other route and page goes through `authenticate`/`getServerResolution`.
- **`x-rc-pathname`** is always overwritten by the proxy (`proxy.ts:19`), and its only effect is letting an admin who must enrol reach the security page.
- **Session fixation:** login drops the previous cookies' sessions, and the MFA step issues a brand-new token. Password reset deletes every session. 2FA confirm and disable keep only the current session. Disabling a user deletes their sessions.
- **TOTP replay** is prevented by an atomic step claim (`claimTotpStep`). Recovery codes are single use (`updateMany … usedAt: null`). Disabling 2FA needs both password and second factor.
- **Last-owner guard:** the owner rows are locked with `FOR UPDATE` in a fixed order, so concurrent demote/disable/remove calls are serialised.
- **Invites:** bound to business and role at creation. Inviting needs a verified inviter. Acceptance refuses existing addresses. Tokens are single use (atomic `UPDATE … RETURNING`) and superseded on resend.
- **Email links** are built only from `PUBLIC_BASE_URL`/`APP_URL` and never from `Host` or `X-Forwarded-Host`, so there is no reset poisoning. Verification is POST-only, so link scanners cannot burn tokens. `safeNextPath` and the checkout `return_path` allowlist are sound.
- **Stripe billing webhook:** HMAC with 5-minute tolerance and multiple `v1` values, shared claim/complete/release, and refusal of a customer/business mismatch. The business is resolved by the `stripe_customer_id` stored at checkout start (`ensureCustomer`). `client_reference_id`/metadata are set server-side, and a hint pointing at another business with its own customer is refused. Invoices never resolve by metadata. `mock-activate` returns 404 in production or with Stripe configured.
- **Inbound SMS (STOP/START/YES)** is Twilio-signature verified, and the tenant comes from the `To` number.
- **Initiation webhook:** tool-secret authenticated (fails closed in production). Agent and number disagreements are refused. The declined status stays sticky in the write layer.
- **CSP nonce:** a fresh 128-bit nonce per request. Client `content-security-policy` / `x-nonce` request headers are overwritten. All HTML is dynamic (`Cache-Control: private, no-store`), and API responses get `default-src 'none'`. There are no `/_next/image` remote patterns.
- **Email enumeration:** signup, forgot, resend and verify all return identical bodies and status codes. Mail is sent in `after()`. Measured signup latency for existing vs new addresses (12 pairs) was about 101 ms vs about 106 ms median, which is not a usable signal over the network.
- **`EMAIL_PROVIDER=log`** is refused in production. Audit meta for invites stores only the email domain.
- **Migration** applies from scratch and over old-schema data. There are no table rewrites (constant defaults), and CHECKs are added `NOT VALID` and then validated with a clear error. It is idempotent by construction.

## Unverified suspicions (not proven here)

- **`upgrade-insecure-requests`** is always on in production builds. On `next start` over plain HTTP, Chromium logged `net::ERR_SSL_PROTOCOL_ERROR` for a subresource. This is harmless behind TLS, but it breaks any HTTP-only staging deployment. Not root-caused.
- **No test covers `scripts/grandfather-existing.ts`** (only the admin-override route is tested). Its `assertSafeDatabase` guard is bypassed by the documented `--force-i-know`, so running it against the wrong `DATABASE_URL` writes immediately after the dry run is skipped.
- **Accepting an invite can burn the token.** If an account for that address is created between the pre-check and `createUser` (`accept-invite/route.ts`), the token is already consumed and the call returns 409. The docstring says the invite is not used up.
- **Disabling 2FA does not revoke pending sessions of the same user.** They become full sessions for the rest of their 10-minute TTL.
- **Revenue risk from usage metering.** Call seconds are recorded from the post-call webhook. A post-call that is unmatched or rejected (see H1's duplicate-webhook case) records no usage, so the call cap under-counts.
