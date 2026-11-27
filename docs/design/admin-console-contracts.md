# Admin console: contracts of the backend (Phases 2, 4, 5, 7, 8)

Status: **implemented**: schema, server logic, JSON APIs, tests. **No UI page exists yet**: Phase 3 builds `/admin` against exactly what this file lists.
Companion documents: `docs/design/admin-console-architecture.md` (owner decisions D1-D14, registry), `docs/review/24e-adversarial-and-recommendation.md` (threat model T1-T15).
Everything here was written once, in one pass; **the code is the source of truth, this file is its index**. Tests: `tests/admin-console-pure.test.ts`, `tests/integration/admin-settings.test.ts`,
`tests/integration/admin-routes.test.ts`, `tests/db/admin-console-migration.test.ts`.

## 0. Who owns what

| Area | Owner | Notes |
| --- | --- | --- |
| `prisma/**`, `src/lib/db/**` (incl. `audit.ts` `meta_trusted`, `usage.ts` plan caps + suspension) | this phase | Phase 3 must not touch them; ask for a column / helper instead |
| `src/lib/admin/**` (store, loader, crypto, permissions, guard, plans, overrides, legal, tenants, admins, support, audit search, job runs, rotation, selftest) | this phase | Phase 3 imports TYPES and pure helpers (`permissions.ts`, `plan-catalog.ts`, the registry) in client code; everything else is server-only |
| `src/lib/config/**` | extended here (`ConfigSnapshot.previousSecrets`, `envFromSnapshot`, `acceptedSecrets`, `verifierSecrets`, `pinnedByEnv`) | still dependency-free (edge-safe), still guarded by `tests/config-boundary.test.ts` |
| `src/app/api/admin/**`, `src/app/api/businesses/[id]/settings-overrides` | this phase | JSON only |
| `/admin` pages, the layout, i18n strings `admin.*`, forms generated from the registry, the "move to console" wizard, the markdown renderer of the legal pages (public pages `/terms`, `/privacy`, `/sms-terms`), the maintenance banner | **Phase 3 (UI)** | the forms use `GET /api/admin/settings` (schema info + source + lock) so they need no per-key code |
| Phase 4 real connection tests behind `selftest` and `verifySecret`, the ElevenLabs provisioning that stores the webhook secret, price-copy removal of `NEXT_PUBLIC_*` (Phase 6) | later | hooks exist: `ApplyOptions.verifySecret`, `ProviderReadiness.tested` |

## 1. Tables (migration `20261211120000_admin_console_schema`)

Hand written, re-runnable, one transaction, only adds (tables, columns, `NOT VALID` checks validated right after). Zero drift against `schema.prisma` (proof in the migration test).

| Table | Columns (important ones) | Rules |
| --- | --- | --- |
| `platform_settings` | `key` pk, `value jsonb`, `secret_envelope`, `secret_fingerprint`, `secret_last4`, `previous_envelope`, `previous_until`, `version bigint`, `integrity_mac`, `updated_by`, `updated_via`, `updated_at` | CHECK exactly one of `value` / `secret_envelope`; key regex; `_canary` is the canary row (secret envelope, placeholder MAC). Console-held values ONLY: an env pin lives nowhere here |
| `setting_change_sets` | `id`, `status` (`applied` \| `rolled_back` \| `pending_approval` \| `scheduled`), `apply_at`, `created_by`, `created_kind`, `via`, `approved_by`, `reason`, `tier`, `version`, `rollback_of`, `summary`, `at` | `pending_approval` / `scheduled` + `approved_by` / `apply_at` are kept for the future approval flow (nothing writes them today) |
| `platform_setting_revisions` | `change_set_id` fk, `key`, `op` (`set` \| `remove`), `old_present`, `old_value`, `new_value`, `old_fingerprint`, `new_fingerprint`, `prev_envelope`, `actor_*`, `reason`, `ip`, `at` | non-secret: real before / after values; secret: fingerprints only + the replaced envelope in `prev_envelope`, NULLED by the cleanup job after 7 days (D13) |
| `tenant_setting_overrides` | `business_id` fk cascade + `key` (pk), `value jsonb`, `updated_by`, `updated_at` | validated by the registry; clamped on write and on read |
| `settings_state` | single row `id = 1`: `global_version bigint`, `frozen_at`, `frozen_by`, `frozen_reason` | `global_version` is bumped inside every settings / plan write transaction; instances poll it |
| `instance_heartbeats` | `instance_id` pk, `settings_version`, `build_sha`, `canary`, `ignored_rows`, `started_at`, `seen_at` | one row per running process; deleted after a day without a heartbeat |
| `plans` | `key` pk, `name`, `public`, `is_comped`, `stripe_price_id`, `stripe_price_id_annual`, `trial_days`, `sms_cap`, `call_minutes_cap`, `voicemail_minutes_cap`, `forward_minutes_cap`, `max_locations`, `features jsonb`, `sort`, `archived_at`, `created_at`, `updated_at`, `updated_by` | NULL cap = inherit the platform setting. Seeds: `standard` (public), `legacy` + `grandfathered` (comped), `demo`; caps 500 / 300 / 60 / 600 (today's defaults) |
| `businesses.plan` -> `plans.key` | FK `ON UPDATE CASCADE ON DELETE RESTRICT` | a BEFORE trigger registers an unknown plan string as a hidden, non-comped, cap-less plan (so Stripe webhooks, scripts and tests that store a free string keep working). Existing unknown strings were mapped to `legacy`, each recorded as audit `plans.migrated` (`meta.from`) |
| `businesses.suspended_at / suspended_reason / suspended_by` | CHECK `suspended_at` and `suspended_by` set together | see section 4.9 |
| `users.platform_role` | `owner` \| `ops` \| `support` \| `read_only`, only for `role = 'admin'` (CHECK) | every pre-existing admin became `owner`; `createUser({ role: 'admin' })` defaults to `owner`; NULL on an admin = `read_only` (fail safe) |
| `job_runs` | `job`, `started_at`, `finished_at`, `dry_run`, `status` (`ok` \| `error` \| `skipped`), `counts`, `processed`, `errors`, `error_sample`, `actor`, `trigger` (`schedule` \| `manual` \| `api`) | EVERY run (dry, real, zero-work); pruned after 60 days by the cleanup job |
| `legal_pages` + `legal_page_versions` | page `(slug, locale)` pk with `published_version`; versions `(slug, locale, version)` unique, `body` (markdown, CHECK <= 200000 chars), `draft`, `note`, `created_by`, `published_at`, `published_by` | slugs `terms` \| `privacy` \| `sms_terms`; locales `en` \| `es`; one draft per page; a published version is immutable |
| `support_grants` | `user_id` fk, `business_id` fk, `reason`, `started_at`, `expires_at`, `ended_at`, `ip` | a support admin's 30 minute WRITE mode in one tenant |

Other tables decided in `tests/db/clear-all.test.ts`: the console tables survive `clearAll` (configuration and history); `tenant_setting_overrides` and `support_grants` cascade with their business.
Admin notifications reuse `audit_events` + e-mail (no table).

## 2. Server modules (import map)

| Module | Exports (the ones the UI work needs) |
| --- | --- |
| `@/lib/admin/permissions` (pure, safe in any bundle) | `PERMISSIONS`, `PLATFORM_ROLES`, `can(principal, permission, { grant?, env? })`, `roleCan`, `adminRoleOf`, `permissionMatrix()`, `SUPPORT_WRITE_SCOPE`, `SUPPORT_WRITE_MS` |
| `@/lib/admin/plan-catalog` (pure) | `planRow`, `allPlanRows`, `isCompedPlan`, `planAllows(plan, feature)`, `planMaxLocations`, `PLAN_FEATURES` |
| `@/lib/admin/guard` | `guardAdminRoute(req, { permission, write?, rate?, business_id?, frozenBlocks? })`, `readBody`, `adminFail`, `int` |
| `@/lib/admin/settings-store` | `applyChanges`, `previewChanges`, `confirmationPhrase`, `describeSettings`, `secretInfo`, `setSecret`, `removeSecret`, `listChangeSets`, `getChangeSet`, `rollbackChangeSet`, `exportSettings`, `planImport`, `importSettings`, `freezeState`, `setFrozen`, `assertSettingsWritable`, `auditValue`, `SettingsError`, `actorFromPrincipal` |
| `@/lib/admin/loader` | `bootSettings`, `refreshNow`, `pollOnce`, `startSettingsPoll`, `stopSettingsLoader`, `settingsHealth`, `loaderStatus`, `appliedVersion`, `snapshotNow` |
| `@/lib/admin/crypto` | `encryptSetting`, `decryptSetting`, `masterKeys`, `fingerprintOf`, `settingMac`, `verifySettingMac`, `kidOf`, `needsReencrypt` |
| `@/lib/admin/rotation` | `reencryptAll`, `reencryptStatus`, `keyInfo` |
| `@/lib/admin/plans` | `listPlans`, `getPlan`, `createPlan`, `updatePlan`, `setPlanArchived`, `deletePlan`, `validatePlanInput` |
| `@/lib/admin/tenant-overrides` | `listTenantKnobs`, `setTenantOverride`, `removeTenantOverride`, `tenantEffective(businessId, key)`, `effectiveFor`, `validateOverride`, `boundsOf`, `quietIsStricter` |
| `@/lib/admin/tenants` | `listTenants`, `getTenantDetail`, `suspendBusiness`, `reactivateBusiness` |
| `@/lib/admin/support` | `enterSupportWrite`, `exitSupportWrite`, `activeSupportGrant` |
| `@/lib/admin/admins` | `listAdmins`, `inviteAdmin`, `setAdminDisabled`, `revokeAdminUserSessions`, `resetAdminTwoFactor`, `changeAdminRole` |
| `@/lib/admin/legal` | `listLegalPages`, `getLegalVersion`, `getPublishedLegal(slug, locale)` (English fallback), `saveLegalDraft`, `publishLegal`, `discardLegalDraft` |
| `@/lib/admin/job-runs` | `withJobRun`, `recordJobRun`, `listJobRuns`, `pruneJobRuns` (wired in `runJob`; nothing else needs calling) |
| `@/lib/admin/audit-search` | `searchAudit`, `auditCsv`, `csvCell` |
| `@/lib/admin/selftest` | `selftest()` |
| `@/lib/admin/notify` | `notifyAdmins`, `adminRecipients` |
| `@/lib/admin/ssrf` | `assertPublicSmtpTarget`, `isPrivateAddress` |
| `@/lib/config` (additions) | `acceptedSecrets(key)`, `verifierSecrets(key, primary)`, `envFromSnapshot`, `pinnedByEnv(name)` |

Runtime wiring: `instrumentation.ts register()` calls `bootSettings()` (awaits the first load, 10 s timeout) BEFORE the banner and the job runner; `/api/health` answers 503 `settings_not_loaded` /
`secret_canary_failed`; `runJob` records every run; the hourly cleanup job prunes console tables; `smsCapFor` & co read the plan catalog; `checkCallAllowed` / `reserveSms` / `isProvisioningAllowed` honour suspension;
the Twilio, ElevenLabs (signature and tool secret) and Stripe (both) verifiers accept the previous secret for 15 minutes after a console rotation.

## 3. Permissions and roles

Roles: `owner` (everything), `ops` (day to day: normal + sensitive settings, plans, tenants, jobs, legal drafts; no secrets, critical settings, import, admin management, publishing legal pages, unfreezing),
`support` (read only + the support view + a time boxed write mode), `read_only` (reads; secret metadata hidden), and the `bearer` class (the break-glass `ADMIN_TOKEN` and its cookie session: recovery only).
An admin user without a platform role is treated as `read_only`.

| Permission | owner | ops | support | read_only | Bearer token | Bearer + ADMIN_TOKEN_ALLOW_SETTINGS |
| --- | --- | --- | --- | --- | --- | --- |
| `settings.read` | yes | yes | yes | yes | yes | yes |
| `settings.export` | yes | yes | yes | yes | yes | yes |
| `settings.write` | yes | yes | - | - | - | yes |
| `settings.write.critical` | yes | - | - | - | - | yes |
| `settings.secrets.write` | yes | - | - | - | - | yes |
| `settings.import` | yes | - | - | - | - | yes |
| `settings.rollback` | yes | yes | - | - | yes | yes |
| `settings.rollback.critical` | yes | - | - | - | yes | yes |
| `settings.freeze` | yes | yes | - | - | yes | yes |
| `settings.unfreeze` | yes | - | - | - | yes | yes |
| `plans.read` | yes | yes | yes | yes | yes | yes |
| `plans.write` | yes | yes | - | - | - | - |
| `legal.read` | yes | yes | yes | yes | yes | yes |
| `legal.write` | yes | yes | - | - | - | - |
| `legal.publish` | yes | - | - | - | - | - |
| `tenants.read` | yes | yes | yes | yes | yes | yes |
| `tenants.billing` | yes | yes | - | - | yes | yes |
| `tenants.suspend` | yes | yes | - | - | - | - |
| `tenants.overrides.write` | yes | yes | - | - | - | - |
| `tenants.users.create` | yes | yes | - | - | yes | yes |
| `tenants.release` | yes | yes | - | - | yes | yes |
| `tenants.support_enter` | yes | yes | yes | - | - | - |
| `jobs.read` | yes | yes | yes | yes | yes | yes |
| `jobs.run` | yes | yes | - | - | yes | yes |
| `retention.run` | yes | yes | - | - | yes | yes |
| `providers.repair` | yes | yes | - | - | yes | yes |
| `providers.resync` | yes | yes | - | - | yes | yes |
| `selftest.read` | yes | yes | yes | yes | yes | yes |
| `system.read` | yes | yes | yes | yes | yes | yes |
| `audit.read` | yes | yes | yes | yes | yes | yes |
| `audit.export` | yes | yes | - | - | - | - |
| `admins.read` | yes | yes | - | yes | yes | yes |
| `admins.manage` | yes | - | - | - | - | - |
| `admins.recover` | yes | - | - | - | yes | yes |
| `admins.role` | yes | - | - | - | - | - |

Notes: a support user additionally holds `tenants.overrides.write` WHILE a support grant for that tenant is open (`SUPPORT_WRITE_SCOPE`, nothing else). A `read_only` / `support` caller never sees secret
metadata (fingerprint, last 4, who, when): only `set` and `source`. A tenant owner never reaches `/api/admin/*` (403).

Every `/api/admin/*` handler runs `guardAdminRoute`: authenticate (credential, same-origin CSRF for cookie writes, 2FA enrolment, role admin) -> permission -> rate limit (per client, per route name) -> step-up
for writes (`reauth_required`, 5 minutes, cookie credentials; the Bearer passes) -> freeze (`settings_frozen`) -> Bearer notice. While the console loader runs in a process, **2FA is forced for every admin**
(`403 2fa_enrollment_required`; `REQUIRE_2FA_FOR_ADMINS` can only force it ON).

## 4. Semantics

### 4.1 Precedence and sources
`env pin > console value > registry default` (D1). A key is pinned when its environment variable is non-empty. `source` in the listing is `env | console | default`; `locked` is true for a pin. A write to a
pinned key answers `409 locked_by_env`. A console value written before a pin is kept (shown as `console_value`) but never applies while the pin exists. Env-only names (`DATABASE_URL`, `APP_URL`, ...) are not registry
keys: `422 env_only`. The security-loosening switches (`SIGNUP_ALLOW_WITHOUT_CAPTCHA`, `REQUIRE_2FA_FOR_ADMINS`, `LOG_PII`) are not registry keys at all, so the console can neither tighten nor loosen them (stricter
than "tighten only"); `REQUIRE_2FA_FOR_ADMINS` is forced ON while the console runs. Registry ratchet keys (`tighten_only_in_ui`: session lifetimes, step-up window, password minimum, signup cap) may only move the safe
way: `422 ratchet_violation`, also for "reset to default" and for a rollback that would loosen; a database row that loosens them is ignored at load.

### 4.2 Tiers, reason, confirmation
| Tier | Console write needs |
| --- | --- |
| normal | step-up (5 min) |
| sensitive | + `reason` (8 to 500 chars) |
| critical (all secrets, billing enforcement, country lists, deny area codes, unverified booking SMS, retention / tenant-release jobs, email channel, credential pairs) | + `confirm` = the exact phrase from the preview (`requires.confirm`: the key itself for one key, `apply N critical settings` for several) + every admin and `ALERT_EMAIL` is mailed (through the transport active BEFORE the change) |
The tier of a change set is the highest tier of its keys. A rollback always needs a reason. `previewChanges` / `POST /settings/preview` returns `{ tier, version, changes[], requires: { reason, confirm, step_up, notify_admins } }`;
pass `version` back as `expected_version` (`409 stale_preview` when settings changed in between). The impact preview of 24e (counts of affected tenants) is not computed here: `changes[].applies` / `follow_up` say what the
change needs afterwards (`resync_agents`, `repair_numbers`, restart).

### 4.3 Credential pairs
A key with `pairedWith` must travel with its partners in the SAME change set (`409 pair_required`), unless the partner is pinned by the environment. Rotating only one half is done by sending both (the unchanged value
counts as present). `PUT /secrets/{key}` takes the partners in `paired`.

### 4.4 Secrets (T4, T5, T10, T14)
Write-only. `secret` plaintext in, `{ set, source, fingerprint (sha256[0..8]), last4 (only for secrets of 16+ characters) }` out; no function, route, audit row, revision, export, notification, log line or snapshot inspection
returns the value (`redactSecrets` masks configured secrets of 8+ characters in logs). At rest: envelope `v2.<kid>.<iv>.<tag>.<ct>`, AES-256-GCM, key = HKDF-SHA256(`APP_SECRET_KEY`, info `rc/settings/v1`), AAD =
`setting:<key>` (a ciphertext cannot be moved to another key), `kid` = base64url(sha256(derived key))[0..8]. `APP_SECRET_KEY_PREVIOUS` decrypts old envelopes and verifies old MACs during a rotation; new writes always use the
current key. Replacing a secret keeps the old value (a) in `platform_settings.previous_envelope` for the **15 minute dual-secret window** (`acceptedSecrets(key)` / `verifierSecrets(key, primary)`: Twilio signature, both Stripe
webhooks, the ElevenLabs HMAC and the tool secret accept current AND previous; an environment pin has no window) and (b) in the revision `prev_envelope` for **7 days** (rollback; nulled by the cleanup job).
`ApplyOptions.verifySecret(key, plaintext)` is the Phase 4 test-connection hook (a `false` is `422 verification_failed`). SMTP: `email.smtp_host` / `smtp_port` / `smtp_url` are checked at save (public address only, ports 25 / 465 /
587 / 2525, DNS resolved: `422 smtp_target_refused`) and again at every connect (not for an environment-pinned relay). Provider API base URLs are never settings.

### 4.5 Integrity, boot, propagation, health (T6, T11, T12)
Every row carries `HMAC(key | value-or-envelope | version)` (key derived from `APP_SECRET_KEY`, `rc/settings-mac/v1`). The loader ignores a row with a bad MAC, an undecryptable secret, an invalid value, an unknown key, an
env-only key or a ratchet loosening: that key falls back to the environment pin or the default, `settings.integrity_failure` is audited and every admin is mailed once per process and version. Boot: first load awaited (10 s) in
`register()`; `/api/health` is 503 `settings_not_loaded` until a load succeeded while console rows exist; a canary row (decrypts to a constant) fails health with `secret_canary_failed` when the master key is wrong.
After a successful load the last known good snapshot is kept for ever (a failing reload never falls back to env / defaults). Every 10 s each instance reads `settings_state.global_version` (one row) and reloads when it
changed; the writer refreshes at once; each instance upserts its applied version into `instance_heartbeats` (`GET /api/admin/system`: `applied.instances_current / instances_alive`).

### 4.6 Rotation of APP_SECRET_KEY
1. new key in `APP_SECRET_KEY`, old key in `APP_SECRET_KEY_PREVIOUS`, restart (everything still decrypts); 2. `POST /api/admin/secrets/reencrypt { reason }` until `done: true` (console secrets + MACs + retained previous
envelopes + canary in one transaction; TOTP secrets and Google calendar tokens in batches via `next_cursor`); 3. remove `APP_SECRET_KEY_PREVIOUS`. `GET /api/admin/system` shows `needs_reencrypt`.

### 4.7 Freeze, Bearer, notifications
`SETTINGS_FREEZE=true` (env) or the database flag (`POST /settings/freeze`, owner / ops / token to freeze, owner / token to unfreeze) turns every console write into `403 settings_frozen`; reads and the freeze toggle itself work;
the env freeze cannot be lifted by any API. The Bearer token: reads, `settings.freeze` / `unfreeze`, rollback (incl. critical), `admins.recover` (create an admin with a password or an invite, re-enable an admin, revoke sessions), and the
operator routes that existed before (billing override, users, release tenant, repair numbers, resync agents, jobs run, retention); NOT settings, secrets, import, plans, legal, suspension, overrides, roles, support mode, unless
`ADMIN_TOKEN_ALLOW_SETTINGS=true` (settings, secrets, critical, import only). Every Bearer use writes an `admin.bearer_use` audit row and mails every admin (at most once a minute per route). Notifications go to every enabled
admin user, `ALERT_EMAIL` and the registry `platform.alert_recipients`; a failed mail is audited (`admin.notify_failed`) and never undoes the change.

### 4.8 Rollback, export, import
`rollbackChangeSet` applies the inverse as a NEW change set (`via: rollback`, `rollback_of`), marks the original `rolled_back` (unless a key subset was rolled back). Refused with `409 superseded` when a key changed again,
`409 secret_rollback_expired` after 7 days, `409 not_rollbackable` when not `applied`. Export: console-held NON-secret settings, plans and secret fingerprints (`schema_version: 1`). Import: a dry run returns the diff per
key (`set | noop | skip` with `locked_by_env`, `secret_not_importable`, `unknown_key`, `invalid_value`) and the plan diff; `apply: true` writes ONE change set (+ plan upserts in the same transaction, `plans.write` needed);
secrets in a document are ignored with a warning.

### 4.9 Plans, overrides, suspension, support mode
* Caps: business override > environment pin of `PLAN_*` / `FORWARD_MINUTES_CAP` / `VOICEMAIL_MINUTES_CAP` > plan row > platform setting > default; trial caps still bound the plan (`min`). With no catalog loaded or a NULL cap behaviour equals today's.
  Features: `planAllows(plan, feature)` (a missing feature is ON). `isCompedPlan` comes from the catalog (`COMP_PLANS` is the fallback for a plan without a row). Wiring beyond caps and comp (entitlement gates in the call / owner / calendar code,
  `max_locations`, Stripe price ids per plan) is for the feature owners: the helpers exist.
* Overrides: `effective(tenant, key) = clamp(override ?? platform_effective, min, max)` (`tenantEffective`, `effectiveFor`). Owners write only registry `editableBy: 'owner'` keys (quiet hours stricter than the platform window, briefing on / off and hour,
  thank-you toggle, ring seconds within bounds); a platform-only key from the owner route is `403 platform_only`. Out of range `422 out_of_bounds`; looser quiet hours `422 not_stricter`. Reads clamp / ignore a stored value that is no longer valid
  (`ignored_override`). `envPinBlocksOverrides` keys 409 while pinned. NO consumer reads `tenantEffective` yet: wiring each knob into its reader is per-feature work (the registry lists `codeRef` for each).
* Suspension: out of service for calls (the existing out-of-service line), no texts, no provisioning, whatever the billing state, even with `BILLING_ENFORCED` off. Owners can still sign in. Reactivation clears it. Audited `tenant.suspended` / `tenant.reactivated` with the business id.
* Support mode: `POST /tenants/{id}/support-mode { reason }` -> 30 minute grant for that tenant, step-up; `DELETE` ends it; enter / exit / every override write are audited with `business_id`, `support_grant_id`, `role`.

### 4.10 Audit
`settings.change` / `settings.rollback` (business null; `meta`: `change_set_id`, `version`, `tier`, `reason`, `via`, `role`, `keys[]` with `old`/`new` for plain values (long text cut, URL credentials stripped) and `old_fp`/`new_fp` for secrets): redaction is BY KIND
(`auditValue`), the rows bypass `sanitizeAuditMeta` through `recordAudit({ meta_trusted: true })`. Other actions: `settings.tenant_override[_removed]`, `settings.freeze` / `unfreeze`, `settings.export`, `settings.reencrypt`, `settings.integrity_failure`,
`plans.create|update|archive|unarchive|delete`, `legal.draft_saved|draft_discarded|published`, `tenant.suspended|reactivated`, `support.write_mode_entered|exited`, `admin.invited|disabled|enabled|sessions_revoked|two_factor_reset|role_changed`, `admin.bearer_use`,
`admin.notify_failed`, `audit.export`, `plans.migrated`. The pre-existing routes keep their actions.

## 5. Routes

All JSON `{ ok, data }` / `{ ok: false, error, code?, problems?[{ key, code, message }] }`. Every route: same-origin CSRF (cookie writes), authn, permission, rate limit, step-up on writes, audit. `Bearer` = allowed for the token.

| Method + path | Permission | Notes |
| --- | --- | --- |
| `GET /api/admin/me` | `settings.read` | `{ role, via, user, permissions[], frozen, reveal_secret_meta }` |
| `GET /api/admin/system` | `system.read` | loader status, key ids, re-encrypt status, instances + `applied` counts, `env_locked_keys` |
| `GET /api/admin/selftest` | `selftest.read` | provider readiness cards, no secret, `tested:false` |
| `GET /api/admin/settings` | `settings.read` | registry + effective value + source + lock + schema + secret metadata + `version` + `frozen` |
| `POST /api/admin/settings/preview` | `settings.read` | `{ changes }` -> `Preview`; writes nothing |
| `POST /api/admin/settings/apply` | `settings.write` / `.critical` / `settings.secrets.write` (per key) | `{ changes, reason?, confirm?, expected_version?, dry_run? }` |
| `GET /api/admin/settings/history`, `/history/{id}` | `settings.read` | `?limit&before=<version>&key=` |
| `POST /api/admin/settings/rollback` | `settings.rollback` (+ `.critical`) | `{ change_set_id, reason, confirm?, keys? }`; Bearer ok |
| `GET /api/admin/settings/export` | `settings.export` | audited |
| `POST /api/admin/settings/import` | `settings.read` (dry run) / `settings.import` (apply) | `{ document, apply?, reason?, confirm? }` |
| `GET, POST /api/admin/settings/freeze` | `settings.read` / `settings.freeze` or `.unfreeze` | `{ frozen, reason }`; Bearer ok |
| `GET, PUT, DELETE /api/admin/secrets/{key}` | `settings.read` / `settings.secrets.write` | PUT `{ value, reason, confirm, paired? }`; DELETE `{ reason, confirm }` |
| `GET, POST /api/admin/secrets/reencrypt` | `system.read` / `settings.secrets.write` | POST `{ reason, cursor? }` |
| `GET, POST /api/admin/plans`; `GET, PATCH, DELETE /api/admin/plans/{key}` | `plans.read` / `plans.write` | writes need `reason`; PATCH `archived: true|false`; DELETE only unused, never `standard` |
| `GET /api/admin/tenants` | `tenants.read` | `?q&status&billing_status&plan&suspended&comped&past_due&trial_ending_days&limit&cursor` |
| `GET /api/admin/tenants/{id}` | `tenants.read` | support view (read only) |
| `POST /api/admin/tenants/{id}/suspend`, `/reactivate` | `tenants.suspend` | `{ reason }` |
| `POST, DELETE /api/admin/tenants/{id}/support-mode` | `tenants.support_enter` | `{ reason }`; needs a personal account |
| `GET, PUT, DELETE /api/admin/tenant-overrides` | `tenants.read` / `tenants.overrides.write` (support: with a grant) | `?business_id=` ; body `{ business_id, key, value?, reason? }` |
| `GET, PUT, DELETE /api/businesses/{id}/settings-overrides` | tenant owner of that business | comfort knobs only; PUT `{ key, value }`, DELETE `{ key }`; step-up; admins get 403 |
| `GET /api/admin/legal`; `GET, PUT, DELETE /api/admin/legal/{slug}/{locale}`; `POST .../publish` | `legal.read` / `legal.write` / `legal.publish` | `?version=N`; PUT `{ body, note? }`; publish `{ reason }` |
| `GET, POST /api/admin/admins`; `PATCH /api/admin/admins/{id}`; `DELETE .../sessions`, `.../two-factor` | `admins.read` / `admins.manage` or `admins.recover` / `admins.role` / `admins.recover` / `admins.manage` | POST `{ email, platform_role, password? }`; PATCH `{ disabled?, platform_role? }` |
| `GET /api/admin/job-runs` | `jobs.read` | `?job&status&trigger&dry_run&before&limit` |
| `GET /api/admin/audit` | `audit.read`; with `export=1&format=csv|json` `audit.export` | `?actor&action(prefix.)&business_id&from&to&q&before&limit`; export audited, 6 per minute, CSV formula-hardened |
| `GET /api/admin/jobs`, `POST /api/admin/jobs/run` | `jobs.read` / `jobs.run` | existing; runs recorded with `trigger: manual` |
| `POST /api/admin/billing` | `tenants.billing` | existing |
| `POST /api/admin/users` | `tenants.users.create` | existing |
| `POST /api/admin/release-tenant` | `tenants.release` | existing |
| `POST /api/admin/repair-numbers` | `providers.repair` | existing |
| `POST /api/admin/resync-agents` | `providers.resync` | existing |
| `POST /api/admin/retention` | `retention.run` | existing |

Error codes (HTTP): `unknown_key` 422, `env_only` 422, `invalid_value` 422, `duplicate_key` 422, `use_secret_field` 422, `nothing_to_change` 422, `reason_required` 422, `confirmation_required` 422, `ratchet_violation` 422,
`out_of_bounds` 422, `not_stricter` 422, `smtp_target_refused` 422, `verification_failed` 422, `invalid_body` 422 / 400, `locked_by_env` 409, `pair_required` 409, `stale_preview` 409, `superseded` 409, `secret_rollback_expired` 409,
`not_rollbackable` 409, `exists` 409, `in_use` 409, `protected_plan` 409, `last_owner` 409, `self` 409, `already_suspended` 409, `not_suspended` 409, `no_draft` 409, `forbidden` 403, `platform_only` 403, `support_write_required` 403, `settings_frozen` 403,
`reauth_required` 403, `2fa_enrollment_required` 403, `not_found` 404, `not_tenant_key` 404.

## 6. Environment variables (all env-only; see `docs/env-vars.md`)
`SETTINGS_FREEZE`, `ADMIN_TOKEN_ALLOW_SETTINGS`, `ALERT_EMAIL`, `APP_SECRET_KEY_PREVIOUS`, `BUILD_SHA` (informational). `APP_SECRET_KEY` is now also the root of the settings key and MAC key.

## 7. Phase 3 checklist (what the UI can rely on)
* Forms: one widget per `kind`, constraints from `schema` (`type`, `min`, `max`, `values`, ...), the source badge from `source`, "locked by environment" from `locked`, the `applies` / `follow_up` notes, `tier` for the confirm dialog.
* Staged edits -> `POST /settings/preview` -> show `requires` -> `POST /settings/apply` with the phrase. Secrets: a write-only field, `PUT /secrets/{key}`, show `fingerprint` / `last4`.
* Hide what the role cannot do: `GET /api/admin/me` returns `permissions[]`; the server enforces anyway.
* Step-up: a `403 reauth_required` means open the re-authentication dialog (`POST /api/auth/reauth`) and retry.
* Pages not served by this phase: the legal pages for the public (`getPublishedLegal` is ready), the maintenance / announcement banner (registry keys `platform.maintenance_mode`, `platform.announcement`), brand fields in templates.

## 8. Residuals (honest list)
* No test-connection yet (Phase 4): `selftest` reports configuration only; `verifySecret` is the hook. A wrong credential saved from the console is only caught by the operator's own check, then rollback.
* Tenant override consumers: the overrides are stored, validated and clamped, but the individual readers (quiet hours, briefing hour, ring seconds, thank-you) still read the platform value; `tenantEffective` is the function to call.
* Per-plan feature gates and `max_locations` are data only; `stripe_price_id*` per plan is not read by checkout (the environment / registry price ids still are).
* The write path of a dual-secret window protects verifiers only; the ElevenLabs tool secret rotation still needs "re-sync agents" (the registry marks it).
* Approval flows (`pending_approval`, `scheduled`) have columns and statuses, no code.
* Environment-pinned secrets cannot be tested or rotated from the console (by design).
* `instance_heartbeats` are best effort (30 s); an instance that crashed shows as not alive after 90 s.
* Impact preview counts (tenants over a lowered cap, owner phones invalidated by narrowing countries) are not computed.
* Loader memory: all console rows (about 170 at most) and the plan catalog are held in memory per instance.
