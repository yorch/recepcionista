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
   Must be absent or off: `ALLOW_INSECURE_DEV`, `DEMO_MODE`, `STRIPE_ALLOW_UNSIGNED`. Keep `RETENTION_JOB` unset
   until step 6. Set `TRUSTED_PROXY=true` only behind a proxy you control.
3. **Deploy** (`./deploy.sh`), then run `bun run verify:deploy` (section 3) before touching DNS/number routing.
4. **Re-provision every business** (`POST /api/businesses/:id/provision`, admin token) so each ElevenLabs agent gets
   the current first message (disclosure), prompt and tool definitions (the tool secret header is refreshed on
   existing tools). The first provision of a workspace returns the post-call webhook signing secret ONCE: store it
   as `ELEVENLABS_WEBHOOK_SECRET`, redeploy, re-run `verify:deploy`. Then do section 6 (initiation webhook, owner phones).
5. **Twilio inbound SMS URL.** Point the number's "A message comes in" webhook (HTTP POST) at
   `https://<APP_URL>/api/sms/inbound`. A number has one inbound URL; STOP/START/HELP and gratitude replies all go
   through it. The voice side is the ElevenLabs native Twilio integration (the number is imported into
   ElevenLabs, which owns the Voice URL), not `/api/voice/incoming`.
6. **Retention.** `POST /api/admin/retention {"dry_run": true}` and review what would be purged per business
   (default window is 365 days). Adjust each business's `retention_days` in Dashboard > Settings, then set
   `RETENTION_JOB=on` and redeploy. The boot log states whether the job is enabled.
7. **Create the first owner:** `CREATE_USER_PASSWORD=... bun scripts/create-user.ts --email owner@x.com --role owner --business <id>`
   (and a global admin with `--role admin`). Log in at `/login`.
8. **Provider-side settings** (section 5): retention / zero-retention in ElevenLabs, Twilio recording off.

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
"Twilio personalization" docs; those docs configure it only in the UI. Provisioning (`createOrUpdateAgent`, and the
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
1 per 10 minutes and 6 per hour per business. A business that stays canceled keeps its number and agent until an operator releases them. Call time is added once per conversation by the post-call webhook (a conversation whose
post-call never arrives is not metered).

**Legacy bookings** (made before follow-up consent was recorded) are never texted for gratitude; a customer's own `YES`/`SI`/`START`
to the business number opts them in. `POST /api/gratitude/run` reports `skipped_no_consent` and the other skip reasons.
