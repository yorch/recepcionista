# Environment variables

Every variable the app, the scripts and the deploy tooling read (found with `grep process.env src scripts next.config.ts`).
`.env.example` is the template, `compose.production.yaml` passes the whole `.env` to the app (`env_file`), and `deploy.sh`
refuses to deploy when a "prod: required" variable is missing or inconsistent.

Legend. **Required**: `prod` = needed for a production deploy (deploy.sh enforces it unless noted), `cond` = needed only with the
feature named, `no` = optional. **Secret**: yes = never commit, log or share. Variables prefixed `NEXT_PUBLIC_` are inlined into the
bundle at **build** time (compose passes them as build args), so they must be public values and a change needs a rebuild (`./deploy.sh`).

## Core, auth and networking

| Name | Required | Default | Feature | Secret |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | prod (compose builds it from `POSTGRES_*`, or use `DATABASE_URL_OVERRIDE`) | none | Postgres (Prisma) | yes |
| `DATABASE_URL_OVERRIDE` | no | none | compose only: managed Postgres instead of the bundled one | yes |
| `POSTGRES_USER`, `POSTGRES_DB` | prod (bundled db) | none | compose `db` service | no |
| `POSTGRES_PASSWORD` | prod (bundled db) | none | compose `db` service | yes |
| `DOMAIN` | prod | none | compose / Traefik host rule and certificate; deploy.sh checks `APP_URL == https://DOMAIN` | no |
| `TRAEFIK_NAME` | no | `recepcionista` | Traefik router name (unique per host) | no |
| `APP_IMAGE`, `TOOLS_IMAGE` | no | local build tags | compose image names | no |
| `APP_URL` | prod | `http://localhost:3000` | public origin: provider callbacks, Stripe return URLs, same-origin check, email links, sitemap | no |
| `PUBLIC_BASE_URL` | no | `APP_URL` | overrides the origin used for links and Twilio signature URLs | no |
| `NEXT_PUBLIC_APP_URL` | no | none | last-resort origin fallback (Stripe deposit links, Twilio) | no |
| `ADMIN_TOKEN` | prod | none | break-glass admin: Bearer token and `/login` admin sign-in. Unset = the app fails closed (503) | yes |
| `ALLOW_INSECURE_DEV` | never in prod | unset | local dev: skip admin auth and webhook checks (ignored in production; deploy.sh refuses `true`) | no |
| `TRUSTED_PROXY` | prod (compose sets `true`) | unset (compose: `true`) | trust `X-Forwarded-For` for per-client rate limits and the same-origin check | no |
| `TRUSTED_PROXY_HOPS` | no | `1` | proxies appending to `X-Forwarded-For` (2 behind a CDN plus Traefik) | no |
| `APP_SECRET_KEY` | prod | insecure fixed key outside production | AES-256-GCM key for TOTP secrets: 32 random bytes, base64 (`openssl rand -base64 32`). deploy.sh validates the length | yes |
| `REQUIRE_2FA_FOR_ADMINS` | no | `false` | DB admin users must enrol in 2FA first | no |
| `ALLOWED_DEV_ORIGINS` | no | none | `next dev` behind a tunnel (dev only) | no |
| `DEMO_MODE` | never in prod | unset | `/api/demo/*`, `/api/pay/mock-complete`, mock Stripe checkout (`/api/billing/mock-activate`). compose forces `false`; deploy.sh refuses `true` | no |
| `CSP_REPORT_ONLY` | no | unset | `true`: enforce the moderate CSP and only report violations of the strict nonce policy (docs/security-headers.md) | no |
| `CSP_UPGRADE_INSECURE` | no | unset = automatic: on only in production with an `https://` `APP_URL`/`PUBLIC_BASE_URL` | `true`/`false` forces `upgrade-insecure-requests` (turn it off for a plain-HTTP staging deployment; docs/security-headers.md) | no |
| `CSP_REPORT_URI` | no | none | adds `report-uri` to the CSP (a collector URL you operate) | no |
| `LOG_LEVEL` | no | `debug` (dev), `info` (prod) | log verbosity | no |
| `PRISMA_LOG` | no | unset | `1` logs every query | no |
| `RETENTION_JOB` | no | off | exactly `on` enables the automatic PII purge (docs/compliance.md); it is driven by the job runner below | no |
| `JOBS` | no | `on` in production, `off` in development and test | `on`/`off` (also `true`/`false`, `1`/`0`, `yes`/`no`, any case): the background job runner (6 PM daily briefing per business time zone, hourly gratitude sweep, hourly cleanup of expired sessions/tokens/events/rate-limit rows; the retention purge when `RETENTION_JOB=on`). `off` disables ALL of them, the retention purge included. deploy.sh accepts the same values as the app, refuses anything else and warns on an off value. Unset in development still lets `RETENTION_JOB=on` run on its own | no |
| `JOBS_TICK_SECONDS` | no | `60` | seconds between scheduler passes (clamped to 5-3600). Work is claimed per business in Postgres, so any tick rate and any number of app instances are safe | no |
| `NODE_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE` | set by Next / the image | | runtime mode flags; never set by hand | no |

## Accounts, signup and email

| Name | Required | Default | Feature | Secret |
| --- | --- | --- | --- | --- |
| `EMAIL_PROVIDER` | prod (`resend` or `smtp`; `log` is refused) | `log` outside production | verification, password reset, invite and billing emails. deploy.sh enforces it | no |
| `EMAIL_FROM` | prod | none | From address, e.g. `Recepcionista <no-reply@domain>` | no |
| `RESEND_API_KEY` | cond (`EMAIL_PROVIDER=resend`) | none | Resend | yes |
| `SMTP_URL` | cond (`smtp`, or the parts below) | none | SMTP as one URL | yes |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_SECURE` | cond (`smtp` without `SMTP_URL`) | port `587`, secure `false` | SMTP parts | no |
| `SMTP_PASS` | cond (`smtp` without `SMTP_URL`) | none | SMTP password | yes |
| `SIGNUP_MAX_PER_HOUR` | no | `60` | platform-wide cap on accounts CREATED per hour (existing-address/honeypot requests do not count). One client may use 20% (50% for the shared `untrusted` key); at 70% signup degrades (one account per client, Turnstile mandatory when configured, warning logged); only at 100% signup stops for everyone (`signup.global_cap_reached` error log) | no |
| `TURNSTILE_SECRET_KEY` | prod (with the site key) unless `SIGNUP_ALLOW_WITHOUT_CAPTCHA=true` | off | Cloudflare Turnstile on signup; server verification fails closed and is demanded ONLY when the site key is set too (no widget without it, so a secret left over next to `SIGNUP_ALLOW_WITHOUT_CAPTCHA=true` no longer makes every signup fail `captcha_failed`). Needs the site key too (deploy.sh checks the pair). In production, open signup is REFUSED (503 `signup_disabled`, `/signup` invite-only) without the pair or the opt-out below | yes |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | prod (with the secret) | none | Turnstile widget (build time) | no |
| `SIGNUP_ALLOW_WITHOUT_CAPTCHA` | no | unset | exactly `true` lets production run open signup with no captcha (startup logs a loud warning, deploy.sh prints a banner). NOT recommended; without it and without the Turnstile pair deploy.sh fails | no |
| `NEXT_PUBLIC_PLAN_PRICE_DISPLAY` | no | "Simple monthly pricing, with a free trial" | price text on the plan step (build time) | no |
| `CREATE_USER_PASSWORD` | no | none | `scripts/create-user.ts` non-interactive password (the script refuses `--password`) | yes |

## Billing and plan limits (docs/billing.md)

| Name | Required | Default | Feature | Secret |
| --- | --- | --- | --- | --- |
| `BILLING_ENFORCED` | prod: yes (`true` or `false`) | production: enforced unless exactly `false` (FAIL CLOSED); dev/test: off unless `true` | refuses provisioning, texts and calls for businesses without an active plan. deploy.sh and compose.production.yaml refuse an unset/invalid value and banner `false`; non-admin provisioning always needs a plan in production. Comp existing tenants first (`scripts/grandfather-existing.ts --before <iso>`) | no |
| `STRIPE_SECRET_KEY` | cond (`BILLING_ENFORCED=true`, deposits) | unset: mock checkout and mock deposit links (not in production) | Stripe API: subscriptions and deposit payment links | yes |
| `STRIPE_PRICE_ID` | cond (`BILLING_ENFORCED=true`) | none | recurring monthly price | no |
| `STRIPE_BILLING_WEBHOOK_SECRET` | cond (`BILLING_ENFORCED=true`) | none | signs `/api/billing/webhook` (a different secret from the deposit webhook) | yes |
| `STRIPE_WEBHOOK_SECRET` | prod | none | signs `/api/payments/webhook` (deposits) | yes |
| `STRIPE_ALLOW_UNSIGNED` | never in prod | unset | dev: accept unsigned deposit webhooks (also needs `ALLOW_INSECURE_DEV`) | no |
| `BILLING_TRIAL_DAYS` | no | `7` | free-trial length, 0-90 | no |
| `BILLING_PLAN_NAME` | no | `standard` | plan label stored on subscribed businesses | no |
| `BILLING_ALLOW_PROMO_CODES` | no | off | `true` shows the promotion-code box in Checkout | no |
| `BILLING_PAST_DUE_GRACE_DAYS` | no | `5` | days a past_due business keeps working | no |
| `PLAN_SMS_CAP` | no | `500` | monthly SMS SEGMENTS per business (a text is metered as its real segment count: GSM-7 160/153, UCS-2 70/67; a text that would not fit in what is left is blocked). Per-business overrides win | no |
| `PLAN_CALL_MINUTES_CAP` | no | `300` | monthly call minutes per business | no |
| `OWNER_ALERT_HOURLY_LIMIT` | no | `6` | owner texts a CALLER can trigger (`flag_emergency`, `handoff_to_human`) per business per hour, counted in a budget SEPARATE from the plan SMS cap (those alerts are exempt from the cap). Identical alerts for one call are sent once. The FIRST emergency of a call is never starved by a spent budget, up to a hard ceiling of 2x this number per hour; the rest answer honestly that the owner could not be reached. Alert text is cut to 320 GSM-safe characters. Whole number >= 1 (deploy.sh checks) | no |
| `TRIAL_SMS_CAP` | no | `50` | monthly SMS segments while `billing_status='trialing'` (never above `PLAN_SMS_CAP`; per-business overrides win). Applies only while billing is enforced | no |
| `TRIAL_CALL_MINUTES_CAP` | no | `30` | monthly call minutes while `billing_status='trialing'` (never above `PLAN_CALL_MINUTES_CAP`; overrides win) | no |

## Voice, SMS, phone numbers and LLM

| Name | Required | Default | Feature | Secret |
| --- | --- | --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | prod (real SMS and numbers) | unset: SMS is logged and numbers are mock-pool numbers, outside production only | Twilio. In production, or whenever Twilio is configured, a failed number purchase FAILS provisioning (502, or 503 `phone_provider_not_configured` without credentials): a fake number is never issued | no |
| `TWILIO_AUTH_TOKEN` | cond (with the SID; also verifies Twilio webhooks) | none | Twilio | yes |
| `TWILIO_PHONE_NUMBER` | cond | none | SMS sender number. The platform's own line: never bought for, adopted by or released from a tenant (compared as E.164, so `+1 305 ...` and `1305...` match; an unparseable value makes releases refuse). Releases also refuse when it is set but SID/token are missing | no |
| `TWILIO_AREA_CODE` | no | `305` | default US/Canada area code for newly bought tenant numbers (3 digits, first 2-9; an invalid value falls back to 305; deploy.sh rejects it). A business is bought a number in the area code of ITS OWN owner phone when that is a valid US/Canada code, so this only applies to tenants without one | no |
| `SMS_ALLOWED_COUNTRY_CODES` | no | `1` | destination countries for outbound texts. Also applied to `owner_phone` (PATCH) and to verification texts, so an owner alert destination is always in an enabled country | no |
| `DEFAULT_PHONE_COUNTRY` | no | `US` | ISO country assumed for numbers typed without `+` | no |
| `OWNER_PHONE_GRANDFATHER` | no | `false` | `true` treats existing unverified owner phones as verified until the owner re-verifies (rollout switch; docs/runbook.md section 6). DANGEROUS: bypasses opt-outs and the country allow-list. In production it is ignored without `OWNER_PHONE_GRANDFATHER_ACK`; startup logs a warning | no |
| `OWNER_PHONE_GRANDFATHER_ACK` | with the switch, prod | none | must be exactly `i-understand` for the switch to work in production (deploy.sh refuses `true` without it) | no |
| `OWNER_PHONE_GRANDFATHER_BEFORE`, `OWNER_PHONE_GRANDFATHER_UNTIL` | no | none | ISO instants: only businesses created before `_BEFORE` benefit; the switch expires at `_UNTIL` (unparseable = off) | no |
| `OWNER_VERIFY_GLOBAL_PER_HOUR`, `OWNER_VERIFY_GLOBAL_PER_DAY` | no | `300`, `2000` | platform-wide caps on owner-phone verification texts (on top of per-user, per-IP, per-number and per-business limits) | no |
| `ALLOW_UNVERIFIED_BOOKING_SMS` | no | off | text a model-relayed booking phone when the call has no verified caller id | no |
| `ELEVENLABS_API_KEY` | cond (live voice agent) | unset: scripted calls | ElevenLabs agent and briefing TTS | yes |
| `ELEVENLABS_TOOL_SECRET` | prod when `ELEVENLABS_API_KEY` is set | none | shared secret on the agent tools and `/api/voice/initiation` (`x-recepcionista-tool-secret`) | yes |
| `ELEVENLABS_TOOL_SECRET_ID` | no | none | id of an ElevenLabs workspace secret holding the same value (tool header by reference) | no |
| `ELEVENLABS_WEBHOOK_SECRET` | prod when `ELEVENLABS_API_KEY` is set | none | HMAC for the post-call webhook; shown once by provisioning | yes |
| `ELEVENLABS_AGENT_ID` | no | none | bootstrap for a single-business install only | no |
| `ELEVENLABS_PHONE_NUMBER_ID` | no | none | `phnum_...` id used to bind a number to an agent | no |
| `ELEVENLABS_VOICE_ID` | no | `PStJ2DzQnh8zxG5PDf1s` | voice for briefings and the agent prompt | no |
| `ELEVENLABS_INITIATION_WEBHOOK` | no | `auto` | `off` stops provisioning from configuring the initiation webhook by API | no |
| `OPENAI_API_KEY` | no | unset: templates | extraction and briefings | yes |
| `LLM_MODEL` | no | `gpt-4o-mini` | OpenAI model | no |
| `ANTHROPIC_API_KEY` | no | unset | extraction and briefings (used when OpenAI is unset) | yes |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-4-5` | Anthropic model | no |
| `REVIEW_URL` | no | demo link | review link in gratitude texts | no |

## Scripts only

`scripts/verify-deploy.ts` reads `APP_URL`, `PUBLIC_BASE_URL`, `TWILIO_AUTH_TOKEN`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_BILLING_WEBHOOK_SECRET`,
`ELEVENLABS_WEBHOOK_SECRET`, `ELEVENLABS_TOOL_SECRET` (each check is skipped when its secret is not given; `--strict` turns skips into failures).
`scripts/seed.ts`, `db-reset.ts`, `grandfather-existing.ts` read `DATABASE_URL` and refuse non-disposable database names without `--force-i-know`.

## Call handling (pause / forward)

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `VOICE_LINE_KIND` | no | `native` when `ELEVENLABS_API_KEY` and `ELEVENLABS_PHONE_NUMBER_ID` are both set, else `webhook` | `native` = the number is imported into ElevenLabs (the documented production setup): the app cannot dial a human there, so the Forward choice is refused (422) and the dashboard says "Forwarding is not available on the AI voice line". `webhook` = the number's Twilio Voice URL is `/api/voice/incoming` (signed TwiML: pause records a voicemail, forward dials). deploy.sh accepts `native`, `webhook` or empty. `webhook` is IGNORED (the safe, native reading wins) when `ELEVENLABS_API_KEY` and `ELEVENLABS_PHONE_NUMBER_ID` are both set: the app logs a loud error at boot, `GET /api/admin/jobs` shows it under `diagnostics.voice_line.mismatch`, and deploy.sh warns |
| `FORWARD_ALLOWED_COUNTRY_CODES` | no | `SMS_ALLOWED_COUNTRY_CODES` (`1`) | calling codes a forward number may belong to. Premium, toll-free, Caribbean and territory numbers are refused regardless, when the number is saved AND again on every forwarded call |
| `FORWARD_DENY_AREA_CODES` | no | none | extra 3-digit NANP area codes refused as forward targets, ADDED to the built-in list (900, 976, toll-free 800/833/844/855/866/877/888, Caribbean 242 246 264 268 284 345 441 473 649 658 664 721 758 767 784 809 829 849 868 869 876, territories 670 671 684). An exchange `976` is refused in any area code. deploy.sh checks the format |
| `FORWARD_MAX_CALL_SECONDS` | no | `3600` | longest single forwarded call (`<Dial timeLimit>`); with billing enforced it is also capped to the FORWARD minutes still left (minus what live forwards reserved). Whole number >= 60 (deploy.sh checks) |
| `FORWARD_CALLS_PER_HOUR` | no | `60` | forwarded calls one business may start per hour from ALL callers together (a cost ceiling; each caller has a far lower budget of their own, below); the rest get the voicemail. Whole number >= 1 |
| `VOICEMAIL_PER_HOUR` | no | `60` | voicemails one business may take per hour from all callers together; beyond it callers hear a short "try again later" and no recording starts. Whole number >= 1 |
| `FORWARD_PER_CALLER_PER_HOUR` | no | `3` | forwards ONE caller number may cause per business per hour. Over it the caller gets the voicemail path; the business budget is not touched and the owner is not texted. Whole number >= 1 |
| `VOICEMAIL_PER_CALLER_PER_HOUR` | no | `2` | voicemails one caller number may leave per business per hour; over it: "try again later" (nothing recorded, nothing charged to the business) |
| `FORWARD_WITHHELD_PER_HOUR` / `VOICEMAIL_WITHHELD_PER_HOUR` | no | `5` / `3` | callers that withhold their number (anonymous, restricted, unparseable) share ONE bucket per business per hour with these (stricter) limits |
| `CALLER_UNKNOWN_SHARE_PCT` | no | `75` | percent of the business hourly budget that callers who are NOT known customers may use; the rest is reserved for known customers (a booking not yet anonymised, or an answered AI call of at least 15 s, in the last 90 days). 1-100 (deploy.sh checks) |
| `FORWARD_MINUTES_CAP` | no | `600` | monthly forwarded-call minutes per business (its own counter `usage_counters.forward_seconds`; never the AI minutes). Enforced like the other caps: with billing enforced |
| `TRIAL_FORWARD_MINUTES_CAP` | no | `30` | the lower forwarded-call cap while `trialing` (never above `FORWARD_MINUTES_CAP`) |
| `VOICEMAIL_MINUTES_CAP` | no | `60` | monthly voicemail recording minutes per business (own counter `voicemail_seconds`; never the AI minutes). Used up: callers hear "try again later" and the call is recorded as not taken |
| `FORWARD_MAX_CONCURRENT` | no | `3` | forwarded calls one business may have in progress at once; strangers may hold at most this minus one (one slot is kept for known customers). Live forwards also RESERVE their time limit against the forward minutes cap (table `forward_leases`, expires by itself) |
| `FORWARD_MIN_ANSWERED_SECONDS` | no | `6` | a forwarded leg that "completed" in fewer seconds, or that Twilio flags `AnsweredBy=machine*`, counts as NOT answered (the owner's carrier voicemail): the caller is offered our voicemail. `0` turns it off |
| `FORWARD_RING_SECONDS` | no | `20` | how long the owner's phone rings (`<Dial timeout>`), 10-40. Keep it under your carrier's voicemail pickup (about 25 s) so it does not answer and get bridged |
| `ELEVENLABS_PAUSED_PROMPT_OVERRIDE` | no | off | `true`: a paused call on the AI line also overrides the agent PROMPT (`conversation_config_override.agent.prompt`), in addition to the first message. UNVERIFIED API field: needs the prompt override enabled on the agent (re-provision with this set). The tools are refused while paused whatever this is set to |
| `LOG_PII` | no | unset | `true` stops masking phone numbers and emails in logs (credentials are always masked); debugging only |
