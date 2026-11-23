# Known limitations

Deliberate or accepted gaps in this release, so nobody discovers them in production. Each says what is missing, the
consequence and what the operator can do. Hardening fixed in review rounds 1-3 is in `docs/review/`; this file lists what
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
  but multi-region or active-active is not designed. The daily retention job and the in-process scheduler run inside the app process (they are idempotent, so a second instance repeats nothing harmful).
- **Backups, restores, TLS termination and the reverse proxy are the operator's** (`DEPLOY.md`, `docs/runbook.md`). Per-client rate limits need `TRUSTED_PROXY=true` behind a proxy you control; without it all clients share one bucket.
- **Plain-HTTP staging** works only with `CSP_UPGRADE_INSECURE=false` or an `http://` `APP_URL` (otherwise browsers upgrade subresources to HTTPS and fail); Twilio, Stripe and ElevenLabs call back over public HTTPS, so a staging box that must receive their webhooks needs HTTPS anyway.
- `NEXT_PUBLIC_*` values (Turnstile site key, plan price text) are inlined at build time: changing them needs `./deploy.sh` (a rebuild), not a restart.

## Telephony, voice and messaging

- **Twilio Advanced Opt-Out / default long-code STOP handling** can block a number at Twilio (error 21610) without forwarding the STOP to `/api/sms/inbound`, so the app's suppression list only knows STOPs it saw. Matching is on E.164;
  anything ambiguous is over-suppressed rather than texted (`docs/compliance.md`). Keep Twilio's own opt-out handling on and reconcile in the Twilio console.
- **Provider-side retention needs operator settings.** ElevenLabs conversation retention / zero-retention, audio saving, Twilio recording and message-log retention, and the LLM provider's no-training settings are configured by the operator in each console
  (`docs/runbook.md` section 5). The app does not set them, cannot verify them, and does not purge provider-side recordings/transcripts (declined calls: best effort). Retention shorter than post-call delivery would break the transcript webhook.
- **Several ElevenLabs API call shapes are unverified best effort** (the conversation-initiation webhook configuration on workspace/agent, and, for tenant release, detaching the shared phone number from an agent before deleting it). Failures are logged and the runbook says what to check by hand.
- **Number provisioning is US-only with a fixed starting area code (305)**, falling back to a mock number when Twilio search/buy fails (logged `number.fallback_mock`). A tenant outside the US needs an operator-assigned number. Provisioning binds the single configured `ELEVENLABS_PHONE_NUMBER_ID` to an agent; serving several tenant lines on the native-Twilio path
  means importing each number into ElevenLabs, which is an operator step the app does not perform.
- **Languages: English and Spanish only** for the agent, texts and UI.
- **Usage metering depends on the post-call webhook.** Call minutes are added once per conversation when that webhook is accepted; a conversation whose post-call never arrives, is unmatched or is rejected is not metered, so the call cap can under-count.
  Over-cap calls are cut to 60 s by the initiation override (needs that override enabled on the agent); the cap is not enforced mid-call for calls already running.
- **Emergency handling is advice plus an owner alert**, not dispatch. The agent tells the caller to hang up and call 911 and alerts a verified owner phone; an unverified or opted-out owner phone gets no alert (the agent says so honestly).
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
