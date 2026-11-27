# Platform admin console: the agreed architecture

Status: **Phase 1 implemented** (registry, runtime config module, job-runner refactor, CI boundary rule). **Phases 2, 4, 5, 7 and 8 are implemented as BACKEND** (schema, store, loader, secrets, plans, tenants, roles, job runs, audit search, JSON APIs, tests): see `docs/design/admin-console-contracts.md`. **Phase 3 (the `/admin` UI) and Phase 6 (build-time config) are not built.**
Sources: `docs/review/24a-env-inventory.md`, `24b-admin-surface-today.md`, `24c-tenant-config-gaps.md`, `24e-adversarial-and-recommendation.md`. This file records the OWNER DECISIONS that settled
24e section 8 and how the code realises them.

## 1. Owner decisions (final)

| Id | Decision |
| --- | --- |
| D1 | Precedence **env pin > console (database) > registry default**. An environment variable that is set to a non-empty value PINS its key; the console shows it as "locked by environment" and cannot change it. |
| D2 | Provider secrets are storable **per secret, in the console OR in the environment** (write-only, encrypted at rest from Phase 4). |
| D3 | `APP_URL` / `PUBLIC_BASE_URL` are **env only**; read-only in the console, with re-sync actions. |
| D4 | **Critical tier** = step-up + reason + typed confirmation + impact preview + notification to every admin. Two-person approval is an option once there are two or more admins. |
| D5 | The console lives at **`/admin`** (own layout, never public in the proxy). |
| D6 | New per-tenant policy knobs are **key/value overrides** (`tenant_setting_overrides`) validated by the registry; typed columns stay where SQL filters on them. |
| D7 | Platform roles **owner / ops / support / read-only** (Phase 8). |
| D8 | Bearer `ADMIN_TOKEN` is **recovery only** (read, create/unlock admin, revoke sessions, freeze, rollback); writing secrets or critical settings needs `ADMIN_TOKEN_ALLOW_SETTINGS=true`. |
| D9 | Cache propagation by **version poll every 10 s**. |
| D10 | Security-loosening toggles (`SIGNUP_ALLOW_WITHOUT_CAPTCHA`, admin 2FA off, `LOG_PII`) are **env-only ratchets**: the console may tighten, only the environment may loosen. |
| D11 | Retire `OWNER_PHONE_GRANDFATHER*`, `ELEVENLABS_AGENT_ID`, `NEXT_PUBLIC_APP_URL`: deprecation warning in the startup banner for one release, then ignored. |
| D12 | Owners edit **comfort knobs only** (quiet hours stricter than the platform, briefing on/off and hour, thank-you toggle, ring seconds within bounds). Caps, budgets and features are platform-only. |
| D13 | Previous secret envelopes are kept **7 days** for rollback. |
| D14 | Legal pages and brand are configured in the console: URL fields AND a built-in markdown page editor with versions (Phase 7). |

## 2. What exists today (Phase 1)

```
src/lib/config/
  schema.ts            zod-free validators: int, bool, enum, string, url, list, secret, json (check / fromText / toText)
  types.ts             SettingDef, tiers, applies, ratchets, tenant rules, EnvOnlyEntry, RetiredEnvEntry
  define.ts            defineSetting(), defaultContext() (NODE_ENV dependent defaults), ratchetAllows()
  registry-env.ts      the 100 settings that are environment variables today (24a)
  registry-promoted.ts the 56 promoted constants (24c) and 16 new settings (24e 2.3: brand, support, legal URLs, maintenance, signup mode, locales)
  registry.ts          assembles SETTINGS; SettingKey / SettingValue types; lookup by key and by env alias; registryStats()
  env-only.ts          ENV_ONLY (24e section 6), BUILD_TIME_ENV, RETIRED_ENV
  index.ts             runtime: ConfigSnapshot, setSnapshotSource(), runtimeConfig(), configEnv(), setting(), settingSource(),
                       resolveSetting(), configProblems(), retiredEnvWarnings(), redactSecrets()
```

The module is **dependency-free** (relative imports only, no `node:` modules): the proxy and instrumentation bundles import it. `tests/config-boundary.test.ts` enforces that.

### 2.1 Runtime semantics

* `configEnv()` is the env-shaped merged view that replaced `process.env` as the default of every injectable helper (`env: NodeJS.ProcessEnv = configEnv()`, 78 helpers) and in every direct read.
  **With no snapshot source installed it returns `process.env` itself**, so behaviour is identical to reading the environment. With a snapshot it returns a `Proxy` over `process.env`: a key that
  the environment pins reads the environment value, any other key the console holds reads the console value rendered as the text the legacy reader expects (`envFormat: 'on_off'` for flags such as
  `RETENTION_JOB`, `NATIVE_TRANSFER` that only accept `on`).
* `setting(key)` is the typed getter (`SettingValue<K> | null`, `null` = unset): env pin parsed with the registry schema, else console value, else the default (a function of NODE_ENV). A pin the
  schema rejects falls to the default, never to the console, and `configProblems()` names it (the boot banner prints names only).
* The snapshot is a `ConfigSnapshot` kept behind `setSnapshotSource(() => snapshot)`, a **synchronous** function Phase 2's database loader will implement. The source and the cached view live on
  `globalThis[Symbol.for('rc.config')]`, because the proxy bundle and the route bundles load separate copies of this module.
* Secrets live in a **non-enumerable** map on the snapshot; the snapshot has no `toJSON`, `util.inspect` prints counts only, the env view never lists secret keys, and `redactSecrets()` (called by the logger's `scrub`)
  masks any configured secret value of 8 or more characters inside a log string.
* **Never keep the snapshot, the view or a setting in a module-level constant.** Call `configEnv()` / `setting()` at each use. A test (`no module-level const captures the config`) guards the obvious case.
* A failing or empty snapshot source leaves the environment untouched (last-known-good logic belongs to the Phase 2 loader).

### 2.2 The CI boundary rule

`tests/config-boundary.test.ts` fails when a non-test file under `src/` reads the process environment outside `src/lib/config/**`, except:
framework flags (`NODE_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE`), no build-time `NEXT_PUBLIC_*` name any more (`BUILD_TIME_ENV` is empty since Phase 6: the Turnstile site key and the price copy are read from the snapshot at request time), and the boot reads of
`src/lib/db/client.ts` (`DATABASE_URL`, `PRISMA_LOG`, `PRISMA_QUERY_EVENTS`) and `src/instrumentation.ts` (`DATABASE_URL`), which run before the config module can have loaded anything.
`tests/config-registry.test.ts` fails when a registry env alias, an env-only name or a retired name is missing from `docs/env-vars.md`, when a default or bound is invalid, and when a registry default
differs from what the readers apply today (so the registry cannot silently drift from the code). Per-entry schema tests are generated from the registry.

### 2.3 Job runner

`startJobRunner()` always starts (once per process) and arms an unref'd interval. Every pass (`runnerTick`) re-reads the configuration: it re-arms the interval when `JOBS_TICK_SECONDS` changed,
announces a change of the enabled set, and runs `enabledJobs(configEnv())`. A console toggle of `JOBS`, `RETENTION_JOB` or `TENANT_RELEASE_JOB` therefore takes effect on the next tick. Before, the
runner returned early when nothing was enabled at boot and captured `env` once.

## 3. Registry entry

```ts
defineSetting({
  key: 'billing.trial_days',          // dotted, stable, never renamed
  env: 'BILLING_TRIAL_DAYS',          // legacy variable: pins the value; imported by the "move to console" wizard
  group: 'billing', label, help,      // English text; i18n keys derive: admin.setting.<key>.label / .help
  kind: 'int',                        // int | bool | enum | string | list | url | country_list | duration | secret | provider_id | json
  schema: s.int({ min: 0, max: 90 }), // shared by server and client: check(value) / fromText(text) / toText(value)
  default: 7,                         // or (ctx) => ctx.production ? ... : ...; null = unset
  scope: 'platform' | 'platform+tenant',
  tenant: { editableBy: 'owner' | 'platform', min, max, rule: 'within_bounds' | 'stricter_than_platform', envPinBlocksOverrides },
  tier: 'normal' | 'sensitive' | 'critical',
  ratchet: 'tighten_only_in_ui', tightenIs: 'lower' | 'higher' | 'fewer' | 'more',
  applies: 'live' | 'new_records_only' | 'restart_required' | 'needs_resync',
  followUp: 'resync_agents' | 'repair_numbers' | 'reregister_webhooks' | 'restart',
  pairedWith: ['twilio.auth_token'],   // changes in the same change set
  unit, codeRef, envFormat, credentialFingerprintInCaches,
});
```

Classes (derived from `kind`): `SETTING_IN_ADMIN` (plain), `SECRET` (kind `secret`: write-only, encrypted, critical, platform scope), `PROVIDER_ID` (kind `provider_id`: plain, shown in the same provider
card as its secret). Everything else is env-only (`ENV_ONLY`).

### Tiers

| Tier | Requirements for a console write |
| --- | --- |
| normal | recent sign-in (step-up, 5 min) |
| sensitive | step-up + a written reason |
| critical | step-up + reason + typed confirmation + impact preview + notification to every admin (and `ALERT_EMAIL`); credentials also pass a test-connection before saving |

Critical: billing enforcement, country lists and denied area codes, the unverified-booking-SMS policy, retention and tenant-release jobs, the email channel and every credential and webhook secret.
Ratchet keys (session lifetimes, step-up window, password minimum, signup cap): the console may only move them in the safer direction (`ratchetAllows`).

### Env pin semantics

An environment variable PINS its key when set to a non-empty (after trim) value. A pinned key is locked in the console and shown with its source badge (`locked: env` / `console` / `default`).
`SETTINGS_FREEZE=true` makes the whole console read-only. Tenant overrides still apply on top of a pinned platform value unless the registry marks `envPinBlocksOverrides`.
Precedence for a tenant: `clamp(tenant_override ?? platform_effective, platform_min, platform_max)`.

## 4. Plan (unchanged from 24e section 7, with the decisions above)

| Phase | Scope | State |
| --- | --- | --- |
| 0 | single base-URL resolver, admin step-up, audit and rate limits, 2FA default, build args | done |
| 1 | registry, `configEnv()` shim, boundary rule, job runner refactor, deprecation warnings | **done** (this document) |
| 2 | tables (`platform_settings`, revisions, change sets, `settings_state`, heartbeats), loader plugged into `setSnapshotSource`, 10 s version poll, boot await and health gate, MAC check, admin API (`/api/admin/settings`, preview, apply, rollback, export/import) | **done (backend)** |
| 3 | `/admin` shell, non-secret pages generated from the registry, change history, system page, "move to console" wizard | **done (agent A)**: see the Agent A section of `admin-console-contracts.md`; providers page: agent B |
| 4 | secrets: envelope v2 + HKDF + kid, canary, write-only fields, test-connection under SSRF rules, paired atomic changes, dual-secret windows, critical notifications, Bearer restrictions | **done (backend)**; real test-connection calls still open (`verifySecret` hook, SMTP SSRF guard done) |
| 5 | plans table, tenant overrides, tenant directory and detail, suspend, read-only support view | **done (backend)**; consumers of the overrides and plan features are per-feature work |
| 6 | remove build-time config (`NEXT_PUBLIC_*` price copy and Turnstile site key) | **done (agent D)**: server components read the snapshot and pass props; CSP reads the snapshot; no Docker build args; `BUILD_TIME_ENV = []` |
| 7 | jobs history, audit search, delivery failures, brand, legal URLs and the markdown page editor with versions | **done (backend)**: `job_runs`, audit search + export, legal page versions, heartbeats; delivery-failure view and public legal pages open |
| 8 | platform roles owner / ops / support / read-only | **done (backend)** |

## 5. Rules for code review

1. No `process.env` in `src/` outside `src/lib/config/**` (framework flags, `NEXT_PUBLIC_*` and the two boot files excepted). The test enforces it.
2. A new setting is a registry entry first: key, env alias (if any), schema, default, tier, `applies`; then a doc row in `docs/env-vars.md`; then the consumer.
3. Never capture `configEnv()`, `runtimeConfig()` or `setting()` in a module-level constant, a closure that outlives a request, or a timer.
4. Audit rows for settings redact by registry `kind`, never by key-name matching (`sanitizeAuditMeta` would store a `SMTP_URL` password in clear).
5. Provider API base URLs are never settings (SSRF); the SMTP host is validated against private, loopback, link-local and metadata ranges at save and at connect.
