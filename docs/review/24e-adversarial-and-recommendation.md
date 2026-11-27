# 24e. Adversarial review and recommendation: platform admin console replacing env configuration

Inputs: `24a-env-inventory.md`, `24b-admin-surface-today.md`, `24c-tenant-config-gaps.md`. **`24d-admin-design-and-docs.md` does not exist in the repo** (the workflow step that should have produced it wrote nothing); its scope (admin design and docs) is covered here in sections 5 to 7.
Method: read-only. Env list re-derived by grep (`process.env.X`, `env.X`, `env?.X` over `src/`, `scripts/`, `next.config.ts`); claims below were re-checked in code (file:line). No source file was changed; this file is the only output.

## 1. Verdict on the three inventories

| Report | Verdict | Material corrections |
| --- | --- | --- |
| 24a env inventory | **Accurate list, several wrong reasons and two wrong classes** | Count confirmed: 134 raw names = 133 real + the `NEXT_PUBLIC_` comment artefact. No `process.env[...]`, no destructuring, no `Bun.env`/`import.meta.env`. Corrections in section 2. |
| 24b admin surface | **Accurate** (re-verified per route) | "62 distinct env names under src" (section 7) is an undercount: it missed the `env.X` injection pattern; real number is 133. `status='paused'` IS set by tenant release (`src/lib/db/index.ts:594`), as 24c already corrected. |
| 24c tenant config gaps | **Accurate, conflicts with 24a on two keys** | 24c says `APP_URL`/`PUBLIC_BASE_URL` stay env, 24a calls them SETTING_IN_ADMIN: 24c is right (section 2.2). 24c says provider secrets "keep env", 24a says SECRET_IN_ADMIN: both are valid; this is an owner DECISION (D2). |

Admin-surface matrix re-verified (grep per file under `src/app/api/admin/**`):

| Route | role | `requireRecentAuth` | audit | `limitRequest` |
| --- | --- | --- | --- | --- |
| billing | admin | **no** | yes (values of caps/dates missing in meta) | yes |
| jobs (GET) | admin | no | n/a | **no** |
| jobs/run | admin | **no** | non-dry only | **no** |
| release-tenant | admin | **no** | yes (in `billing/release.ts`) | yes |
| repair-numbers | admin | **no** | yes | yes |
| resync-agents | admin | **no** | yes | yes |
| retention | admin | **no** | **none** | **no** |
| users | admin | **no** | yes | yes |

Zero admin pages exist in production (`/dashboard/demo` is `notFound()` unless `DEMO_MODE` in non-prod). There is no settings model among the 31 `model` blocks of `prisma/schema.prisma`. Confirmed.

## 2. Corrected classification

### 2.1 Wrong reasons in 24a

1. **"Edge runtime cannot query Prisma" (CSP_*, Turnstile site key) is wrong for this Next version.** Next is 16.4.6; `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:257`: "Proxy defaults to using the Node.js runtime". `src/proxy.ts` says it "cannot reach the database", but that is a design choice (cheap gate), not a runtime limit. Consequence: the proxy CAN read an in-memory settings snapshot. The CSP vars still stay env, for a different reason: a compromised admin flipping `CSP_REPORT_ONLY` disables XSS protection for every tenant, and the values change only with infrastructure.
2. **"Almost nothing is cached at module load" is true but is not the real obstacle. The obstacle is that every reader is synchronous.** 78 functions take `env: NodeJS.ProcessEnv = process.env` and are sync (`billingEnforced`, `smsCapFor`, `hasTwilio`, `appUrl`, `jobsSetting`, ...); 126 direct `process.env.X` reads sit in 47 non-test files, many inside sync predicates used in sync contexts (`readiness(...)` in webhook GET handlers, `hasStripe()`, `turnstileConfigured`). A DB-backed value cannot be `await`ed there without a cascade refactor. The design must therefore be a **synchronous in-memory snapshot refreshed in the background** (section 5.3), not `await setting(key)`.
3. **The job runner captures config at boot in two ways that 24a/24b understate.** `startJobRunner` (`src/lib/jobs/index.ts:602-626`) (a) returns early, with `started = true` and never schedules a tick, when no job is enabled at boot, so a DB toggle "JOBS on" can never take effect without a restart; (b) computes `every = tickSeconds(env)` once. It passes `env` into each tick, which works today only because `process.env` is a live object; a frozen snapshot object passed there would silently freeze every job switch. The runner must always start and check `enabled` on each tick, with a getter instead of an object.
4. **Proxy and route handlers may load separate copies of a settings module** (separate bundles; for example `turnstileConfigured` in `csp.ts` reads the literal `process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY` "so Next inlines the build-time value into the proxy bundle"). A module-level cache would then exist twice per process. Keep the snapshot on `globalThis` under a symbol. Mark as VERIFY in a production build.
5. **`NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ES` / `_ANNUAL_ES` (24a 7.3): the behaviour is build dependent, not simply "silently English".** The non-`_ES` vars are build `ARG`s with default `""` (`Dockerfile:50-55`), so they are inlined as `""` and a runtime `.env` value is ignored. The `_ES` vars are not build args, so whether server code (`src/app/site-config.ts:17,22`) reads them at runtime depends on Next not inlining undefined `NEXT_PUBLIC_*`. Status: PLAUSIBLE bug both ways (English frozen at build, Spanish maybe runtime). Either way the fix is the same: price copy leaves `NEXT_PUBLIC_*` (Phase 6).
6. **Base-URL divergence is worse than 24a states**: ElevenLabs tool and initiation URLs use `appUrl()` imported from `providers/stripe.ts` (`src/lib/voice/elevenlabs.ts:5,274,500,851`), which reads `APP_URL || NEXT_PUBLIC_APP_URL` and ignores `PUBLIC_BASE_URL`, while Twilio signature checks use `PUBLIC_BASE_URL || APP_URL || NEXT_PUBLIC_APP_URL` (`twilio.ts:39`). With both set to different hosts, the voice agent calls one origin and Twilio signatures are checked against another.
7. **Audit redaction is key-name based** (`src/lib/db/audit.ts:10,27-36`, regex `password|token|secret|authorization|cookie|api_key|otp|recovery` on keys, top level plus one level). A settings audit row shaped `{key:'SMTP_URL', old:'smtp://u:pw@h', new:...}` would store the password in clear: the redacted key is `old`/`new`, not the setting name, and `SMTP_URL` does not match the regex. The settings audit must redact by registry `kind`, never rely on `sanitizeAuditMeta`.
8. `internalAuthHeaders()` (`src/lib/auth.ts:228`) has no caller: dead code that would put the break-glass token on outbound calls. Remove it.

### 2.2 Re-classification (only keys whose class changes or needs a stronger condition)

| Key(s) | 24a class | Corrected class | Why |
| --- | --- | --- | --- |
| `APP_URL`, `PUBLIC_BASE_URL` | SETTING_IN_ADMIN | **MUST_STAY_ENV**, shown read-only in the UI with re-sync actions | Security-critical: CSRF same-origin allowlist (`auth.ts` `checkSameOrigin` adds both hosts), the Twilio signature URL, ElevenLabs tool URLs that carry `ELEVENLABS_TOOL_SECRET` in a header, Stripe return URLs, the WebAuthn RP default. An admin who can change them can send the tool secret, call transcripts and the booking tools to an attacker host. Also needed before the DB loads (sitemap, CSP, proxy). |
| `NEXT_PUBLIC_APP_URL` | SETTING | **REMOVE** | Third fallback of the same origin; the source of the divergence. |
| `CSP_*` | MUST_STAY_ENV (edge) | MUST_STAY_ENV (security: report-only disables CSP) | Reason corrected, class unchanged. |
| `REQUIRE_2FA_FOR_ADMINS` | SETTING | **Invariant**: forced ON whenever DB settings writes are enabled; env may only force it ON | Turning it off is a self-protection downgrade a hijacked admin would do first. |
| `SIGNUP_ALLOW_WITHOUT_CAPTCHA`, `LOG_PII` | SETTING / env | **ENV-ONLY downgrade** ("ratchet": the UI may tighten, only env may loosen) | Loosening security or privacy must not be a click. |
| `BILLING_ENFORCED`, `ALLOW_UNVERIFIED_BOOKING_SMS`, expansion of `SMS_ALLOWED_COUNTRY_CODES`/`FORWARD_ALLOWED_COUNTRY_CODES`, removal from `FORWARD_DENY_AREA_CODES`, `RETENTION_JOB`, `TENANT_RELEASE_JOB` | SETTING | SETTING, **tier "critical"** (step-up, typed confirmation, required reason, all-admin notification, impact preview) | Money, toll fraud, or irreversible deletion. |
| `EMAIL_PROVIDER`, `SMTP_*`, `RESEND_API_KEY`, `EMAIL_FROM` | SECRET/SETTING | SECRET/SETTING, **tier "critical"** | The email channel carries password-reset and verification links: whoever controls the SMTP relay can take over any tenant account. Same for Twilio credentials (owner phone OTPs). |
| `JOBS` | SETTING (lazy) | SETTING **after a runner refactor** (2.1.3) | Today it is boot-only in effect. |
| `JOBS_TICK_SECONDS` | SETTING | SETTING, `restart_required` (or refactor to re-arm the interval) | Read once per process. |
| `OWNER_PHONE_GRANDFATHER`, `_ACK`, `_BEFORE`, `_UNTIL` | SETTING (dangerous) | **ENV, then retire** | One-off rollout switch that bypasses opt-outs and the country list; not a product setting. |
| `GRANDFATHER_BEFORE` | SETTING | **Action parameter** of the grandfather job in the console | A one-shot argument, not state. |
| `ELEVENLABS_AGENT_ID` | SECRET_IN_ADMIN | **DEPRECATE** | Only honoured while exactly one business exists (`elevenlabs.ts:122-127`). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_PHONE_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`, `ELEVENLABS_TOOL_SECRET_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `GOOGLE_CLIENT_ID` | SECRET_IN_ADMIN | SETTING, kind `provider_id` (plain, not encrypted) in the same provider card as its secret | Not secret. They must still change atomically with the secret they pair with (section 5.6). |
| `GOOGLE_OAUTH_REDIRECT_URI` | SETTING | SETTING, **derived and read-only by default**; an override must be same-origin as `APP_URL` | An off-origin redirect sends OAuth codes elsewhere (Google's registered-URI check limits this, but do not rely on it). |
| `LOG_LEVEL` | MUST_STAY_ENV | env base value + **optional time-boxed runtime override** (for example debug for 60 min, auto-revert) | Useful for incidents; needs no DB at boot. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_PLAN_PRICE_DISPLAY*` | SETTING (build) | SETTING **only after removing `NEXT_PUBLIC_` inlining** (Phase 6) | Today a change needs a rebuild. |
| `PRISMA_QUERY_EVENTS`, `PRISMA_LOG` | DEV/ENV | unchanged | `PRISMA_QUERY_EVENTS` is the only true module-load const (`db/client.ts:14`). |
| `ADMIN_TOKEN` | MUST_STAY_ENV | MUST_STAY_ENV, **narrowed** (D8) | Should become break-glass and recovery only, not the routine operator credential. |

All other 24a classifications stand (WebAuthn, TRUSTED_PROXY*, DATABASE_URL, APP_SECRET_KEY, NODE_ENV/NEXT_*, PORT/HOSTNAME, compose and deploy names, and every DEV_ONLY name). Final shape: about 26 env-only names; about 22 provider credentials and ids that may live in the DB (D2); about 70 platform settings; plus about 40 code constants that 24c rightly promotes (quiet hours, briefing hour, voicemail max length, session lifetimes, release grace and notice days, KB limits, inbox and manual-send budgets, new-tenant defaults).

### 2.3 Config that should be admin-configurable and was missed by all three reports

| Item | Today | Why it matters |
| --- | --- | --- |
| Product or brand name | hard-coded `'Recepcionista'` (`src/app/layout.tsx:24-25`), email and SMS templates | White-label or rename without a deploy. |
| Support contact (email, phone, URL) | none anywhere (no support address in `src/`) | Error pages, emails and SMS help replies need it. |
| Legal URLs (Terms, Privacy, SMS terms) and the company postal address | **no legal pages or links exist** (`src/app` has none) | Required for Twilio A2P 10DLC registration, Google OAuth verification, Stripe, and CAN-SPAM in email footers. A compliance blocker, not just config. |
| Maintenance mode / announcement banner / read-only mode | none | An incident switch that does not need a redeploy. |
| Signup mode (open / invite-only / closed) | only implicit, through captcha availability | Launch control and abuse response. |
| Enabled locales (en/es) and platform default locale | code (`LOCALES`) | Turn off a half-translated locale. |
| Platform roles (owner / ops / support / read-only) | one global `admin` role | Least privilege for the console itself (D7). |
| Per-plan feature entitlements (owner call-in, owner reply, native transfer, calendar sync, deposits, locations) | none: features are global env flags | Needed once a `plans` table exists. |
| Provider webhook URLs to paste into provider consoles (display) and re-registration actions | scattered in docs | The console should show the exact URLs and their registration status. |
| Ring and alert recipients for platform alerts (stuck recording deletions, delivery failures, job errors) | logs only | Operators need notification routing. |

## 3. Threat model for moving config and secrets into the DB

Assets: provider credentials (equal to access to all tenants' calls, SMS, payments and calendars); the policy knobs that bound cost and fraud; the tenant data reachable through those providers.
Actors: an external attacker who takes over an admin account; a malicious or careless admin; a tenant owner trying to escalate; someone with a DB dump or backup; someone with SQL injection or write access to the DB.

| # | Threat | Today | With DB config, unmitigated | Required control |
| --- | --- | --- | --- | --- |
| T1 | **Admin account takeover** (phished password, stolen cookie) | Admin can comp, release and purge tenants with no step-up (section 1 table) | Admin can also swap any provider credential, which means **exfiltrating all tenant data**: an ElevenLabs key pointing to the attacker's workspace receives every call; an SMTP relay receives every reset link; a Twilio account receives every OTP | 2FA mandatory for any admin who can write settings (invariant); step-up (5 min, already built: `requireRecentAuth`) on every admin write; tier "critical" adds a typed confirmation, a reason, and an out-of-band notification to all admins plus the env-configured `ALERT_EMAIL`; optional delayed apply (D4); sessions of admin users bound to short TTL (12 h exists). |
| T2 | **Config poisoning of webhook and signing material** | env only | Attacker sets `ELEVENLABS_WEBHOOK_SECRET`/`STRIPE_*_WEBHOOK_SECRET` to a known value, then forges post-call or payment events (mark bookings paid, inject transcripts) | Treat webhook verification secrets as critical tier; changes via "rotate" flows only (capture from provider or test-verify with a signed sample); audit plus notify; keep `APP_URL` in env so the destination of webhooks cannot be changed from the UI. |
| T3 | **SSRF through admin-set hosts and test buttons** | none (no admin-set URL is fetched) | `SMTP_HOST`/`SMTP_URL` pointing at `postgres:5432`, `169.254.169.254`, internal Traefik; "test connection" becomes a port scanner with error oracles | Provider API base URLs are **never** settings (Twilio, ElevenLabs, Stripe, OpenAI, Anthropic, Google, Resend stay hard-coded); SMTP host validated: resolve and reject private, loopback, link-local, CGNAT, ULA and metadata ranges, re-check at connect time (DNS rebinding), port allowlist 25/465/587/2525; test results return a coarse status (ok / auth failed / unreachable), never the remote banner or error text; rate-limit test endpoints (6/min). |
| T4 | **Secret exfiltration through the UI or API** | n/a | A GET returning decrypted values; an export including secrets; audit rows with values (2.1.7); logs printing the snapshot; a validation error echoing input | Write-only: no API ever returns plaintext (only `set`, a fingerprint `sha256(value)[0..8]` plus the last 4 characters where the provider shows that too, `updated_at`, `updated_by`); export excludes secrets; audit stores fingerprints only, redaction by registry kind; the snapshot object holds secrets in a separate non-enumerable map with no `toJSON`; logger redacts by key. |
| T5 | **DB dump or backup leak** | DB has TOTP secrets encrypted with `APP_SECRET_KEY` | DB now holds every provider credential | AES-256-GCM envelope (exists, `totp.ts:198`) with **AAD = setting key** (prevents swapping ciphertexts between keys); key from HKDF(`APP_SECRET_KEY`, info `settings-v1`) for domain separation from TOTP; the key never in the DB or backups (`deploy.sh` backups hold ciphertext only; document that `.env` is backed up separately). |
| T6 | **DB write access (SQLi, rogue DBA)** | can change tenant data | can switch the platform to looser policy (plain JSON) | Sensitive-policy rows carry an HMAC over (key, value, version) with a key derived from `APP_SECRET_KEY`; a row that fails the check is ignored, logged and alerted (the effective value falls back to env or default). Cheap; it turns silent DB tampering into a loud failure. |
| T7 | **Tenant owner escalates to platform scope** | owner routes are business-scoped | a tenant override key that is really platform-wide, or an override outside bounds (for example caps) | Registry declares `scope` and `tenant_editable_by: owner|platform`; the server clamps every tenant value to the platform `min/max`; platform-only overrides (caps, budgets, features) are writable only through `/api/admin/*`; overrides are stored per `business_id` with `requireBusinessAccess`. |
| T8 | **Impersonation abuse** | admin switcher = full owner write, unaudited reads (24b 3/4) | same, now with a console that makes it easier | Support view read-only by default; "enter write mode" requires step-up and a reason, is time-boxed (30 min), shows a banner, and audits enter, exit and every write with `business_id`. |
| T9 | **Break-glass `ADMIN_TOKEN`** | Bearer = superadmin, CSRF-exempt, no step-up, no individual accountability | the token could also rewrite all secrets | Bearer may: read, create or unlock a DB admin, revoke sessions, freeze settings, roll back settings. Bearer may **not** write secrets or critical settings unless `ADMIN_TOKEN_ALLOW_SETTINGS=true` (D8). Every Bearer use triggers a notification. |
| T10 | **Lost or rotated `APP_SECRET_KEY`** | TOTP secrets and Google channel tokens break | every DB-held provider credential becomes undecryptable: total outage | Envelope v2 with a key id (`v2.<kid>.<iv>.<tag>.<ct>`); `APP_SECRET_KEY_PREVIOUS` (env, decrypt only) during rotation; an admin "re-encrypt all" action (TOTP + settings) with progress; a boot check that decrypts one canary row and fails health loudly instead of falling back to "provider unset". Document key escrow. |
| T11 | **Multi-instance divergence** | env can diverge between containers | DB is a single source, but caches lag | Global version counter; each instance polls it (see 5.3); the console shows each instance's applied version (heartbeat row); critical changes are reported "applied on N/N instances". |
| T12 | **Fail-unsafe when the DB is unavailable or the settings load fails** | n/a | Falling back to env or defaults may be **looser** than the DB value (for example DB narrows countries to `1`, env has `1,44`) | Boot: the first snapshot load is awaited in `instrumentation.ts register()` before `startJobRunner`; `/api/health` is 503 until loaded (when the settings table has rows). Runtime: keep last-known-good forever; never drop to env or defaults after a successful load. A row failing decryption or HMAC: that key only falls back, and an alert fires. |
| T13 | **Boot ordering** | n/a | Config needed before the DB is up: `DATABASE_URL`, `APP_SECRET_KEY`, `NODE_ENV`, `LOG_LEVEL`, `TRUSTED_PROXY*`, `APP_URL`, `CSP_*`, `WEBAUTHN_*`, `ADMIN_TOKEN` | All stay env (section 6). The proxy runs before any route and must work on env only, then on the snapshot. |
| T14 | **Rollback restoring a compromised value** | n/a | Rolling back to a secret that has since been revoked provider-side | Rollback of a secret is allowed only within the 7-day retention of previous envelopes and requires a test-connection pass before apply. |
| T15 | **Change-induced outage** (wrong Twilio token, wrong price id) | redeploy needed to fix | a click breaks production instantly | Test-before-save for credentials; impact preview; one-click rollback; dual-secret acceptance windows (5.6). |

## 4. Precedence: env over DB (recommended) versus DB over env

24a and 24c both propose `DB > env > default`. Adversarially that is the weaker choice. Recommendation: **`env (pinned) > DB > registry default`**, with the UI showing every env-set key as "Locked by environment (read-only)".

Justification:
1. **Recovery from poisoned config without SQL**: if an attacker or a bad change writes the DB, the operator pins the correct value in `.env` and restarts; the DB cannot override it.
2. **Defence against a hijacked admin**: the operator can pin the values that must never move (`SMS_ALLOWED_COUNTRY_CODES`, `BILLING_ENFORCED`, email provider) and the console cannot change them.
3. **Zero behaviour change on day one**: today every deployment has its values in `.env`; with env > DB they keep working and are visibly locked. With DB > env a stale DB row (for example from an import) would silently override what the operator believes is configured.
4. **Infrastructure-as-code operators** keep a single source of truth if they want it.

Cost: an existing deployment's UI is all locked at first. Mitigation: a "Move to console" wizard lists env-set keys, copies chosen values into the DB (secrets encrypted), and then tells the operator which lines to delete from `.env` before restarting; until then the key stays locked. A global env `SETTINGS_FREEZE=true` makes the whole console read-only (incident switch).

Tenant scope: `effective(tenant, key) = clamp(tenant_override ?? platform_effective, platform_min, platform_max)`. An env pin pins the platform value; tenant overrides still apply on top unless the registry marks the key `env_pin_blocks_overrides`.

## 5. Recommended architecture

### 5.1 Settings registry (code, single source of truth)

`src/lib/config/registry.ts`: one entry per setting, typed, shared by server and client (with secrets marked).

```ts
defineSetting({
  key: 'billing.trial_days',           // dotted namespace, stable
  env: 'BILLING_TRIAL_DAYS',           // legacy env alias (pin + import)
  group: 'billing', label, help,
  kind: 'int' | 'bool' | 'enum' | 'string' | 'list' | 'url' | 'country_list' | 'duration' | 'secret' | 'provider_id' | 'json',
  schema: z.number().int().min(0).max(90),
  default: 7 | ((ctx) => ctx.production ? ... : ...),  // NODE_ENV-dependent defaults stay expressible
  scope: 'platform' | 'platform+tenant',
  tenant: { editableBy: 'owner' | 'platform', min, max },       // when scope includes tenant
  tier: 'normal' | 'sensitive' | 'critical',
  ratchet?: 'tighten_only_in_ui',       // loosening only via env
  applies: 'live' | 'new_records_only' | 'restart_required' | 'needs_resync',
  followUp?: 'resync_agents' | 'repair_numbers' | 'reregister_webhooks',
  preview?: (next, db) => ImpactReport,  // dry-run impact
  test?: (candidate) => TestResult,      // connection test with the candidate value
  pairedWith?: ['twilio.auth_token'],    // must change atomically
})
```

A CI test asserts: every `process.env.X` read outside `src/lib/config/**` is in the env-only allowlist (section 6); every registry `env` alias is documented in `docs/env-vars.md`; no `NEXT_PUBLIC_` read for registry keys.

### 5.2 Database tables

- `platform_settings(key text pk, value jsonb null, secret_envelope text null, secret_fingerprint text null, version bigint, integrity_mac text, updated_by uuid null, updated_via text, updated_at timestamptz)`; `CHECK (value IS NULL) <> (secret_envelope IS NULL)`.
- `platform_setting_revisions(id, change_set_id, key, old_value jsonb, new_value jsonb, old_fingerprint, new_fingerprint, prev_envelope text null /* kept 7 days for rollback, then nulled by cleanup */, actor_user_id, actor_kind, reason, ip, at)`.
- `setting_change_sets(id, status 'applied'|'rolled_back'|'pending_approval'|'scheduled', apply_at null, created_by, approved_by null, reason, summary jsonb, at)`. Supports D4 (delay or second approver) with no schema change later.
- `tenant_setting_overrides(business_id fk, key, value jsonb, updated_by, updated_at, pk(business_id, key))` for policy knobs (quiet hours, briefing hour and on/off, gratitude toggle and delay, forward/voicemail budgets and caps, ring seconds, owner-reply daily limit). Existing typed columns (`sms_cap_override`, `voice_id`, ...) stay; new knobs go KV (D6).
- `plans(key pk, name, public bool, is_comped bool, stripe_price_id, stripe_price_id_annual, trial_days, sms_cap, call_minutes_cap, voicemail_minutes_cap, forward_minutes_cap, max_locations, features jsonb, sort, archived_at)`; `businesses.plan` references `plans.key` (migration maps today's free strings; `COMP_PLANS` becomes `is_comped`).
- `settings_state(id=1, global_version bigint)` bumped in the same transaction as each change set.
- `instance_heartbeats(instance_id, settings_version, build_sha, seen_at)` for the "applied on N/N" display.

### 5.3 Runtime: snapshot, cache, invalidation

- `runtimeConfig()` returns a **synchronous immutable snapshot** `{ get(key), env-shaped view for legacy readers, secrets (non-enumerable) }` kept on `globalThis[Symbol.for('rc.config')]`, so the proxy bundle and route bundles share it (2.1.4).
- Migration shim for the 78 injectable helpers: change the default parameter from `= process.env` to `= configEnv()` (an env-shaped merged view). The behaviour is identical until DB rows exist; existing tests that inject `env` keep working.
- Refresh: a background poll of `settings_state.global_version` every 10 s (one indexed single-row read per instance); on change, reload the rows, validate each with its schema, verify MAC, decrypt, swap the snapshot atomically. The writing instance refreshes immediately after commit. Postgres `LISTEN/NOTIFY` is an optimisation that is not worth it (Prisma has no LISTEN; it would need a second driver) (D9).
- Boot: `instrumentation.ts register()` awaits the first load (timeout 10 s) before `startJobRunner` and the startup banner; health is 503 until loaded.
- Job runner refactor: always start the interval; per tick read `jobsEnabled()` from the snapshot; re-arm the interval when the tick setting changes.
- Caches keyed by credentials must include the credential fingerprint in the key (for example the ElevenLabs `toolIdCache` and the voices cache), or be cleared on a provider change.

### 5.4 Secrets at rest and rotation

- Envelope v2 `v2.<kid>.<iv>.<tag>.<ct>`, `kid = base64url(sha256(key))[0..8]`, key = HKDF-SHA256(`APP_SECRET_KEY`, salt none, info `rc/settings/v1`), AAD = `setting:<key>`. Keep v1 decrypt for TOTP.
- Rotation of `APP_SECRET_KEY`: set the new key, move the old one to `APP_SECRET_KEY_PREVIOUS`, restart, run "Re-encrypt all" (settings plus TOTP), remove the previous key. Google channel HMAC: renew channels (job exists) or use `GOOGLE_WEBHOOK_SECRET`.
- Canary row encrypted at first boot; failure to decrypt fails health with a clear message.

### 5.5 Audit

- Every change set produces one `audit_events` row `settings.change` (business_id null, or the tenant for overrides) with `meta = {change_set_id, keys, tier, reason}` and one revision row per key. Values in revisions: plain for non-secret kinds, fingerprints for secrets. Never pass values through `sanitizeAuditMeta`.
- Also fix the existing gaps: audit for `admin/retention`, values in `billing.admin_override`, rate limits on `jobs`, `jobs/run`, `retention`, and step-up on all admin writes.
- Critical-tier changes and every Bearer use send a notification (email to every admin plus an env `ALERT_EMAIL`; the email path must not itself depend on DB-held SMTP settings that are being changed: send through the previous transport).

### 5.6 Secret UX (write-only) and atomic provider changes

- Field shows: `Set` / `Not set` / `Locked by environment`, fingerprint, last 4 (when the provider shows them too), `rotated 3 days ago by ana@...`. Buttons: Replace, Test, Remove (critical tier).
- Replace flow: paste, server runs `test(candidate)` (for example Twilio `GET /Accounts/{sid}.json`, ElevenLabs `GET /v1/user`, Stripe `GET /v1/balance` with test/live mode mismatch warning, OpenAI/Anthropic models list, Resend domains, SMTP `verify()` under the SSRF rules, Google client: token endpoint dry call), shows the result, then saves. Paired values (`TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`; `ELEVENLABS_TOOL_SECRET` + `_ID`; Google id + secret) save atomically in one change set.
- Verification secrets accept **current and previous** for a 15-minute window after rotation (Twilio signature, Stripe webhooks, ElevenLabs HMAC, tool secret), then drop the previous one.
- `ELEVENLABS_WEBHOOK_SECRET`: provisioning stores it directly into the encrypted store (critical tier, audited) instead of displaying it once (`provision/route.ts:445-447`).
- `needs_resync` keys show a follow-up banner with the action button (resync agents, repair numbers) that loops over `next_cursor` server-side with progress, instead of the operator curling batches.
- Switching the Stripe key between test and live, or to another account, is blocked when businesses hold `stripe_customer_id`s from the old account unless the operator acknowledges the orphaning (count shown).

### 5.7 Admin console information architecture

Separate route tree `/admin` with its own layout and distinct chrome (D5), gated server-side by `requireRolePage(ctx,'admin')` and the 2FA invariant. Proxy rule: `/admin` and `/api/admin` never public.

| Page | Contents |
| --- | --- |
| Overview | Provider status tiles (live test results, cached 5 min), jobs health, alerts (stuck deletions, SMS delivery failures, decrypt failures, settings drift between instances), recent critical changes |
| Tenants | Directory with server-side search, filters (status, billing status, plan, trial ending, past due, comped), pagination, usage columns |
| Tenant detail | Profile and provider ids (read; agent id, numbers, Stripe ids), status suspend/reactivate, billing/comp with expiry and reason, plan, caps and overrides (all with platform bounds shown), owner-phone verification clear, trial fingerprint clear, closed dates, support view (read-only, time-boxed write mode), tenant audit |
| Plans & billing | Plans table editor (prices from Stripe shown live), trial days, grace days, promo codes, enforcement (critical), price display copy EN/ES |
| Providers & secrets | One card per provider: Telephony (Twilio), Voice (ElevenLabs), Payments (Stripe), AI (LLM provider and model, timeout), Email, Calendar (Google), Captcha (Turnstile). Each: status, ids, secrets (write-only), Test, webhook URLs to copy, follow-up actions |
| Voice & calls | Line kind (with effective/forced/mismatch from `admin/jobs`), native transfer, initiation webhook, language detection, voicemail max, forward limits and budgets, STIR trust, owner call-in and reply flags and budgets, live listening limits |
| Messaging | Supported countries (one object: SMS, forward, default phone country, owner-phone validation), deny area codes editor, default area code, quiet hours, inbox, manual-send and owner-alert budgets, messaging service, STOP footer and templates EN/ES |
| Signup & security | Signup mode, captcha keys, hourly cap, admin 2FA (invariant shown), session lifetimes, password minimum, admins list (invite, disable, revoke sessions, reset 2FA), break-glass sessions |
| Jobs | Per-job enable/pause, schedule (briefing hour etc.), run-now with mandatory dry-run preview then Apply, run history table (needs a `job_runs` table), tenant release and grandfather reports rendered as tables |
| Data & privacy | Retention default and bounds, retention job (critical, preview counts), release grace/notice days, briefing audio keep days, processed-events retention |
| Content & branding | Brand name, support contact, legal URLs, company address, default assistant name, default voice and voice allowlist, default disclosure text, new-tenant defaults (vertical, timezone, scheduling, refund policy, retention) |
| Audit log | Filters (actor, action, business, date range, text), business column, meta and diff view, CSV/JSON export (admin only, audited) |
| Change history | Change sets with diff, who, reason; rollback (creates a new change set); export/import |
| System | Read-only: env-locked keys and their source, build SHA, instances and applied settings version, key id in use, canary status |

Forms and behaviour:
- Generated from the registry: widget by `kind`, the zod schema validates on client and server, each field shows the effective value and its source badge (`default` / `console` / `locked: env`), "Reset to default", and the `applies` note ("affects new checkouts only", "restart required", "re-sync needed").
- Staged edits: changes on a page accumulate into a draft change set; "Review changes" shows the diff and the **impact preview** (for example: lowering the SMS cap puts 14 tenants over it this month; narrowing countries makes 3 owner phones invalid; enabling retention purges 1,240 calls in 9 tenants), then Apply with a reason (required for sensitive and critical tiers).
- Import/export: JSON of non-secret settings, plans and tenant-override defaults, with a schema version; import always runs as a dry-run diff first and then becomes one change set; secrets never exported (fingerprints only, so import can warn "secret differs").
- Rollback: per change set or per key, through a new change set; secret rollback only within the retained envelope window and after a passing test.

## 6. What must remain env

`DATABASE_URL` (+ compose `POSTGRES_*`, `DATABASE_URL_OVERRIDE`), `APP_SECRET_KEY` (+ new `APP_SECRET_KEY_PREVIOUS`), `ADMIN_TOKEN`, `NODE_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE`, `PORT`, `HOSTNAME`, `APP_URL`, `PUBLIC_BASE_URL`, `TRUSTED_PROXY`, `TRUSTED_PROXY_HOPS`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `CSP_REPORT_ONLY`, `CSP_UPGRADE_INSECURE`, `CSP_REPORT_URI`, `LOG_LEVEL` (base), `LOG_PII`, `PRISMA_LOG`, `PRISMA_QUERY_EVENTS`, `DOMAIN`, `TRAEFIK_NAME`, `APP_IMAGE`, `TOOLS_IMAGE`, `BACKUP_DIR`, `COMPOSE`, `FOLLOW_LOGS`, `ENV_FILE`, `CREATE_USER_PASSWORD`, all DEV_ONLY (`ALLOW_INSECURE_DEV`, `DEMO_MODE`, `GOOGLE_OAUTH_MOCK`, `STRIPE_ALLOW_UNSIGNED`, `ALLOWED_DEV_ORIGINS`), the transitional `OWNER_PHONE_GRANDFATHER*` (until retired), and new env-only controls: `SETTINGS_FREEZE`, `ADMIN_TOKEN_ALLOW_SETTINGS`, `ALERT_EMAIL`. Any registry key may additionally be pinned by its env alias (section 4).

Operator scripts (`scripts/verify-deploy.ts`, `smoke.ts`) read secrets from `.env`; once secrets live in the DB they need an admin API (`GET /api/admin/selftest`, which runs the same provider tests server-side) instead of local secrets.

## 7. Phased implementation plan

| Phase | Scope | Size |
| --- | --- | --- |
| 0. Hardening that is independent of the console | Single base-URL resolver used by Twilio, ElevenLabs, Stripe, Google, sitemap (drop `NEXT_PUBLIC_APP_URL`); `requireRecentAuth` on all `/api/admin/*` writes for cookie sessions; audit and rate limit for `admin/retention`, rate limit for `jobs` and `jobs/run`; values in `billing.admin_override` meta; remove dead `internalAuthHeaders`; fix the KB 20/15 vs 200/200 truncation; verify the `_ES` price build behaviour; default `REQUIRE_2FA_FOR_ADMINS` on in production | S |
| 1. Config module with no DB | Registry for all platform keys (env aliases, defaults, schemas, tiers); `configEnv()` shim replacing the `= process.env` defaults and the direct reads; CI rule forbidding `process.env` outside the config module except the env-only allowlist; the job runner refactor (always tick, read per tick) | M |
| 2. DB store and runtime | Tables of 5.2 (without plans), loader, globalThis snapshot, version poll, boot await and health gate, MAC check, revisions and audit with kind-based redaction, admin API: `GET /api/admin/settings` (registry + effective + source), `POST /api/admin/settings/preview`, `POST /api/admin/settings/apply`, rollback, export/import (dry-run) | M |
| 3. Console shell and non-secret settings | `/admin` layout, Overview (basic), all policy pages generated from the registry, Change history with rollback, System page, "Move to console" wizard | L |
| 4. Secrets and providers | Envelope v2 + HKDF + kid, canary, re-encrypt action; write-only fields; test-connection endpoints under SSRF rules; paired atomic changes; dual-secret windows on the four verifiers; provisioning stores the ElevenLabs webhook secret; follow-up actions with server-side batching; critical-tier notifications; Bearer restrictions (D8) | L |
| 5. Tenants and plans | `plans` table and migration of `plan` strings, entitlements; `tenant_setting_overrides` and clamping; tenant directory and detail page; suspend/reactivate; read-only support view with audited time-boxed write mode; closed-dates editor for owners | L |
| 6. Remove build-time config | Turnstile site key and price copy passed from server components and the snapshot; CSP reads the site key from the snapshot; drop the three Dockerfile build args | S |
| 7. Operations views | Jobs page with `job_runs` history; audit search and export; SMS delivery failures view; provider health tiles; instance heartbeats; branding, legal URLs and maintenance banner | M |
| 8. Platform roles (if D7 = yes) | owner / ops / support / read-only roles for console pages and APIs | M |

Order rationale: 0 and 1 deliver value and remove risk even if the console never ships; 2 before 3 so the UI sits on a tested API; secrets (4) after the non-secret path has proven the cache, audit and rollback machinery.

## 8. Owner decisions

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Precedence between env and console values? | (a) env pinned > DB > default; (b) DB > env > default | **(a)**: recovery and defence against a hijacked admin, zero day-one change (section 4). |
| D2 | Should provider secrets be storable in the DB at all? | (a) env only, the console shows status and runs tests; (b) per secret, either env or console (encrypted); (c) console only | **(b)**: meets the goal "configure in the admin UI" while letting a security-conscious operator pin secrets in env. Ship (a) first in Phase 3 (status + test), add storage in Phase 4. |
| D3 | Public origin (`APP_URL`/`PUBLIC_BASE_URL`) editable in the console? | (a) env only, read-only display + re-sync actions; (b) editable, critical tier | **(a)**: it governs CSRF, webhook destinations and the tool secret's destination. |
| D4 | Extra protection for critical-tier changes (email, Twilio, ElevenLabs credentials, webhook secrets, billing enforcement, countries, purge jobs)? | (a) step-up + reason + notify all admins; (b) (a) + delayed apply (for example 1 h, cancellable); (c) (a) + second-admin approval | **(a) now, (c) as an option once there are 2+ admins.** Delay hurts incident response; two-person approval is the real control but needs two people. |
| D5 | Where does the console live? | (a) `/admin` separate layout; (b) `/dashboard/admin` inside the tenant shell | **(a)**: avoids confusing tenant context (the business switcher) with platform actions and makes proxy and CSP rules simpler. |
| D6 | Storage of new per-tenant knobs? | (a) KV `tenant_setting_overrides` validated by the registry; (b) a typed column per knob | **(a)** for policy knobs (no migration per knob, uniform UI and audit); keep typed columns that SQL filters on (caps already exist). |
| D7 | Platform roles beyond a single `admin`? | (a) keep one role; (b) owner / ops / support / read-only | **(b) in Phase 8**: support staff should not be able to rotate provider credentials. Not a blocker for Phases 0 to 5. |
| D8 | What may the Bearer `ADMIN_TOKEN` do? | (a) everything (today); (b) recovery only: read, create/unlock admin, revoke sessions, freeze, rollback; settings writes only with `ADMIN_TOKEN_ALLOW_SETTINGS=true` | **(b)**: individual accountability for routine work, and a shared secret cannot silently rewrite credentials. |
| D9 | Cache propagation mechanism? | (a) version poll every 10 s; (b) Postgres LISTEN/NOTIFY; (c) TTL only | **(a)**: simple, one row read, bounded 10 s lag, shows N/N applied. |
| D10 | Security-loosening toggles (`SIGNUP_ALLOW_WITHOUT_CAPTCHA`, disabling admin 2FA, `LOG_PII`)? | (a) console with critical tier; (b) env only ("ratchet") | **(b)**. |
| D11 | Retire transitional or redundant vars (`OWNER_PHONE_GRANDFATHER*`, `ELEVENLABS_AGENT_ID`, `NEXT_PUBLIC_APP_URL`)? | (a) retire; (b) keep in env | **(a)**, after checking that no deployment still depends on them (the startup banner can warn for one release). |
| D12 | Owner self-service limits: which tenant overrides may an owner edit? | (a) none (platform only); (b) comfort knobs (quiet hours stricter than platform, briefing on/off and hour, gratitude toggle, ring seconds within bounds); (c) everything within bounds | **(b)**. Caps, budgets and features stay platform-only. |
| D13 | How long to keep previous secret envelopes for rollback? | 0 / 7 / 30 days | **7 days**. |
| D14 | Legal pages and brand: content in the console, or links to externally hosted pages? | (a) URLs only; (b) a built-in editor | **(a) now** (A2P and Google verification need public URLs soon); an editor is not worth it yet. |

## 9. Risks

1. **The console becomes the most valuable account in the system.** Any admin who can write provider credentials can read every tenant's calls and messages through the provider. Without the T1 controls this proposal makes the platform less secure than env. Phases 0 and 4 are not optional.
2. **Silent behaviour change from the migration of 126 reads and 78 helpers.** Mitigation: Phase 1 ships with no DB and must be behaviour-identical (snapshot = env); the CI rule prevents regressions.
3. **Frozen config objects**: any code that captures the snapshot (as the job runner captures `env`) stops seeing changes. Code review rule: never store the snapshot, call `runtimeConfig()` per use.
4. **Losing `APP_SECRET_KEY`** now bricks every DB-held credential, not only 2FA. Requires documented escrow and the canary check.
5. **Propagation lag** (up to 10 s) during critical rotations; mitigated by dual-secret windows and the N/N display.
6. **Looser fallback values** if a later snapshot load fails before the first success; mitigated by the boot gate and last-known-good.
7. **DB CHECK constraints duplicate code limits** (deposit 100..100000, scheduling choices, review URL length); making those bounds admin-tunable needs migrations that drop or widen the CHECKs, or the console must show the DB ceiling as a hard maximum.
8. **Test matrix growth**: settings that were constants become variables; every registry entry needs a schema test and its consumers need a test at the bounds.
9. **Operator scripts** (`verify-deploy.ts`, `smoke.ts`) lose access to secrets moved into the DB; replace them with a server-side self-test endpoint before secrets move.
10. **Scope creep**: about 130 settings plus about 40 promoted constants. Build only what has an owner (D12) and a clear change frequency; leave the "Const ok" items from 24c in code.
