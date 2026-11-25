# Deployment runbook

Companion to `DEPLOY.md` (how the stack is built) and `docs/compliance.md` (what the app does about consent and
retention). This file is the order of operations for a production release and the checks that prove it worked.
Not legal advice.

## 1. Pre-deploy checklist

1. **Migrations on a copy first.** Restore the latest production backup into a scratch database and run
   `DATABASE_URL=<scratch> bunx prisma migrate deploy`. Read the migration list for anything that rewrites or
   deletes data (for example `20261124120000` rewrites stored prompts). Only then run it against production.
   Take a fresh backup (`pg_dump -Fc`) immediately before the real run and note its filename.
2. **Environment variables** (`.env.example` is the template; docs/env-vars.md tabulates every variable and deploy.sh enforces the required ones). Also required in production: `APP_SECRET_KEY`, `EMAIL_PROVIDER` (`resend`/`smtp`) with `EMAIL_FROM` and its key, and with `BILLING_ENFORCED=true` also `STRIPE_PRICE_ID` and `STRIPE_BILLING_WEBHOOK_SECRET` (then comp existing tenants first: docs/billing.md). Required in production: `APP_URL` (https),
   `ADMIN_TOKEN`, `DATABASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET`,
   `ELEVENLABS_TOOL_SECRET`, `ELEVENLABS_PHONE_NUMBER_ID` and the LLM key. `ELEVENLABS_TOOL_SECRET_ID`
   (optional): id of an ElevenLabs workspace secret holding the same value as `ELEVENLABS_TOOL_SECRET`, so the tool
   header is stored as a secret reference instead of a literal.
   Open signup also needs a captcha in production: `TURNSTILE_SECRET_KEY` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, or the explicit, not recommended `SIGNUP_ALLOW_WITHOUT_CAPTCHA=true` (deploy.sh fails without one of them; at runtime `POST /api/auth/signup` answers `503 signup_disabled` and `/signup` shows an invite-only notice; invites keep working).
   Must be absent or off: `ALLOW_INSECURE_DEV`, `DEMO_MODE`, `STRIPE_ALLOW_UNSIGNED`. Keep `RETENTION_JOB` unset
   until step 6. `JOBS` is on by default in production (see "Background jobs" below); leave it unset unless you deliberately want `off`. Set `TRUSTED_PROXY=true` only behind a proxy you control.
3. **Deploy** (`./deploy.sh`), then run `bun run verify:deploy` (section 3) before touching DNS/number routing.
4. **Re-provision every business** (`POST /api/businesses/:id/provision`, admin token) so each ElevenLabs agent gets
   the current first message (disclosure), prompt and tool definitions (the tool secret header is refreshed on
   existing tools). The first provision of a workspace returns the post-call webhook signing secret ONCE: store it
   as `ELEVENLABS_WEBHOOK_SECRET`, redeploy, re-run `verify:deploy`. Then do section 6 (initiation webhook, owner phones).
5. **Twilio inbound SMS URL.** Numbers bought by the app are created with `SmsUrl=https://<APP_URL>/api/sms/inbound`
   (POST) already set (and, on a `webhook` line, `VoiceUrl=.../api/voice/incoming`). For numbers bought BEFORE that (or by hand), run
   the idempotent repair: `curl -sX POST $APP_URL/api/admin/repair-numbers -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{}'`
   is a DRY RUN (default) that reads each tenant number from Twilio and lists the fields that would change; send `{"dry_run": false}`
   to apply (batches of 10, `next_cursor`; the platform sender and mock-pool numbers are never touched; it never changes the Voice
   URL on a native ElevenLabs line). Doing it by hand in the console is equivalent: a number has one inbound URL; STOP/START/HELP, "Reply C",
   1-5 ratings, owner YES codes and gratitude replies all go through it. The voice side is the ElevenLabs native Twilio integration (the number is imported into
   ElevenLabs, which owns the Voice URL), not `/api/voice/incoming`.
6. **Retention.** `POST /api/admin/retention {"dry_run": true}` and review what would be purged per business
   (default window is 365 days). Adjust each business's `retention_days` in Dashboard > Settings, then set
   `RETENTION_JOB=on` and redeploy. The boot log states whether the job is enabled.
7. **Create the first owner:** `CREATE_USER_PASSWORD=... bun scripts/create-user.ts --email owner@x.com --role owner --business <id>`
   (and a global admin with `--role admin`). Log in at `/login`.
8. **Provider-side settings** (section 5): retention / zero-retention in ElevenLabs, Twilio recording off.

### Background jobs (daily briefing, gratitude sweep, cleanup, retention)

One small runner starts with the app (`src/instrumentation.ts` -> `src/lib/jobs`), never during `next build`. `JOBS=on|off` (also true/false, 1/0, yes/no; default **on in
production**, off in development/test), `JOBS_TICK_SECONDS` (default 60). It runs inside every app instance; each unit of work is fenced by a
Postgres lease plus an idempotency claim in `processed_events`, so several instances (or a restart in the middle of a pass) never do the same work twice.
A job checks that it still holds its lease before every paid or user-visible step (generating a briefing, texting the owner, each gratitude text): a runner that lost its lease (renewals failing for longer than the lease TTL) stops, gives its claim back and reports `lease_lost`; the next tick finishes the work. A tick reads only the narrow `live` business columns (indexed on `status`) and, after 18:00 local, two batched lookups for all due tenants; it never loads a tenant's sms or booking history (the gratitude sweep reads only the 20-48 h booking window).

| Job | When | What it does |
| --- | --- | --- |
| `daily_briefing` | 18:00 in each business's own time zone (a missed run is caught up until local midnight, never the next day) | Generates the day's briefing once per local day for every **live** business whose billing allows service (`isProvisioningAllowed`; in production a plan is always required, so comp admin-provisioned tenants with `/api/admin/billing`). Then texts the owner a link to `/dashboard/briefings`, only to a **verified** owner phone, never in quiet hours (9pm-8am local) and only while the SMS cap has room. A briefing already generated after 18:00 that day (by hand or by another instance) is not redone. Max 10 per pass; the rest follow on the next pass |
| `gratitude_sweep` | hourly | `runGratitudeSweep` per live, billing-allowed business: consent, opt-out, quiet-hours and cap rules are unchanged. A business in quiet hours is skipped. Max 25 businesses per pass |
| `cleanup` | hourly | deletes expired sessions, expired email tokens, `processed_events` older than 30 days and stale rate-limit buckets |
| `retention` | daily, only when `RETENTION_JOB=on` | the PII purge of docs/compliance.md. Default OFF is unchanged |

Look and drive (admin token): `GET /api/admin/jobs` shows, per job, whether this instance runs it, `last_run_at`, the newest recorded result and `next_due_at`.
`POST /api/admin/jobs/run {"job":"daily_briefing"|"gratitude_sweep"|"cleanup"|"retention","business_id"?:"...","dry_run"?:true}` runs one job by hand;
**`dry_run` defaults to true** (reports what it would do, changes nothing). A real manual run ignores only the time-of-day gate, never billing, consent, caps or idempotency, and is audited (`jobs.manual_run`).
Job runs that did work or failed are in the audit trail (`jobs.<name>`). No new table: state lives in `processed_events` (`job-state`, `daily-briefing`, `gratitude-sweep`) and `provision_locks` (`job:*`).
If a briefing never appears: check `GET /api/admin/jobs`, then the owner's phone verification, the business `status` (must be `live`) and billing; the logs line is `jobs ... briefing.failed`.

### Phone numbers fail loudly

The Twilio account is SHARED by every tenant, so the purchase is guarded (docs/review/08 F1): the candidate must not be held by any business or be `TWILIO_PHONE_NUMBER`, it is reserved for this attempt (`processed_events` `number-candidate`) so two tenants provisioning at once in the same area code never buy the same one, the attempt is recorded BEFORE the purchase (`number-attempt:<attempt id>:<number>`), and the purchase is tagged with FriendlyName `recepcionista:<attempt id>`. If the purchase answer is lost (timeout/5xx) the account is re-listed with backoff (the listing can lag) and a number is adopted ONLY when it carries this attempt's tag and no business holds it; otherwise nothing is adopted and the audit row `provision.number_failed` carries `unsettled_candidate` for the operator (check Twilio Phone Numbers). The area code is the one of the owner's own phone when valid, else `TWILIO_AREA_CODE` (default 305). A bought number that cannot be saved is released ONLY when this call bought it and no other business holds it; when another business holds it the answer is 502 `number_taken` and nothing is deleted.

`POST /api/businesses/:id/provision` never stores a fake number when Twilio is configured or in production. A failed search/purchase answers **502** (`number_purchase_failed`) and, without Twilio credentials in production,
**503** (`phone_provider_not_configured`); the business stays `onboarding`, an audit event (`provision.number_failed`) is written and retrying is safe (nothing was bought, or the number that was bought is adopted/reused).
If the number was bought but the voice agent / post-call webhook step failed, the answer is 502 `agent_registration_failed` with `partial.phone`: the number stays recorded on the business (`provision.partial` audit event),
the business is still `onboarding`, `GET /api/businesses/:id/onboarding-status` shows `provision_partial`, and the next provision call reuses that number (never buys a second one) and resumes at the agent step. The mock-pool number
(`+1<area>555xxxx`) is issued only outside production with no Twilio credentials at all.

## 2. Manual live test-call protocol

Do this from a phone that is NOT the owner's number, against the real number, after steps 1-8. Keep the dashboard
(Calls) open and a DB shell for the checks. Use a throwaway name and a test address.

| # | Say / do | Verify |
|---|----------|--------|
| 1 | Call and listen only. | Agent opens with the AI/recording disclosure BEFORE the greeting, in both languages. A `calls` row exists, `consent_status='disclosed'` (never `unknown`) once the call completes. |
| 2 | "My AC isn't cooling, can I get a quote?" then ask a price. | Agent calls get_pricing (tool log), quotes the KB value, never invents one. |
| 3 | Ask for an appointment tomorrow morning; give name, address; accept a slot; confirm details. | A `bookings` row with the right LOCAL time (not shifted by the UTC offset), phone = caller id, tenant = the right business. Confirmation SMS arrives on the test phone with STOP/HELP wording. |
| 4 | Ask to pay a deposit. | Payment link SMS arrives; `/pay/<id>` shows https page and loads; do not pay unless using Stripe test mode. |
| 5 | Reply `STOP` to a text, then trigger another text. | Opt-out recorded; no further text is sent to that number; `START` restores it. |
| 6 | After hanging up: wait ~1 minute. | Post-call webhook processed: transcript, summary, duration, language on the call; one row per call (no duplicates); recording URL only if present. |
| 7 | Declined-recording case: new call; when the agent speaks the disclosure say "I don't want to be recorded / I don't want to talk to a robot." | Agent offers to take a message and calls handoff_to_human with consent_declined. After hanging up: `consent_status='declined'` (sticky), NO transcript/summary/recording stored (metadata only), provider conversation deleted (check the ElevenLabs conversation list: gone; if the delete failed the log has `provider_delete.failed`). |
| 8 | 911 case: new call, say "I smell gas / there is smoke from the unit." | Agent FIRST tells the caller to hang up and call 911 (and the gas utility), then flags the emergency; owner gets an alert SMS; `urgency='emergency'`. Do not stay on the line pretending. |
| 9 | Cross-tenant: if more than one business exists, call each number. | Each call lands under its own business; tool calls never show another tenant's data. |
| 10 | Wrong-number/odd cases: hang up during greeting; call from a blocked number. | No crash; call row marked incomplete, no booking, no SMS to a blank number. |

Record the results (date, who, call ids) in the release notes. A failure in 1, 7 or 8 blocks the launch.

## 3. Automated check: `bun run verify:deploy`

```
APP_URL=https://app.example.com TWILIO_AUTH_TOKEN=... STRIPE_WEBHOOK_SECRET=... \
STRIPE_BILLING_WEBHOOK_SECRET=... ELEVENLABS_WEBHOOK_SECRET=... ELEVENLABS_TOOL_SECRET=... [PUBLIC_BASE_URL=...] bun run verify:deploy [--strict]
```

Run it from an operator machine with the same secrets as the server. It is read-only: forged requests use benign
event shapes (ignored Stripe type, `post_call_audio`, an SMS to a number no business owns) and never write rows.
A secret that is not exported is SKIPped (`--strict` turns skips into failures). Failures of the form "ACCEPTS
correctly signed" mean the secret you hold differs from the server's, or `PUBLIC_BASE_URL`/scheme differs from the
URL Twilio signs. It also checks `POST /api/voice/initiation` (401 without the tool secret; with it, 200 and a well-formed body for an unknown agent), `/api/billing/webhook` (unsigned/badly signed rejected, a signed synthetic event acknowledged), that `/login`, `/signup`, `/robots.txt` and `/sitemap.xml` are public, and that every mutating `/api/auth/*` endpoint refuses a cross-site cookie POST. It prints a PASS/FAIL table and never prints secrets. Security-header checks require headers
(CSP, X-Content-Type-Options, X-Frame-Options/frame-ancestors, Referrer-Policy, Permissions-Policy, HSTS on https)
on `/login` and `/pay/*`; fix the deployment (app or Traefik middleware) if they fail.

## 4. Rollback

- **App only (no migration in the release):** redeploy the previous image tag/commit with `./deploy.sh`; confirm
  with `verify:deploy`.
- **With a migration:** prefer roll-forward. Prisma migrations are not reversible automatically. If the release must
  be abandoned: stop the app, restore the pre-deploy `pg_dump` (you took one in step 1; data written since is
  lost), deploy the previous image. Never run `prisma migrate reset` or the db-reset script on production.
- **Telephony:** to take the line out of service without a deploy, unassign the agent from the number in
  ElevenLabs (callers hear the provider's fallback) or change the number's voice URL in Twilio to a forwarding
  number. Re-provisioning a business after rollback re-pushes the prompt/tools matching the running version.
- **Retention:** set `RETENTION_JOB` off immediately if a purge looks wrong; purged rows are only recoverable from backup.
- **Secrets leaked/rotated:** rotate `ELEVENLABS_TOOL_SECRET` (then re-provision so the tools carry it),
  `ELEVENLABS_WEBHOOK_SECRET` (regenerate the webhook in ElevenLabs), `TWILIO_AUTH_TOKEN`, `STRIPE_WEBHOOK_SECRET`,
  `ADMIN_TOKEN`; redeploy; run `verify:deploy`.

## 5. Operator legal and provider checklist (the app cannot do these for you)

- [ ] **10DLC** brand and campaign registered with Twilio before US A2P texting; campaign description matches the
      actual messages including STOP/HELP.
- [ ] **Counsel reviewed** the recording/AI disclosure, SMS wording and consent bases for each state served
      (all-party-consent states such as Florida included) and TCPA consent for gratitude/review texts.
- [ ] **DPAs** signed with Twilio, ElevenLabs and the LLM provider; sub-processors, training and retention terms checked.
- [ ] **Privacy policy and terms** published; a process exists for access/erasure requests (the privacy endpoints are
      tooling, not the process).
- [ ] **ElevenLabs retention:** conversation retention / zero-retention mode and audio saving configured in the
      workspace or agent privacy settings (`platform_settings.privacy`: `retention_days`, `record_voice`,
      `zero_retention_mode`, `delete_transcript_and_pii`, `delete_audio`; zero-retention is plan-restricted). The app
      does NOT set these; matching them to each business's `retention_days` is a manual step. NOTE: the post-call
      webhook is the only way the app receives the transcript, so retention shorter than delivery would break it;
      zero-retention mode may also affect what the webhook carries. Test a call after changing it.
- [ ] **Twilio:** call/message recording off unless intended; message logs retention reviewed; Twilio does its own
      STOP auto-reply.
- [ ] **LLM provider:** confirm no-training / zero-retention API settings.
- [ ] Legal-hold, tax and insurance record requirements reconciled with `retention_days`.

## 6. Initiation webhook, owner phones and usage caps

**ElevenLabs conversation-initiation webhook** (`POST /api/voice/initiation`). It is what records the disclosure evidence
on the native Twilio path and enforces the call cap. Request/response shape is VERIFIED against the ElevenLabs
"Twilio personalization" docs; those docs configure it only in the UI. Provisioning (`syncAgent`, and the
post-call registration, which writes the same `platform_settings.overrides` so neither undoes the other) tries these
API calls, which are UNVERIFIED because the API reference could not be read when this was written:

- `PATCH /v1/convai/settings` with `conversation_initiation_client_data_webhook: { url, request_headers }`;
- `PATCH /v1/convai/agents/{id}` with `platform_settings.overrides.enable_conversation_initiation_client_data_from_webhook: true`
  and `platform_settings.overrides.conversation_config_override.agent.first_message: true`.

A rejected call only logs `initiation.workspace_failed` / `initiation.agent_failed`. **Check it by hand** after
provisioning, and do these in the UI if the API route did not take effect (or set `ELEVENLABS_INITIATION_WEBHOOK=off`):

1. ElevenAgents settings: set the conversation-initiation webhook URL to `https://<APP_URL>/api/voice/initiation`, add a
   workspace secret holding `ELEVENLABS_TOOL_SECRET`, and send it in the header `x-recepcionista-tool-secret`.
2. Each agent > Security: enable fetching conversation-initiation data for inbound Twilio calls and allow overriding the
   first message.
3. Verify: place a call; before it ends the `calls` row exists with `consent_status='disclosed'`, `caller_e164` set, and
   exactly one row for the call (the initiation, tools and post-call all share it). A request without the header must be 401:
   `curl -s -o /dev/null -w '%{http_code}' -X POST https://<APP_URL>/api/voice/initiation -d '{}'`.
   If the platform ignores the webhook the agent still opens with the provisioned first message (disclosure included), but
   the row stays `unknown` until the post-call evidence arrives.

**Owner phone verification rollout.** Alerts are only sent to a verified owner phone. After deploying:
1. Set `OWNER_PHONE_GRANDFATHER=true` for the transition (existing numbers keep receiving alerts). In production this is ignored unless
   `OWNER_PHONE_GRANDFATHER_ACK=i-understand` is set too (deploy.sh refuses the switch without it, startup logs `owner_phone_grandfather`), and it should always
   carry `OWNER_PHONE_GRANDFATHER_BEFORE=<deploy time>` and `OWNER_PHONE_GRANDFATHER_UNTIL=<a short expiry>`: such numbers bypass opt-outs and the country allow-list.
2. Ask each owner to verify their number (the UI calls `POST /api/businesses/:id/owner-phone/verify/start {phone}` then
   `.../confirm {phone, code, challenge}`).
3. Find the stragglers: `SELECT id, name FROM businesses WHERE owner_phone IS NOT NULL AND owner_phone_verified_at IS NULL;`
4. Unset `OWNER_PHONE_GRANDFATHER` and redeploy. From then on unverified numbers get no alerts (log
   `owner_alert.owner_unverified`, sms_log status `blocked_owner_unverified`, and the voice tool tells the caller the owner was not notified).
Separately, comp existing paying tenants with `bun scripts/grandfather-existing.ts --before <deploy time>` (dry run by default, `--apply` to write; docs/billing.md). It never verifies a phone and skips self-signup, unverified-email and unverified-phone businesses.

**Verification-text abuse limits.** `POST .../owner-phone/verify/start` needs a verified email, sends a fixed text (`Recepcionista verification code: 123456...`, no tenant-chosen characters), and is limited per business+phone+client (5/h), per business (10/h, 15/day), per user (10/h), per client IP (20/h), per destination number across ALL businesses (3/h, 5/day) and platform-wide (`OWNER_VERIFY_GLOBAL_PER_HOUR` 300, `OWNER_VERIFY_GLOBAL_PER_DAY` 2000). Numbers that opted out of any business, or were verified by another business in the last 30 days, are refused (an admin may override the latter). After 3 texts a day per business they count against the plan cap when billing is enforced. Confirm attempts are limited per server-verified challenge (5), per business+phone (10 / 10 min) and per business (20 / h); re-spelled (padded) challenges are rejected.

**ElevenLabs post-call webhook secret.** The platform-wide webhook is created by an ADMIN provision call only (`POST /api/businesses/:id/provision` with the admin token); its one-time `webhook_secret` appears only in that response: store it as `ELEVENLABS_WEBHOOK_SECRET`. Tenant provisioning only attaches the existing webhook (idempotent lookup by URL, retried; a failed lookup never creates one). If the webhook does not exist yet the tenant gets `post_call_webhook_pending: true` and the log `webhook.missing`: run one admin provision first.
Demo installs need none of this: `scripts/seed.ts` creates the demo business with a verified owner phone and `billing_status='active'`.

**Usage caps.** Plan caps are on whenever billing is enforced (production default; `BILLING_ENFORCED=false` is the explicit opt-out, docs/billing.md). Over the SMS cap customer texts are logged `blocked_cap` (owner alerts,
STOP/HELP replies and verification codes still go out and are counted). Over the call-minutes cap `/api/voice/initiation` and
`/api/voice/incoming` give the caller the out-of-service line and mark the call `handed_off` with `flagged_reason='out_of_service:<reason>'`;
search the logs for `call.refused`. The gate reads the live state on every call (no cache), the initiation override cuts such a call to 60 seconds
(`conversation.max_duration_seconds`, needs the initiation webhook override enabled on the agent, which provisioning does), and the owner's "MISSED CALL" text is limited to
1 per 10 minutes and 6 per hour per business. A business that stays canceled keeps its number and agent until the `tenant_release` job (`TENANT_RELEASE_JOB=on`), `scripts/release-canceled-tenants.ts` (or `POST /api/admin/release-tenant`) releases them after the grace period and a heads-up e-mail; see section 7. Call time is added once per conversation by the post-call webhook (a conversation whose
post-call never arrives is not metered).

**Legacy bookings** (made before follow-up consent was recorded) are never texted for gratitude; a customer's own `YES`/`SI`/`START`
to the business number opts them in. `POST /api/gratitude/run` reports `skipped_no_consent` and the other skip reasons.

**Live transcript, metering reconciliation, cap warnings, language detection (checks)**

- *Live transcript.* The page `Calls > <call>` (also "Live now" on Today) streams `GET /api/calls/:id/live` (SSE) and falls back to `GET /api/calls/:id/transcript?after=`. One shared upstream poll of `GET /v1/convai/conversations/{id}` serves every viewer (lease, about every 2 s). UNVERIFIED: whether ElevenLabs fills `transcript` while the conversation is `in-progress`. **Live test:** call the number, open the call page while you talk: your words and the assistant's should appear within a few seconds. If nothing appears, `curl` the conversation endpoint with your key during a call and look at `transcript`; if it is empty until the call ends, the live view cannot work on your plan with polling (a monitoring-websocket source would be needed). Say "I don't want to be recorded" on a test call: the lines must disappear from the page, and the call shows no transcript afterwards. Behind a reverse proxy the stream needs buffering off (the app sends `X-Accel-Buffering: no`); compose's default does not buffer.
- *Metering reconciliation.* `GET /api/admin/jobs` lists job `reconcile`. Test: temporarily point the post-call webhook elsewhere (or block it), make a 1-minute call, wait `RECONCILE_AFTER_MINUTES`; usage must grow by about the call length once, and a later webhook delivery must not add it again. A call that cannot be fetched is retried with backoff and finally logged as `reconcile_gave_up` with an audit row.
- *Cap warnings.* At 80% and 100% of the SMS / AI-minute / forward-minute cap the owner gets one email and, with a verified phone outside quiet hours (9pm-8am local), one text, once per kind per month. They show in the billing banner and `usageWarningsFor(businessId)` (billing status API `usage_warnings` field; there is no `warnings` alias). Test: set `sms_cap_override` of a test business to 10 and send 8 texts. The `usage_warnings` safety-net job visits only businesses whose usage counter changed since its previous pass (plus those with a deferred / failed warning, kept on a durable retry list) and sweeps every live business on the first pass and then daily; the job report says `full_sweep` and `visited`.
- *Stuck money and metering after a failed write.* (a) A refund `pending` for hours: the owner's "Check with Stripe" button (`POST /api/bookings/:id/refund/check`) and the `reconcile` job resolve it against Stripe (docs/refunds.md); the job report counts `refunds_stuck` / `refunds_resolved`. (b) Forward seconds of a transferred call whose write failed after the AI part was recorded (`calls.forward_pending_secs` > 0, log `usage.forward_part_failed`): the `reconcile` job writes them (`forwards_pending` / `forwards_settled` / `forwards_failed` in its report); it is deduplicated per call sid, so it cannot double-count. (c) Events a Google account switch could not delete: the owner's Google card lists them (`calendar_orphaned_events`) until dismissed.
- *Language detection.* Provisioning adds the `language_detection` system tool and a Spanish preset (`LANGUAGE_DETECTION=off` removes both). Check in the agent's System tools tab; call and switch to Spanish mid-call: the assistant should follow, and `calls.language` becomes `es` or `mixed` after the post-call. If the provider rejects the language fields, provisioning retries once without them and logs `agent.language_fields_rejected`.

## 7. Releasing canceled tenants (provider cleanup)

Canceled/unpaid tenants keep paying us rent for a Twilio number and an ElevenLabs agent until they are released. Run daily (cron on the host, through the tools container):

```sh
# 0. (admin job, no shell) POST /api/admin/jobs/run {"job":"tenant_release"} is the same dry run; the newest report is in GET /api/admin/jobs (diagnostics.tenant_release).
#    TENANT_RELEASE_JOB=report stores that report daily; =on makes the daily job (and --apply below) act.
# 1. DRY RUN: prints SKIP / WAIT / NOTIFY / RELEASE per canceled business, touches nothing
docker compose -f compose.production.yaml --profile seed run --rm seed bun scripts/release-canceled-tenants.ts --force-i-know
# 2. act (needs TENANT_RELEASE_JOB=on in the environment): sends due heads-up mails, releases what is due (exit code 1 when a provider call failed: it is retried next run)
docker compose -f compose.production.yaml --profile seed run --rm seed bun scripts/release-canceled-tenants.ts --force-i-know --apply
```

Defaults: 30 days of grace after the paid period ends, heads-up e-mail 7 days before (`--grace-days`, `--notify-days`), businesses with calls in the last 7 days are skipped (`--include-recent`).
Check before the first `--apply`: `EMAIL_PROVIDER` works (the heads-up needs it), the dry-run list contains only tenants you expect, and the Twilio/ElevenLabs credentials are those of the production
account. Never released: comped plans, a number shared with another business or held by ANY other business row (`releaseNumber` checks the database itself), `TWILIO_PHONE_NUMBER` (compared as E.164). "Recent calls" counts only calls that were really handled: calls refused at the gate (`out_of_service:*`), hang-ups under 15 s and calls with no transcript, summary or booking are ignored, so a robocall a week no longer keeps a canceled tenant for ever. Each business is processed under the same lease as provisioning (`provision:<id>`): a release never overlaps a provision call or another release, and the facts are re-read under the lease, so a reactivation that landed after the dry run is honoured. With incomplete Twilio/ElevenLabs credentials a release FAILS (the database reference is kept, the error says which variable) instead of reporting a mock success. One business: `POST /api/admin/release-tenant` (`dry_run` defaults to true). Details and rules: docs/billing.md.
After a release the owner can resubscribe; re-provisioning (`POST /api/businesses/:id/provision`) buys a NEW number. The ElevenLabs phone-number detach/unassign call shape is UNVERIFIED (like the rest of the phone binding):
after the first real release check in the ElevenLabs dashboard that the agent is gone and the shared number is not assigned to a deleted agent. Twilio: confirm the number disappeared from Phone Numbers > Active numbers.

## 8. Call handling: pause and forward

Each business has a call handling mode (Today page pill, Settings > Call handling; owner only). It is the only place a call's fate is decided, so first know which kind of line a number is.

**Which numbers / lines support which modes**

| Line | How it is set up | `ai` | `paused` | `forward` |
| --- | --- | --- | --- | --- |
| **Native AI voice line** (the documented production setup, `VOICE_LINE_KIND=native`, the default once `ELEVENLABS_API_KEY` is set) | EACH tenant's purchased number is imported into ElevenLabs by provisioning (`POST /v1/convai/phone-numbers`) and bound to that tenant's agent, which owns its Voice URL and answers first; our app sees only the conversation-initiation webhook `POST /api/voice/initiation` (JSON) and the tool webhooks | the AI answers | first message replaced by the paused script (AI/recording notice first), call capped at 60 s, the agent only takes a message (`handoff_to_human`); every other tool is refused server-side (no booking, texts, payment links, quotes); the verified owner phone gets one rate-limited "MISSED CALL" text | **`NATIVE_TRANSFER=off` (default): not available**: the app can never dial from here. With `NATIVE_TRANSFER=on` AND the business's own opt-in (Settings > Receptionist and phone line) the agent TRANSFERS the call to the verified number (see "Live transfer test" below). When off, the dashboard says "Forwarding is not available on the AI voice line - callers will hear the paused message", the Forward button is disabled and `PATCH call-mode {mode:'forward'}` answers 422. A business that already had `forward` stored behaves as `paused`. Use the carrier's own call forwarding instead |
| **Webhook line** (`VOICE_LINE_KIND=webhook`, also what dev/test/demo use) | The Twilio number's Voice URL is `https://<APP_URL>/api/voice/incoming` (HTTP POST) | TwiML: the provider's register-call TwiML connects the call to the agent when `ELEVENLABS_API_KEY` is set and `ELEVENLABS_REGISTER_CALL` is not `off` (UNVERIFIED shape); otherwise the honest voicemail below. JSON only for the unsigned demo UI | TwiML: the caller hears that the assistant is off and that a message **will be recorded**, then a voicemail `<Record>`; call row `handed_off`; owner text as above | TwiML `<Dial>` to the **verified, still-allowed** number (never recorded, capped to the plan minutes left, metered, no answer -> voicemail via `/api/voice/voicemail`) |

`/api/voice/incoming` roles, explicitly: a **signed form POST from Twilio** ALWAYS gets **TwiML** (N8): `paused` and `forward` as before (a refused forward: voicemail), the out-of-service line (`<Say>` + hangup), no business for the number (`<Say>` + hangup), the owner line (register-call TwiML, else "the owner line is not available on this phone line"), and `ai` (register-call TwiML from ElevenLabs when it works, else the honest voicemail: the call row is `handed_off`, `flagged_reason` says the AI could not be connected, the owner gets a missed-call text); the AI conversation proper is the native line (the number imported into ElevenLabs); a **JSON POST** (demo UI, `ALLOW_INSECURE_DEV` only) always gets JSON. Verified against the ElevenLabs docs: the transfer-to-number system tool's destination "can be typed directly or as a dynamic variable" (`transfer_rules` > `provider_configs` > `transfer_destination.destination` = `{{transfer_destination}}`). The initiation webhook fills that variable PER CALL (only the verified, re-vetted number; empty otherwise), which is how native forwarding is implemented behind `NATIVE_TRANSFER` (default off until the live test below passes).

* `forward_during_hours`: forward only inside the business opening hours (business zone); after hours the AI answers. The same decision (`resolveCallRoute`) drives the greeting, the voice tools and the dashboard, so they cannot disagree.
* **Forward number rules (`validateForwardNumber`)**, applied when it is saved, when the verified owner phone is adopted, by `setCallMode`, and **again before every `<Dial>`**: E.164, `FORWARD_ALLOWED_COUNTRY_CODES`, not premium / shared-cost / personal / toll-free (libphonenumber type), not N11 / non-geographic, not the Caribbean, 670/671/684, an exchange `976` or any `FORWARD_DENY_AREA_CODES`, not any assistant number (this business, another tenant, `TWILIO_PHONE_NUMBER`). It must then be verified by a 6-digit SMS code or be the verified owner phone. A number that fails any rule later is never dialled: the caller gets the voicemail and the call is flagged "Forwarding was refused".
* **Minutes** (round 6): forwarded seconds are metered from the signed Twilio callbacks (`<Dial action>` -> `/api/voice/voicemail`, `<Number statusCallback>` -> `/api/voice/dial-status`; once per call) into their OWN counter `forward_seconds` (cap `FORWARD_MINUTES_CAP`), voicemail seconds into `voicemail_seconds` (cap `VOICEMAIL_MINUTES_CAP`); neither touches the AI minutes (docs/billing.md). `<Dial timeLimit>` is the forward minutes still left minus what live forwards reserved (at most `FORWARD_MAX_CALL_SECONDS`); a used-up cap, a trial cap, a lapsed plan or `FORWARD_MAX_CONCURRENT` live forwards means no forward (voicemail / out of service). A failing allowance check fails closed (no forward).
* **Who is spending the budget** (round 6 H1, `src/lib/voice/caller-limits.ts`): every call that would dial the owner or take a voicemail is charged, in order, to (1) the CALLER's own hourly budget (`FORWARD_PER_CALLER_PER_HOUR` 3, `VOICEMAIL_PER_CALLER_PER_HOUR` 2; callers withholding their number share one stricter bucket, 5 and 3; keys hold a hash of the number, not the number), (2) for callers that are not known customers, the stranger share (`CALLER_UNKNOWN_SHARE_PCT`, 75%) of (3) the business budget (`FORWARD_CALLS_PER_HOUR`, `VOICEMAIL_PER_HOUR`, 60 each). A caller over their own limit gets the voicemail path (forward) or "try again later" (voicemail) and does not touch the business budget or text the owner; the call row says "Not taken: too many calls from this number". Known customers (a booking, or an answered AI call of at least 15 s, in the last 90 days; forwards and voicemails never count) keep the other 25% of the budget, one forward slot and their own missed-call text budget, so an anonymous flood degrades service for strangers only. Each CallSid is charged once (`claimEvent`): a Twilio retry or the Dial-action of the same call re-reads the budgets without spending them. A caller who hangs up while it rings (`DialCallStatus=canceled`) costs no voicemail and gets no recording prompt. Spoofed caller ids: a flood from many different (spoofed) numbers is bounded by the stranger share and the hourly business budget, not by the per-caller limit; a spoofed KNOWN number can use the reserved share (the same trust the missed-call text already has).
* **Call flood playbook**: when a business passes 80% of its hourly budget there is an error log line `call_budget_pressure` (business, kind, used_pct) and ONE text to the verified owner phone per hour and kind ("HEADS UP ... unusually many ..."). To act: look at Calls (flagged "Not taken"), switch the business to `paused` (the voicemail has its own per-caller limits) or lower `CALLER_UNKNOWN_SHARE_PCT` / the per-caller limits and redeploy; the numbers can be blocked at Twilio (Voice > Block). Carrier voicemail answering the forwarded leg: the owner's phone rings `FORWARD_RING_SECONDS` (20 s, under most carriers' ~25 s pickup), a leg that completes in under `FORWARD_MIN_ANSWERED_SECONDS` (6 s) or reports `AnsweredBy=machine*` counts as unanswered and the caller is offered our voicemail; a SILENT caller who stays on a carrier voicemail for longer still uses forward minutes (their own cap, `FORWARD_MAX_CALL_SECONDS`, the per-caller limit and the concurrency cap bound it; Twilio call screening with `<Number url>` is the stronger defence and is not implemented, see docs/known-limitations.md).
* **Line kind mismatch** (round 6 L5): `VOICE_LINE_KIND=webhook` together with `ELEVENLABS_API_KEY` + `ELEVENLABS_PHONE_NUMBER_ID` is a contradiction (ElevenLabs answers that number and can never forward): the app treats the line as `native`, logs `line_kind_mismatch` at boot, shows it in `GET /api/admin/jobs` (`diagnostics.voice_line.mismatch`) and deploy.sh warns.
* **Who may change it**: owners. Switching INTO paused/forward, changing `forward_during_hours` and setting a forwarding number need a fresh proof of identity (password, the 2FA code for an account with 2FA, or the admin token for the break-glass admin cookie session, within 5 minutes; docs/auth.md). Every mode transition (including the implicit one when a new number drops forward back to AI) is audited as `business.call_mode_changed` with a `reason`, and every change of mode or number emails all owners and texts the verified owner phone (6 per hour per business and channel).
* **Voicemails**: Calls > Voicemails lists them (caller, time, length, call back). Audio plays through `GET /api/calls/:id/voicemail`, an authenticated tenant-scoped proxy that streams the Twilio recording with the account credentials; no Twilio URL reaches a browser or `/api/calls`. They are deleted (database row and the Twilio recording) by the retention purge after the business's `retention_days` and by customer erasure. **Provider-side deletion is durable** (round 6 M2): in the SAME transaction that deletes the call rows, the recording SIDs are written to `pending_recording_deletions`; the jobs runner (job `recording_deletions`, every tick, also while `RETENTION_JOB` is off) calls Twilio's DELETE for each, removes the row only on 2xx or 404, and otherwise retries with backoff (1 min, doubling, 6 h max). After 5 failed attempts one alert fires per recording: error log `recording_deletion_stuck` and an audit row `recordings.deletion_stuck`; `GET /api/admin/jobs` shows the queue (`diagnostics.recording_deletions`: pending, stuck, oldest) and the job note. The usual cause of a stuck row is `TWILIO_ACCOUNT_SID` no longer matching the account that owns the recording (sub-account move or rotation): restore the right credentials and it drains by itself; `last_error` says `no matching Twilio credentials` / `http_<status>`. The erasure answer carries `recordings_pending` and `recording_deletion: 'pending'` until Twilio confirms, and the access export has `recording_deletions_pending`. **ElevenLabs conversations (call audio + transcript) use the same queue** (`provider = 'elevenlabs'`, review 14): the `conversation_id` of every erased / purged call is queued in the same transaction (only with `ELEVENLABS_API_KEY` set) and the runner calls `DELETE /v1/convai/conversations/{id}`; a stuck row there usually means a rotated or under-scoped `ELEVENLABS_API_KEY` (`last_error` `http_401` / `http_403` / `no ELEVENLABS_API_KEY`). The playback proxy is limited to 40 requests per person and 120 per business per minute (a seek is a request) and keeps a complete recording in memory for 45 s so seeks cost one Twilio call; the entry is dropped the moment the recording is queued for deletion. Needs `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` of the account that holds the recordings. Twilio setup for the callbacks: nothing extra (they are relative to the incoming URL and signed); keep Twilio's media "HTTP basic auth" setting enabled.
* A lapsed plan still wins (out-of-service message).

### Per-tenant AI line (native line): import, repair, release

* **Provisioning** (`POST /api/businesses/:id/provision`) first REFUSES to buy anything when `ELEVENLABS_API_KEY` is missing in production (or whenever real Twilio credentials are configured): 503 `voice_provider_not_configured`, business stays `onboarding`, audited `provision.voice_not_configured`, nothing bought. After the agent exists it imports the purchased number (`src/lib/voice/tenant-line.ts`: `POST /v1/convai/phone-numbers` {provider twilio, phone_number, label, sid, token, supports_inbound}; the Twilio account sid and token go to ElevenLabs only in that body), stores `businesses.elevenlabs_phone_number_id` and binds the tenant's agent (`PATCH /v1/convai/phone-numbers/{id}` {agent_id}). A mock agent in production, or an import/bind failure, is a 502 (`agent_registration_failed` / `voice_line_failed`, stage `agent` / `line`): the number is kept, the business stays `onboarding`, a retry resumes (an existing import of the same E.164 is ADOPTED, never imported twice; an id another business owns is never adopted). The Twilio SMS URL is kept ours, the Voice URL of an imported line is never written (ElevenLabs sets it).
* **Repair of existing numbers**: `POST /api/admin/repair-numbers` also reports each business's line (`items[].line.outcome`: `would_import` / `would_bind` in the DRY RUN, which is the default and calls the provider read-only; `imported`, `adopted`, `bound`, `ok`, `skipped` with the reason, `failed`). Loop on `next_cursor`. Needs `ELEVENLABS_API_KEY` and the Twilio credentials; on a forced `VOICE_LINE_KIND=webhook` deployment it skips the import.
* **Release** (`/api/admin/release-tenant`, `scripts/release-canceled-tenants.ts`): the tenant's imported number is detached and deleted BEFORE the agent and the Twilio number; if that fails the Twilio number is kept this round and the error is listed (retry finishes). Never the shared `ELEVENLABS_PHONE_NUMBER_ID`, never another business's line. Audited `line.released`.
* **Unverified provider shapes** (one file: `src/lib/voice/elevenlabs-phone.ts`): the import body, the list/get/patch/delete of phone numbers, the register-call TwiML, and whether the import also sets the number's Twilio Voice URL itself. First live check: provision a test tenant, read the number in the ElevenLabs console (it must show the tenant's agent), call it, and look at the number in the Twilio console (Voice URL = ElevenLabs, SMS URL = `/api/sms/inbound`).
* **Settings > Receptionist and phone line** (owner only; `PATCH /api/businesses/:id/line`): the receptionist's name (`assistant_name`, default "Maria") is used in the prompt, the opening message and the owner prompt; the live-transfer switch (`native_transfer_enabled`, needs `NATIVE_TRANSFER=on` and a recent login proof to turn ON). Both push the live agent now (a failure is queued and reported as `agent_sync`). Tool honesty: `handoff_to_human` TEXTS the owner and offers a callback (it does not connect the call); `transfer_to_human` (only for a business that opted in) is the one that connects.

### Call screening (webhook line forward leg)

The forwarded `<Number>` carries `url="/api/voice/screen"`. When the owner answers, Twilio runs the whisper on THEIR leg before bridging: "<business> call from <digits>. Press 1 to accept." Pressing 1 bridges; any other key or no input hangs up that leg only, the `<Dial>` ends unanswered and the caller gets the recording notice and voicemail. A carrier voicemail cannot press 1, so it is never bridged. Metering counts only bridged seconds (leg duration minus the measured whisper; 0 when not accepted). **Live test (webhook line, 10 minutes):** (1) forward mode on, call the number from a second phone; answer the owner phone: you hear the whisper naming the business and the caller's number; press 1: you are bridged; hang up; Calls shows the call and forwarded minutes grew by about the talk time. (2) Call again, answer and press 2 (or just wait): the caller hears the voicemail prompt; no forward minutes were added. (3) Call again and let it go to the owner's carrier voicemail: the caller must NOT be bridged to it (they hear our voicemail prompt). (4) Check `Voice > Calls` in Twilio shows the `/api/voice/screen` requests signed OK. If the minutes after (1) exceed the talk time by the whisper length, `DialCallDuration` includes the whisper: tell the operator; the app already subtracts the measured whisper.

### Live transfer test (native line, `NATIVE_TRANSFER`)

UNVERIFIED provider behaviour, so the switch is OFF by default. Run this in a staging number / owner-only first, then turn it on:
1. Set `NATIVE_TRANSFER=on` (and `ELEVENLABS_TOOL_SECRET`), redeploy, re-provision the agent (Settings > Re-sync the assistant). `bun run verify:deploy` must show the "Transfer config" check PASS. In ElevenLabs open the agent: the System tools tab must list **Transfer to number** with a rule whose destination reads `{{transfer_destination}}`, and **Language detection**. If the rule is missing or the destination is not accepted, the PATCH was rejected: look for `agent.update_failed` in the logs and stop.
2. Set a forward number you control, verify it by SMS, call mode `ai`. Call the business number and ask for a person: the assistant must say it is connecting you ONLY after the tool answered, your phone rings, and you can talk. After the call: Calls shows `Transfer connected`; if it shows `attempted`, the post-call transcript did not contain a `transfer_to_number` result (the outcome shape is UNVERIFIED): note it, the transfer itself may still have worked.
3. Mode `forward`: the call must transfer immediately after the disclosure (it says "connecting you").
4. Negative checks: an unverified number, `forward_during_hours` while closed, `FORWARD_MAX_CONCURRENT=1` with two simultaneous calls, and a caller over the per-caller limit must all end with the assistant taking a message (callback text to the owner) and no transfer.
5. Watch minutes: `forward_seconds` grows by the conversation duration at post-call; the talk time after the transfer is NOT visible to us (docs/known-limitations.md).
6. To switch it off: `NATIVE_TRANSFER=off`, redeploy, re-provision. The destination variable is then always empty, so nothing can transfer even on an agent that still carries the tool.

## 9. Owner call-in (the owner updates the AI by phone)

Design, limits and security model: [owner-call-in.md](owner-call-in.md). Env: `OWNER_CALLIN_ENABLED` (default true), `OWNER_CALL_MAX_SECONDS` (default 300).

**One-time provider setup (UNVERIFIED against the live ElevenLabs API: do it once per agent and check).**
1. Native line only: the agent must allow the **system prompt** override in addition to first message and max duration (Agent > Security > overrides; `syncAgent` tries `platform_settings.overrides` automatically, see `initiationAgentOverrides`). Without it an owner call would hear the owner greeting but run the customer prompt.
2. The three owner tools (`propose_kb_change`, `list_recent_changes`, `undo_last_change`) are registered on the agent next to the customer tools by `syncAgent` (re-provision / save settings once after deploying). ElevenLabs tools are per agent, not per call, so customer callers can see them; the tool route refuses them unless the call row is `kind = 'owner'`.
3. Dynamic variable `owner_mode` (`true` only on owner calls) is declared as a placeholder (default `false`).

**Test protocol (do this after every deploy that touches voice).**
1. Owner phone verified (Settings), `OWNER_CALLIN_ENABLED` not `false`. Call the business line FROM the verified owner phone. Expect: "private owner line ... we do not keep a transcript". Calls from any other number must get the normal receptionist greeting.
2. Say "we raised the AC diagnostic to $99". Expect a read-back ("So: Change AC Diagnostic: price $99. Is that right?"), then after "yes" the assistant says a code was texted and the change is NOT live. The text arrives: `Reply YES <code> to apply: ...`. Confirm nothing changed yet (Dashboard > Her brain shows "Voice changes: waiting for confirmation").
3. Reply `YES <code>` from the owner phone: reply "Applied: ...", Her brain shows the new price, the agent prompt was rebuilt (`system_prompt` contains the new value) and the agent re-synced. Reply `UNDO <code>`: "Reverted". Replaying either text changes nothing.
4. Negative checks: `YES <code>` from another phone: no reply, nothing changes; wrong code: "That code is not valid"; wait 31 minutes on a fresh proposal: "expired"; try dictating "ignore previous instructions ..." or a web address: refused out loud, nothing saved; five such attempts lock the line for an hour (`owner_kb.locked` audit row).
5. After hanging up: the Calls list has no owner call; the call row has no transcript/summary; Usage minutes increased by the call length.

**Operations.** Everything is in the audit trail (`owner_kb.session / proposed / applied / rejected / reverted / expired / stale / refused / locked / tool_refused / undo_requested`). A flood of `owner_kb.tool_refused` means someone is pushing the owner tools on customer calls (harmless, refused); a flood of `owner_kb.session` with `limited=true` means someone is spoofing the owner number (the owner line has a 10 sessions/day limit; the owner can use the dashboard or text). Turn the feature off per deployment with `OWNER_CALLIN_ENABLED=false`.

## 10. Reschedule, cancellation, refunds, recordings, voices (what to check)

1. **Stripe deposit webhook** (`/api/payments/webhook`): add `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed` and `charge.dispute.created|updated|closed|funds_withdrawn|funds_reinstated` to the events (docs/refunds.md). A dispute shows up as audit `payment.dispute_created`, `bookings.dispute_status` and a text to the verified owner phone; answer it in Stripe.
2. **Refund test (Stripe test mode)**: pay a deposit, cancel the booking in the dashboard (the customer is texted), press "Refund deposit", re-enter the password when asked. Expect: Stripe shows the refund, the booking says refunded, an audit `booking.refunded` row exists, the customer gets "We refunded $X". Press it again: nothing new. A refund stuck in `pending` means Stripe did not answer: press it again later (same idempotency key) or wait for `refund.updated`.
3. **Reschedule test**: Calendar > a booking > Reschedule > pick a free time. Expect an audit `booking.rescheduled`, the new time on the calendar, and (outside 9 pm-8 am business time) a text to the customer. At night the panel says the text was held back: press "Text the customer about this change" in the morning.
4. **Voice tools**: after deploying, re-provision or save settings once so `reschedule_booking` and `cancel_booking` are registered on every agent. Test from the customer's own phone (move, then cancel) and from a different phone (the agent must refuse and offer a message).
5. **Recordings**: needs ElevenLabs audio saving and `ELEVENLABS_API_KEY`; the Calls page shows a player only for calls where the recording disclosure was given. A 404 in the player means the provider no longer has the audio. Each first listen is audited `call.recording_played`.
6. **Voices**: set `ELEVENLABS_VOICE_ALLOWLIST` to restrict the choices (otherwise the provider's premade voices are listed). A saved choice applies to the agent on the next sync (`synced:false` in the response means the provider refused the update: check the ElevenLabs key and retry from Settings).
7. **Readiness gate**: a non-admin provision with fewer than 3 priced services, no opening hours or no FAQ answers 422 `kb_incomplete`; an admin (or `force`) can still provision. The Brain page shows the same checklist.

## 11. Agent resync after a deploy, and the mock end-to-end run

**Resync every agent** (after a deploy that added or changed a voice tool, the prompt rules, the override flags or language/transfer settings). All agents are created and updated by ONE function, `syncAgent` (src/lib/voice/elevenlabs.ts): the full config (prompt, tool ids, system tools, language preset, voice, dynamic-variable placeholders `business_id`, `call_sid`, `caller_phone`, `transfer_mode`, `transfer_destination`, `owner_mode`, ...) plus the initiation webhook and override flags, with workspace tools created once by name + URL and refreshed in place. It is idempotent.
```
curl -sX POST $APP_URL/api/admin/resync-agents -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{}'                      # DRY RUN (default): lists the batch, no provider call
curl -sX POST ... -d '{"dry_run":false,"limit":10}'                                                                                                    # one batch; repeat with "cursor":"<next_cursor>" until next_cursor is null
curl -sX POST ... -d '{"dry_run":false,"business_ids":["<id>"]}'                                                                                       # a single business
```
Admin only, 6 requests/minute, batches of at most 25 (default 10), audited as `admin.resync_agents` (counts and ids). Each item says `synced | created | failed | mock`; a `failed` item is logged (`agent.update_failed`, `tool.register_failed`) and can simply be retried. `created` means the provider answered 404 for the stored agent id (the agent is really gone) and a new agent was made: only a 404 recreates (a 429, 5xx or rejected body is `failed` and creates nothing, so a retry cannot leave an orphan agent). The endpoint then binds the phone number and registers the post-call webhook on the new agent like provisioning does and the item's `detail` says so (`NEW agent created ...`; any step that failed is named: finish it by hand). Agents flagged after a failed sync (a business-type change) are retried by the `reconcile` job every tick with backoff (`processed_events` source `agent-dirty:<n>`); `agent.resync_gave_up` (audit + error log) after 8 failed attempts means run this endpoint for that business. Without `ELEVENLABS_API_KEY` a real run answers 503. Afterwards place one test call and one owner call (section 9).

**Mock end-to-end run** (no real providers): create a scratch database, `prisma migrate deploy`, then run `next dev` (NOT a production build: production refuses mock Google, mock checkout, the log email provider) with `DEMO_MODE=true EMAIL_PROVIDER=log GOOGLE_OAUTH_MOCK=true OWNER_CALLIN_ENABLED=true`, `ADMIN_TOKEN`, `APP_SECRET_KEY`, `TWILIO_AUTH_TOKEN`, `ELEVENLABS_TOOL_SECRET`, `ELEVENLABS_WEBHOOK_SECRET` and `STRIPE_PRICE_ID_ANNUAL`. Drive sign-up (the verification link is in the server log), onboarding, mock checkout (Monthly/Annual), Google connect (`POST /api/integrations/google/mock-event` adds an event "in Google"), customer calls through `/api/voice/initiation`, `/api/voice/tools/*` and `/api/voice/post-call` with the shared secrets, owner calls and signed `/api/sms/inbound` texts. Mock provisioning stores no agent id: set `businesses.agent_id` by hand to drive the tools.
