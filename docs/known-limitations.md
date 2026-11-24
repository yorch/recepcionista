# Known limitations

Deliberate or accepted gaps in this release, so nobody discovers them in production. Each says what is missing, the
consequence and what the operator can do. Hardening fixed in review rounds 1-3 is in `docs/review/` (the reviews are point-in-time snapshots: several of their statements, such as "no CI" or "nothing schedules the briefing", were true when written and are not true now; `docs/changelog-hardening.md` maps every finding to its current state); this file lists what
remains. Not legal advice (see `docs/compliance.md`).

## Accounts and authentication (docs/auth.md)

- **No password-less or federated login.** Email plus password, optional TOTP (authenticator app, recovery codes). No SSO/SAML/OIDC, no passkeys/WebAuthn, no SMS second factor. A lost
  authenticator without recovery codes needs an operator (`scripts/create-user.ts`, DB access) to reset.
- **No hard per-account cap on distributed second-factor guessing.** TOTP guesses are limited per (account, client IP), per pending session (5) and by a 10-minute pending lifetime;
  the per-account counter across IPs only logs (`distributed_guessing`) because blocking on it would let anyone lock a user out. A large botnet is slowed, not stopped. Mitigation: strong passwords, alerts on that log line.
- **Open signup needs a captcha in production** (Turnstile pair, or the explicit `SIGNUP_ALLOW_WITHOUT_CAPTCHA=true`). Without either, signup is refused and the product is invite-only. The opt-out leaves only rate limits and the hourly cap
  against bot farms. Turnstile depends on Cloudflare being reachable; verification fails closed, so a Cloudflare outage stops signups (invites and logins keep working).
- **One account belongs to one business**; an address that already has an account cannot be invited into another business.
- **The break-glass `ADMIN_TOKEN` cannot be revoked server-side** except by rotating it (its sessions can be revoked).
- Email is a root of trust: whoever controls the mailbox can reset the password (2FA still applies at login). No email deliverability monitoring beyond provider errors being logged.

## Deployment and scale

- **Single region, single Postgres, no read replicas.** Rate limits, leases, idempotency claims and the signup caps live in Postgres (`rate_limit_buckets`, `processed_events`, leases), so several app instances behind one database work,
  but multi-region or active-active is not designed. The background job runner (daily briefing at 18:00 per business time zone, hourly gratitude sweep, hourly cleanup, and the retention purge when enabled) runs inside every app process under Postgres leases and idempotency claims, so a second instance repeats nothing. It is a timer, not a queue: if every instance is down at 18:00 the briefing is caught up when one returns, but only until local midnight; the briefing-ready text is skipped in quiet hours and when the SMS cap is full. Work per pass is bounded (10 briefings, 25 gratitude sweeps), so very large installs catch up over several ticks. `JOBS=off` stops all of it.
- **Backups, restores, TLS termination and the reverse proxy are the operator's** (`DEPLOY.md`, `docs/runbook.md`). Per-client rate limits need `TRUSTED_PROXY=true` behind a proxy you control; without it all clients share one bucket.
- **Plain-HTTP staging** works only with `CSP_UPGRADE_INSECURE=false` or an `http://` `APP_URL` (otherwise browsers upgrade subresources to HTTPS and fail); Twilio, Stripe and ElevenLabs call back over public HTTPS, so a staging box that must receive their webhooks needs HTTPS anyway.
- `NEXT_PUBLIC_*` values (Turnstile site key, plan price text) are inlined at build time: changing them needs `./deploy.sh` (a rebuild), not a restart.

## Telephony, voice and messaging

- **Twilio Advanced Opt-Out / default long-code STOP handling** can block a number at Twilio (error 21610) without forwarding the STOP to `/api/sms/inbound`, so the app's suppression list only knows STOPs it saw. Matching is on E.164;
  anything ambiguous is over-suppressed rather than texted (`docs/compliance.md`). Keep Twilio's own opt-out handling on and reconcile in the Twilio console.
- **Provider-side retention needs operator settings.** ElevenLabs conversation retention / zero-retention, audio saving, Twilio recording and message-log retention, and the LLM provider's no-training settings are configured by the operator in each console
  (`docs/runbook.md` section 5). The app does not set them, cannot verify them, and does not purge provider-side recordings/transcripts (declined calls: best effort). Retention shorter than post-call delivery would break the transcript webhook.
- **Several ElevenLabs API call shapes are unverified best effort** (the conversation-initiation webhook configuration on workspace/agent, and, for tenant release, detaching the shared phone number from an agent before deleting it). Failures are logged and the runbook says what to check by hand.
- **Number provisioning is US-only; the area code is the owner phone's own (when a valid US/Canada number), else `TWILIO_AREA_CODE` (default 305).** The Twilio account is shared by all tenants: a purchase whose answer is lost is adopted only if the number carries this attempt's FriendlyName tag, so a purchase that Twilio completed but never confirmed AND whose listing is still missing after ~13 s of retries is left unadopted (an operator finds it in the Twilio console via the `provision.number_failed` audit row; a retry buys another number). When Twilio search/purchase fails (or in production without Twilio credentials) provisioning FAILS with a 502/503 and the business stays `onboarding`; no fake number is ever issued there (the mock-pool number exists only outside production with no Twilio credentials). A purchase whose answer was lost is looked up and adopted, and a number bought before a later failed step is kept and reused by the retry. A tenant outside the US needs an operator-assigned number. Provisioning binds the single configured `ELEVENLABS_PHONE_NUMBER_ID` to an agent; serving several tenant lines on the native-Twilio path
  means importing each number into ElevenLabs, which is an operator step the app does not perform.
- **Languages: English and Spanish for the agent and texts; the dashboard UI is English only** (the Spanish-speaking owner base reads English labels; translating the UI is not planned for this release).
- **SMS caps count segments, not sends**, using the GSM-7/UCS-2 rules of `smsSegments` (a two-unit character is never split across segments, as on a handset). Carriers can still differ on exotic edge cases (national-language shift tables), so the count can differ from the Twilio invoice by a segment; inbound-reply auto-answers sent by Twilio are counted from our own reply templates. Trial caps (`TRIAL_SMS_CAP`, `TRIAL_CALL_MINUTES_CAP`) apply only while billing is enforced.
- **Usage metering depends on the post-call webhook.** Call minutes are added once per conversation when that webhook is accepted; a conversation whose post-call never arrives, is unmatched or is rejected is not metered, so the call cap can under-count.
  Over-cap calls are cut to 60 s by the initiation override (needs that override enabled on the agent); the cap is not enforced mid-call for calls already running.
- **Emergency handling is advice plus an owner alert**, not dispatch. The agent tells the caller to hang up and call 911 and alerts a verified owner phone; an unverified or opted-out owner phone gets no alert (the agent says so honestly). Because these alerts are exempt from the SMS plan cap they have their own per-business hourly budget (`OWNER_ALERT_HOURLY_LIMIT`, default 6; the first emergency of a call may go to 2x): a caller who makes the agent raise many different alerts gets an honest "could not reach the owner" once it is spent, and the owner is told at most once about identical alerts for a call. Alerts are cut to 320 GSM-safe characters (accents and dashes are transliterated).
- No do-not-call scrubbing, no written-consent capture UI for follow-up/review texts, no HIPAA/PCI scope, no data residency controls (`docs/compliance.md`, "Out of scope").

## Billing (docs/billing.md)

- **Stripe only, one monthly plan** with per-business SMS/call-minute caps. No usage-based billing, annual plans or seat pricing; invoices and tax are whatever Stripe provides.
- **Free trials are limited per card fingerprint and normalised email**, which stops casual repeats but not someone with many distinct cards and addresses.
- **Released tenants lose their number for good.** `scripts/release-canceled-tenants.ts` releases a canceled tenant's Twilio number and ElevenLabs agent after the grace period and a heads-up mail; a later resubscription is provisioned with a NEW number. The
  workspace-wide ElevenLabs tools are shared by all tenants and are only removed when the last agent goes. A business with no owner email is not released automatically (admin API with `skip_notice`). Run it on a schedule: nothing releases on its own.
- Comped (grandfathered/admin-set) accounts are never released or billed by the app; they are an operator decision to revisit.
- `BILLING_ENFORCED=false` is a supported opt-out but disables caps and plan checks for existing tenants; do not combine it with open signup.

## Data, privacy and operations

- Retention (`RETENTION_JOB=on`) purges calls, transcripts, SMS bodies, briefings and nulls booking PII after `retention_days`; opt-outs are never purged. It is off by default so an upgrade cannot silently delete data.
- Audit events are append-only and not purged by retention; their metadata avoids secrets and message bodies (secret-looking keys are redacted) but contains actor and business ids, client IPs and, for releases, the last 4 digits of the number.
- Database migrations are forward-only; rollback means restoring a backup (`docs/runbook.md` section 4).
- Accepted advisories in dev/CLI-only transitive dependencies are listed in `docs/dependencies.md`.
- Tests run against a scratch Postgres and fake providers; **no automated test places a real call or sends a real SMS/email**. `bun run verify:deploy` and the manual live test-call protocol (`docs/runbook.md` section 2) cover the real wiring.

## Call handling, calendar and roadmap (this release)

- **Call forwarding on the native ElevenLabs path (the production setup) does not exist.** There the platform answers the call before any of our code runs, so the app cannot dial a human. The dashboard says "Forwarding is not available on the AI voice line - callers will hear the paused message", the Forward choice is disabled, and `PATCH call-mode {mode:'forward'}` is a 422 (a business that already had `forward` stored behaves as `paused`). The ElevenLabs "transfer to number" system tool takes a static destination or a dynamic variable, with no documented per-call API override, so it was not used (and a caller-influenced destination would bypass the forward-number rules). Real forwarding exists only on a webhook line (`VOICE_LINE_KIND=webhook`: the Twilio Voice URL is `/api/voice/incoming`), which has no AI conversation, or through the owner's own carrier forwarding.
- **`/api/voice/incoming` is not an AI line.** It returns TwiML for paused/forward and JSON for `ai` (a demo/test contract). Importing the number into ElevenLabs is the only supported way to get AI calls.
- **Forwarded minutes are the bridged seconds** of the dialled leg (the inbound leg's own Twilio cost and ringing time are not counted); they come from Twilio callbacks, so a lost callback after retries means those minutes are not counted. Voicemail audio length is counted from Twilio's `RecordingDuration`.
- **Voicemail audio stays at Twilio** until the retention purge (needs `RETENTION_JOB=on`) or a customer erasure deletes it there (best effort, logged); with the purge off, recordings are kept.
- **Step-up re-authentication** exempts the break-glass admin token / cookie and `ALLOW_INSECURE_DEV` (they carry no password); pre-existing sessions have no recent-auth stamp and ask for the password once.
- **Paused prompt override** (`ELEVENLABS_PAUSED_PROMPT_OVERRIDE`) uses an UNVERIFIED ElevenLabs override field and is off by default; the enforcement that matters (every tool except taking a message is refused) is server-side.
- **Cancelling a booking does not refund a paid deposit** and does not text the customer; the owner is told in the UI. Owners cannot reschedule from the calendar (cancel and rebook).
- **Calendar**: week starts on Sunday for US/CA/MX-style businesses, Monday elsewhere (viewer can switch, stored in the browser). Jobs that cross a DST jump are stretched or squeezed by the skipped hour; overnight opening hours are not supported.
- **Not built, by owner decision (roadmap)**: owner voice reply, live transcript, Google Calendar sync.
- **Mock number detection** (`isMockPoolNumber`) is derived from the number shape, not a stored flag; those numbers exist only outside production without Twilio credentials.
- **HVAC coupling**: the default prompt, triage questions and templates are written for HVAC/home-service businesses; other trades must edit the prompt in Brain.
- **Structural refactors not done** (no behaviour change, risk on paid-resource paths): extracting `provisionBusiness` from the provision route; replacing the remaining raw hex colours with design tokens everywhere; no automated accessibility audit in CI (the new calendar, panel and switch are keyboard and label tested by hand).
- **`/pay/[id]` is a bearer link**: the booking id is an unguessable UUID and the page shows service, amount and business name only; anyone holding the link can open it by design.
- **Deploy**: no reverse-proxy rate-limit middleware ships in compose (the app has its own Postgres limiter); `deploy.sh` still sources `.env` as shell, so values must be shell-safe.
