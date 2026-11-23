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
| `CSP_REPORT_URI` | no | none | adds `report-uri` to the CSP (a collector URL you operate) | no |
| `LOG_LEVEL` | no | `debug` (dev), `info` (prod) | log verbosity | no |
| `PRISMA_LOG` | no | unset | `1` logs every query | no |
| `RETENTION_JOB` | no | off | exactly `on` enables the automatic PII purge (docs/compliance.md) | no |
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
| `SIGNUP_MAX_PER_HOUR` | no | `30` | platform-wide signup cap per hour | no |
| `TURNSTILE_SECRET_KEY` | no | off | Cloudflare Turnstile on signup; server verification fails closed. Needs the site key too (deploy.sh checks the pair) | yes |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | with the secret | none | Turnstile widget (build time) | no |
| `NEXT_PUBLIC_PLAN_PRICE_DISPLAY` | no | "Simple monthly pricing, with a free trial" | price text on the plan step (build time) | no |
| `CREATE_USER_PASSWORD` | no | none | `scripts/create-user.ts` non-interactive password (the script refuses `--password`) | yes |

## Billing and plan limits (docs/billing.md)

| Name | Required | Default | Feature | Secret |
| --- | --- | --- | --- | --- |
| `BILLING_ENFORCED` | no | unset (nothing refused) | exactly `true` refuses provisioning, texts and calls for businesses without an active plan. Comp existing tenants first (`scripts/grandfather-existing.ts`) | no |
| `STRIPE_SECRET_KEY` | cond (`BILLING_ENFORCED=true`, deposits) | unset: mock checkout and mock deposit links (not in production) | Stripe API: subscriptions and deposit payment links | yes |
| `STRIPE_PRICE_ID` | cond (`BILLING_ENFORCED=true`) | none | recurring monthly price | no |
| `STRIPE_BILLING_WEBHOOK_SECRET` | cond (`BILLING_ENFORCED=true`) | none | signs `/api/billing/webhook` (a different secret from the deposit webhook) | yes |
| `STRIPE_WEBHOOK_SECRET` | prod | none | signs `/api/payments/webhook` (deposits) | yes |
| `STRIPE_ALLOW_UNSIGNED` | never in prod | unset | dev: accept unsigned deposit webhooks (also needs `ALLOW_INSECURE_DEV`) | no |
| `BILLING_TRIAL_DAYS` | no | `7` | free-trial length, 0-90 | no |
| `BILLING_PLAN_NAME` | no | `standard` | plan label stored on subscribed businesses | no |
| `BILLING_ALLOW_PROMO_CODES` | no | off | `true` shows the promotion-code box in Checkout | no |
| `BILLING_PAST_DUE_GRACE_DAYS` | no | `5` | days a past_due business keeps working | no |
| `PLAN_SMS_CAP` | no | `500` | monthly texts per business (overrides per business win) | no |
| `PLAN_CALL_MINUTES_CAP` | no | `300` | monthly call minutes per business | no |

## Voice, SMS, phone numbers and LLM

| Name | Required | Default | Feature | Secret |
| --- | --- | --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | cond (real SMS and numbers) | unset: SMS is logged, numbers are mock | Twilio | no |
| `TWILIO_AUTH_TOKEN` | cond (with the SID; also verifies Twilio webhooks) | none | Twilio | yes |
| `TWILIO_PHONE_NUMBER` | cond | none | SMS sender number | no |
| `SMS_ALLOWED_COUNTRY_CODES` | no | `1` | destination countries for outbound texts (verified owner phones are exempt) | no |
| `DEFAULT_PHONE_COUNTRY` | no | `US` | ISO country assumed for numbers typed without `+` | no |
| `OWNER_PHONE_GRANDFATHER` | no | `false` | `true` treats every existing owner phone as verified until the owner re-verifies (rollout switch; docs/runbook.md section 6). The seeded demo business is already verified | no |
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
