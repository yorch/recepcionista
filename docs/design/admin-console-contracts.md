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
| Phase 4 real connection tests behind `selftest` and `verifySecret`, the ElevenLabs provisioning that stores the webhook secret, price-copy removal of `NEXT_PUBLIC_*` (Phase 6, done by agent D) | later | hooks exist: `ApplyOptions.verifySecret`, `ProviderReadiness.tested` |

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
| `businesses.plan` -> `plans.key` | FK `ON UPDATE CASCADE ON DELETE RESTRICT` | a BEFORE trigger registers an unknown plan string as a hidden, non-comped, cap-less plan (so Stripe webhooks, scripts and tests that store a free string keep working). Existing unknown strings are REGISTERED the same way (hidden, non-comped, NULL caps) and keep their value; they are NOT remapped to the comped `legacy` (a tenant on `BILLING_PLAN_NAME` other than `standard` must not become comped and unreleasable). One audit row `plans.registered` (`meta.plan`, `meta.businesses`) per registered plan |
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

Notes: a support user additionally holds `tenants.overrides.write` WHILE a support grant for that tenant is open (`SUPPORT_WRITE_SCOPE`, nothing else; see 4.9: no tenant route is open to the support role in write mode). Only an `owner` sees secret
metadata (fingerprint, last 4, who, when); ops, support, read_only and the Bearer token see `set` and `source` only. Creating a tenant (`POST /api/businesses`) needs `tenants.users.create` and provisioning one (`POST /api/businesses/{id}/provision` by an admin) needs `providers.repair` plus a fresh sign-in (step-up): owner, ops and the Bearer token hold both; `read_only` and `support` neither. A tenant owner never reaches `/api/admin/*` (403).

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
Write-only. `secret` plaintext in, `{ set, source, fingerprint (HMAC-SHA256[0..8] under an HKDF-derived key; owner only), last4 (only for secrets of 16+ characters) }` out; no function, route, audit row, revision, export, notification, log line or snapshot inspection
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
* Caps, most specific first: the per-business `*_cap_override` COLUMN (an explicit admin action on this business; no trial bound) > the TENANT override of `billing.plan_sms_cap` / `billing.plan_call_minutes_cap` / `forward.minutes_cap` / `voicemail.minutes_cap` (validated and clamped at read time, replaces the plan allowance) > environment pin of `PLAN_*` / `FORWARD_MINUTES_CAP` / `VOICEMAIL_MINUTES_CAP` > plan row > platform setting > default; trial caps still bound the plan allowance (`min`), the tenant override included. `limits.max_businesses_per_user` is per account: the STRICTEST effective value among the businesses the account owns applies. With no catalog loaded or a NULL cap behaviour equals today's.
  Features: `planAllows(plan, feature)` (a missing feature is ON). `isCompedPlan` comes from the catalog (`COMP_PLANS` is the fallback for a plan without a row). Every feature in `PLAN_FEATURES` is gated, `voicemail` and `call_forwarding` included (see the entitlements table).
* Overrides: `effective(tenant, key) = clamp(override ?? platform_effective, min, max)` (`tenantEffective`, `effectiveFor`). Owners write only registry `editableBy: 'owner'` keys (quiet hours stricter than the platform window, briefing on / off and hour,
  thank-you toggle, ring seconds within bounds); a platform-only key from the owner route is `403 platform_only`. Out of range `422 out_of_bounds`; looser quiet hours `422 not_stricter`. Reads clamp / ignore a stored value that is no longer valid
  (`ignored_override`). `envPinBlocksOverrides` keys 409 while pinned. An owner-editable BOOLEAN (`jobs.briefing_enabled`, `jobs.gratitude_enabled`) is `platform && override`: an owner can switch a feature off, never on when the platform has it off (the write is `422 not_stricter`, a stored `true` is ignored at read). The pure half lives in `tenant-effective.ts` (no database), the readers in `tenant-knobs.ts` and `db/usage.ts`.
* Suspension: out of service for calls (the existing out-of-service line), no texts, no provisioning, whatever the billing state, even with `BILLING_ENFORCED` off. Owners can still sign in. Reactivation clears it. Audited `tenant.suspended` / `tenant.reactivated` with the business id.
* Support mode: `POST /tenants/{id}/support-mode { reason }` -> 30 minute grant for that tenant, step-up; `DELETE` ends it; enter / exit / every override write are audited with `business_id`, `support_grant_id`, `role`.
* Typed confirmations are enforced by the SERVER (`src/lib/admin/confirm.ts`, body field `confirm`, 422 `confirmation_required`; reason 422 `reason_required`): suspend `suspend <business name>` (or `suspender ...`), a real release `release <business name>` / `liberar ...` + reason, a 2FA reset the administrator's e-mail address + reason, a critical job run (`retention`, `tenant_release`, `grandfather`) `run <job>` + reason, a legal publish `publish <slug>/<locale>` + reason. Lower case, extra spaces and either language's verb are accepted. The Bearer token (a script, audited and mailed per use) types nothing; dry runs need nothing.
* Legal publish names the reviewed draft: `{ reason, confirm, version, hash }` where `hash` is the sha256 of the draft body returned by the draft routes. A draft edited after the review is `409 draft_changed`; a missing version / hash `422 review_required`.
* The Bearer token creates an `owner` administrator only when no enabled owner exists (lock-out recovery) or `ADMIN_TOKEN_ALLOW_SETTINGS=true` (`403 owner_requires_owner`); it still creates / re-enables the other roles and revokes sessions. `POST /api/admin/users` (a tenant login with an admin-chosen password) needs an owner administrator or the token (`403 owner_required`); ops invites the person instead. Both are audited (`login_set_by_admin`).
* Secret fingerprints are the first 8 hex characters of an HMAC-SHA256 of the plaintext under a third HKDF-derived key (`rc/settings-fp/v1`), never the bare sha256; a value stored before keeps its old fingerprint until the secret is next written or re-encrypted (the master key is part of the derivation, so a rotation recomputes it). The MAC of a secret row covers `previousEnvelope` and `previousUntil` (a row MACed before that is loaded for its current secret only, its previous envelope is ignored, and the re-encryption pass re-signs it).

### 4.10 Audit
`settings.change` / `settings.rollback` (business null; `meta`: `change_set_id`, `version`, `tier`, `reason`, `via`, `role`, `keys[]` with `old`/`new` for plain values (long text cut, URL credentials stripped) and `old_fp`/`new_fp` for secrets): redaction is BY KIND
(`auditValue`), the rows bypass `sanitizeAuditMeta` through `recordAudit({ meta_trusted: true })`. Other actions: `settings.tenant_override[_removed]`, `settings.freeze` / `unfreeze`, `settings.export`, `settings.reencrypt`, `settings.integrity_failure`,
`plans.create|update|archive|unarchive|delete`, `legal.draft_saved|draft_discarded|published`, `tenant.suspended|reactivated`, `support.write_mode_entered|exited`, `admin.invited|disabled|enabled|sessions_revoked|two_factor_reset|role_changed`, `admin.bearer_use`,
`admin.notify_failed`, `audit.export`, `plans.registered`. The pre-existing routes keep their actions.

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
* Tenant overrides, plan feature gates and `max_locations` are wired (sections 4.9, Agent C); `stripe_price_id*` per plan is read by checkout (Agent C).
* The write path of a dual-secret window protects verifiers only; the ElevenLabs tool secret rotation still needs "re-sync agents" (the registry marks it).
* Approval flows (`pending_approval`, `scheduled`) have columns and statuses, no code.
* Environment-pinned secrets cannot be tested or rotated from the console (by design).
* `instance_heartbeats` are best effort (30 s); an instance that crashed shows as not alive after 90 s.
* Impact preview counts (tenants over a lowered cap, owner phones invalidated by narrowing countries) are not computed.
* Loader memory: all console rows (about 170 at most) and the plan catalog are held in memory per instance.

## Agent B: providers and secrets (real connection tests, the `/admin/providers` page)

Files: `src/lib/admin/provider-tests.ts` (server), `provider-meta.ts` and `provider-ui.ts` (pure, client-safe), `provider-provision.ts`; routes `src/app/api/admin/providers/route.ts`, `.../providers/[provider]/test/route.ts`; page `src/app/admin/providers/page.tsx`,
components `src/components/admin/provider-{api,console,card,field,followup,rotation,test-result}`, `secret-field.tsx`; catalog `src/lib/i18n/catalog/adminProviders.ts` (prefix `ap.`). Tests: `tests/admin-providers-pure.test.ts`, `tests/admin-providers-ui.test.tsx`, `tests/integration/admin-providers.test.ts`.

### Connection tests (`provider-tests.ts`)
`testProvider(provider, { candidate? })` with `provider` in `twilio | elevenlabs | stripe | openai | anthropic | resend | smtp | google | turnstile`. A candidate is `{ "<registry key>": "<plaintext>" }`; every key not in it comes from the effective configuration (so a pair can be tested with the sid already stored).
Result: `{ provider, outcome: ok | auth_failed | unreachable | misconfigured, tested_at, ms, scope: 'remote', checks?: { name: ok | failed | not_found | skipped }, livemode?, mode_changed?, account_changed?, orphaned_businesses? }`. Nothing else: no remote banner, status text or body, no credential.

| Provider | Request (base URL hard-coded) | Reading |
| --- | --- | --- |
| twilio | `GET api.twilio.com/2010-04-01/Accounts/{sid}.json` (basic auth); with a Messaging Service `GET messaging.twilio.com/v1/Services/{MG}` | 200 + `active` ok; 401 / 404 auth_failed; suspended or missing service misconfigured |
| elevenlabs | `GET api.elevenlabs.io/v1/user` | 401 auth_failed; 401 `missing_permissions` misconfigured |
| stripe | `GET api.stripe.com/v1/balance`; price ids `GET /v1/prices/{id}`; for a candidate against a current key also `GET /v1/account` with both | mode of the key, price exists / recurring / same mode; 403 (restricted key) misconfigured |
| openai / anthropic | `GET /v1/models` | the configured model must be listed |
| resend | `GET api.resend.com/domains` | the sender domain must be verified; `restricted_api_key` (send-only) is ok |
| smtp | DNS resolve, refuse private / loopback / link-local / metadata (`ssrf.ts`), then `nodemailer verify()` to the RESOLVED address (TLS name kept) | refused target misconfigured; login failure auth_failed |
| google | `POST oauth2.googleapis.com/token` with a garbage code | `invalid_client` auth_failed, `invalid_grant` ok |
| turnstile | `POST challenges.cloudflare.com/turnstile/v0/siteverify` with a garbage token | `invalid-input-secret` auth_failed |

All requests: `redirect: manual`, 8 s timeout, body capped at 256 KB. Test seam: `setProviderTestDeps({ fetch, resolve, smtpVerify, ... })`; without an injected transport, `NODE_ENV=test` runs do not verify (so no test leaves the machine).

### Routes
| Method + path | Permission | Notes |
| --- | --- | --- |
| `POST /api/admin/providers/{provider}/test` | `providers.repair` (ops, owner, Bearer) for the stored configuration; `settings.secrets.write` (owner) for `{ candidate }` | 6 per minute; candidate keys limited to the provider's own fields; `422 invalid_body / invalid_value`, `404 not_found` for an unknown provider |
| `GET /api/admin/providers` | `selftest.read` | `base_url`, `webhooks[] { id, card, path, url, secret_key, verifier_configured }`, `google_redirect`, `usage { numbers, agents, stripe_customers, messaging_service }`, `stripe_mode`, `follow_ups[] { action, pending, since, keys }` |
| `GET /api/admin/selftest?live=1[&force=1]` | `selftest.read` | adds `test` and `tested` per card; ops / owner refresh (cache 5 minutes per provider and credential set), other roles get the cache; without `live=1` unchanged (`tested:false`, no network) |
| `PUT /api/admin/secrets/{key}`, `POST /api/admin/settings/apply` | unchanged | now run `verifySecret` (test-before-save): `422 verification_failed` with `problems[]`; body flags `accept_unreachable`, `acknowledge_orphans`; `409 orphan_ack_required` (count in the message) for a Stripe key switch with `stripe_customer_id`s on file |

### Provisioning
`storeProvisionedWebhookSecret` (called by `POST /api/businesses/{id}/provision` right after the webhook is created): owner admin, key not pinned, console writable: stored as `elevenlabs.webhook_secret` (critical, audited, notification), response `webhook_secret_stored: true` and no `webhook_secret`. Any failure keeps the one-time display.

### Page behaviour
Cards from `provider-meta.ts` (`CARDS`); the keys on a card are exactly the secrets and provider ids plus the email group and `google.oauth_redirect_uri` (the rest of telephony / voice settings lives on agent A's settings pages: tested to be disjoint). Replace: test the candidate, preview (`/settings/preview` gives the reason / phrase
requirements), reason + typed phrase, `PUT /secrets/{key}` (step-up through the console's reauth panel); Remove: preview, reason + phrase, `DELETE`. Plain fields: edit / reset to default through preview and apply. Follow-up banners (`follow_ups`) open a runner that does a dry run over all batches, then the real run
(`next_cursor` loop, progress bar, stop after the current batch). The rotation panel reads `GET /api/admin/system` and loops `POST /api/admin/secrets/reencrypt`.

### For the Overview page (agent C)
Call `GET /api/admin/selftest?live=1` to show real provider status (each card has `test.outcome` and `tested`); the default call stays offline.


## Agent A: console shell, settings pages, history, system, overview, legal pages, branding, maintenance (Phase 3 UI, part 1)

Status: **built**. Tests: `tests/admin-console-ui.test.tsx` (pure model, safe markdown, diff, overview, move classification, maintenance, proxy, legal links, component server renders in EN and ES) and
`tests/integration/admin-console-ui.test.tsx` (postgres: adopt, legal end to end, banner). Smoke: a headless Chrome run over the real pages (settings edit -> review -> apply -> history -> rollback,
legal draft -> publish -> public page, move wizard, system, mobile widths) found no console error and no horizontal scroll.

### A.1 Files (ownership)
| Area | Files |
| --- | --- |
| Shell and gate | `src/app/admin/layout.tsx`, `src/lib/admin-ui/server.ts` (`requireAdminPage(permission?)`, `getAdminPageCtx`), `src/components/admin/{shell,provider,nav}.ts(x)` |
| Pages | `src/app/admin/{page,history,system,legal,move}/page.tsx`, `src/app/admin/settings/[page]/page.tsx` (`/admin/settings` redirects to `voice`) |
| Generated forms | `src/lib/admin-ui/model.ts` (page map, widget by kind, text <-> typed value, staging, field block), `src/lib/admin-ui/setting-text.ts` (Spanish label / help of every registry key), `src/components/admin/{settings-form,change-review,ui,errors,use-json}.ts(x)` |
| History, import / export | `src/components/admin/{history,import-export}.tsx` |
| System, overview, wizard | `src/components/admin/{system-page,overview,move-wizard}.tsx`, `src/lib/admin-ui/{overview,move}.ts` |
| Legal | `src/components/admin/legal-editor.tsx`, `src/lib/markdown.ts` (safe parser), `src/components/legal/{markdown-view,legal-document,footer-links,consent-line}.tsx`, `src/app/{terms,privacy,sms-terms}/page.tsx`, `src/lib/{legal-links,legal-footer}.ts`, `src/lib/text-diff.ts` |
| Notices | `src/components/platform-banner.tsx` (root layout), `src/lib/maintenance.ts` + one rule in `src/proxy.ts` |
| i18n | `src/lib/i18n/catalog/adminConsole.ts` (prefix `ac.`); registry label / help: English on the registry entry, Spanish in `setting-text.ts` |

Other console features add their pages to the SAME shell: one line in `src/components/admin/nav.ts` (`ADMIN_NAV`), a page under `src/app/admin/**` that calls `requireAdminPage(permission)`, and the client
components use `useAdmin()` (`me`, `can(permission)`, `guard(action)` for the step-up retry). Agent B's `/admin/providers` already does.

### A.2 The gate
`/admin/**` pages: the proxy only checks a credential is present (`/admin` and `/api/admin` are NOT in the public lists; a request without one is redirected to `/login?next=` or 401); the layout then calls
`getAdminPageCtx()`: the credential is validated against the database, a tenant owner / staff gets a **404** (the console is never advertised), an admin who still has to enrol in 2FA is redirected to the
security page by `getServerResolution` (the 2FA invariant), and the permissions list comes from `can()`. A page may demand one permission (`requireAdminPage('legal.read')`); the nav shows only what the role
holds; every write is enforced again by the API. CSP: no inline script, no external origin (nonce CSP unchanged).

### A.3 Generated settings pages (`/admin/settings/{voice,messaging,signup,data,billing,content,scheduling,jobs,locales}`)
* The page of a key is decided in `model.ts` (`KEY_PAGE` exceptions, then `GROUP_PAGE`); secrets, provider ids and the `email` / `calendar` / `payments` / `llm` groups belong to the provider cards (agent B) and
  are on no settings page. `tests/admin-console-ui.test.tsx` fails when a console-editable key is on no page (or on two), or lacks a Spanish text.
* Widget by kind: switch (bool), number (int, min / max / unit), select (enum), text / url / textarea (string, url), comma list or checkboxes (list, country_list; enum lists with up to 6 values), JSON (json).
  Text goes through the registry schema (`fromText`), the same validator the server applies; an EMPTY optional field (default unset) stages "reset to default".
* Every field shows its source badge (Default / Console / **Locked by environment** with the variable name), tier badge, `applies` note, range, default, ratchet direction ("can only be made stricter"), "Reset
  to default" (stages a `remove`) and "Undo change". A locked / read-only / frozen field is disabled with the reason in words. `beforeunload` guards unsaved drafts.
* Edits accumulate in a draft ("Staged changes: N"); **Review changes** calls `POST /settings/preview` (tier, `requires`, per-key before / after with the effective value, applies / follow-up notes), then asks
  for the reason (sensitive and critical) and the **typed confirmation phrase** (critical) and applies with `expected_version` (a `stale_preview` re-reviews). Step-up: a `403 reauth_required` opens the existing
  re-authentication panel and the action is retried once.

### A.4 History, export / import, system, overview
* `/admin/history`: change sets (filter by key, paging, status / tier / via, reason), per-key diff (secrets show fingerprints only), **rollback** as a new change set (reason always; critical sets also the typed phrase,
  permission `settings.rollback(.critical)`), export (download JSON) and import with the dry-run diff first (`locked_by_env`, secrets, unknown, invalid are shown as skipped), then reason + phrase (owner only).
* `/admin/system`: settings version, instances up to date, canary, keys locked by the environment (variable name and why), key ids, re-encryption state, loader problems, instance table with build SHA and applied
  version, the **freeze** toggle (owner / ops freeze, owner unfreezes, an environment freeze cannot be lifted), and the environment-only names.
* `/admin` (overview): provider readiness (from selftest; configuration only), job health (latest run per job and failures in 24 h), alerts the APIs can answer (provider incomplete, job errors, instance drift,
  canary / integrity / re-encryption, freeze), recent critical changes. Stuck deletions and SMS delivery failures have no API and are listed as "not monitored yet".

### A.5 "Move to console" and the `adopt` extension (the one backend change)
A pinned key answers `409 locked_by_env` to every write, so copying a value into the console while the variable exists was impossible. `POST /settings/preview` and `/settings/apply` now accept **`adopt: true`**:
for an environment-pinned NON-secret key it stores a console value that EQUALS the pinned value; any other value, a remove, or a secret is still `409 locked_by_env`. The row is dormant (the pin wins, shown as
`console_value` in the listing) until the variable is deleted; after the next restart the console serves it. The wizard (`/admin/move`) lists the pinned non-secret keys, copies the chosen ones as one change
set with the normal tier rules, and then lists the exact variable names that are safe to delete ("ready") and those where the console holds a different value ("differs"). Secrets are entered once in the provider cards.

### A.6 Legal pages
* Editor (`/admin/legal`): terms / privacy / sms_terms x en / es, markdown with a **live preview rendered by the same safe renderer as the public page**, one draft per page, version list (immutable), "load into
  editor", **line diff between any two versions**, publish (owner: reason + typed `publish <slug>/<locale>`), unpublished state explained.
* Safe markdown (`src/lib/markdown.ts`): headings, paragraphs, bold, italic, code, links, autolinks, lists, quotes, rules, fenced code. **No raw HTML ever** (it is text), no images, links only through `safeHref`
  (http, https, mailto, site paths, `#fragments`; whitespace, control characters, backslashes, `//`, entities and every other scheme are refused), external links `rel="noopener noreferrer nofollow"`; input and nesting are
  capped. React builds the elements; there is no `dangerouslySetInnerHTML`.
* Public pages `/terms`, `/privacy`, `/sms-terms` (public paths, in `robots.txt` and the sitemap only while published): the published version in the visitor's language (English when that language has none, with
  a notice), version and last-updated date. Unpublished: the not-found page.
* Links: `legalLinks()` = the `legal.*_url` setting if set, else the built-in page when a version is published, else nothing. Used by the landing and refunds footers, the legal pages' footer, the signup consent
  line, the account e-mails (verify / reset / invite: "Terms: <url>"; synchronous, so the built-in page appears once the 60 s published-pages cache is warm) and the SMS HELP reply ("Terms: <sms terms url>").

### A.7 Notices and maintenance
* `platform.announcement` and `platform.maintenance_mode` are shown by `PlatformBanner` (root layout, every page except `/admin`; plain text, escaped) and in the console shell. Freeze and maintenance banners are always visible
  in the console.
* **Read-only enforcement** (`src/lib/maintenance.ts`, one rule in `src/proxy.ts`): while the switch is on, a state-changing `/api/**` request made with a USER session cookie is refused with `503 { code: 'maintenance' }` and
  `Retry-After: 300`. Never refused: reads, `/api/admin/*`, `/api/auth/*`, `/api/me/locale`, the Bearer token, the break-glass cookie and every webhook / provider callback (no user cookie), so calls, texts and payments keep
  working. A DB admin working through the tenant dashboard is refused too (use the console, or switch maintenance off).

### A.8 Residuals (agent A)
* An unpublished legal page renders the not-found page with `noindex` but **status 200**: the root `loading.tsx` starts the stream before the page can call `notFound()` (Next 16 behaviour, same as `/pay/[id]`).
* Brand fields (`brand.name`, support contact, company address) are editable and stored but no template or error page reads them yet (each reader is per-feature work); only the legal links, the banners and the
  maintenance switch are consumed.
* The impact preview of 24e (counts of affected tenants) is not computed: the review shows tier, requirements and the applies / follow-up notes.
* The e-mail legal footer depends on a warm cache on that instance (see A.6); URL settings are always present.
* Provider cards link nowhere from the "move" page (secrets are described, not linked).

## Agent C: tenants, plans, administrators, support mode, entitlements and tenant knobs

Files: pages `src/app/admin/{tenants,tenants/[id],plans,admins}/page.tsx`; components `src/components/admin/{tenants-page,tenant-detail,tenant-billing,tenant-ops,tenant-overrides,tenant-support,tenant-audit,tenant-action,tenant-errors,tenant-api,plans-page,admins-page}`, the owner card
`src/components/dashboard/comfort-settings.tsx`, the dashboard banner `src/components/dashboard/support-banner.tsx`; catalog `src/lib/i18n/catalog/adminTenants.ts` (prefix `at.`, error codes `at.err.<code>`); server `src/lib/admin/{tenant-knobs,support-gate}.ts`;
routes `POST /api/admin/tenants/{id}/support-view`, `POST /api/admin/tenants/{id}/actions`, `GET /api/admin/plans/prices`. Tests: `tests/admin-tenants-pure.test.tsx`, `tests/integration/admin-tenants.test.ts`.

### Pages
* `/admin/tenants` (permission `tenants.read`): server-side search (name, id start, phone digits, agent id, Stripe customer id, owner e-mail), filters status / billing / plan / trial ending in 7 days / past due / comped / suspended, keyset "Load more", usage columns (texts, AI / forward / voicemail minutes of the latest month), table on desktop, cards on phones.
* `/admin/tenants/{id}`: tabs (arrow-key navigable): Overview (profile, provider ids READ ONLY, usage, closed dates, people), Billing and plan (status, plan from the plans table with its caps, trial end, paid-through / comp expiry, per-business cap overrides; only changed fields go to
  `POST /api/admin/billing` with the reason as `note`: replaces the raw curl), Status and operations (suspend / reactivate with reason + typed phrase `suspend <name>`; clear owner-phone verification; clear trial fingerprint; release / repair numbers / resync agent for THIS business: dry-run preview first, the real run asks for a reason, release also the typed phrase `release <name>`),
  Settings (the tenant override editor: platform value, effective value, bounds, owner-editable badge, reason note; `PUT / DELETE /api/admin/tenant-overrides`), Support, Audit (`GET /api/admin/audit?business_id=`, keyset).
* `/admin/plans` (`plans.read`; editing needs `plans.write`): cards with the LIVE Stripe price of each plan id (`GET /api/admin/plans/prices`, cached 10 min, fail soft "price unavailable"), caps, features, public / comped / archived; editor with all fields, reason (8+ chars), archive / restore, delete (only an unused non-standard plan).
* `/admin/admins` (`admins.read`): list with role, 2FA, disabled, sessions; invite (owner), role change (owner, never yourself), disable (owner, never yourself), enable and revoke sessions (owner / Bearer recovery), reset 2FA (owner, typed e-mail). The last enabled owner has its disable / role controls hidden and the server answers `409 last_owner`.
* Navigation: three entries added to `ADMIN_NAV` (`/admin/tenants`, `/admin/plans`, `/admin/admins`), each guarded by its permission.

### Support mode (no silent impersonation)
* The tenant dashboard shell's admin business switcher posts to `POST /api/admin/tenants/{id}/support-view` (permission `tenants.read`, audited `support.view_opened`, sets the `rc_business` UI cookie) and refreshes. The dashboard shows a banner: read-only by default; in write mode the countdown and an exit button.
  Every dashboard render by an admin user writes at most one `support.view` audit row per admin and tenant per 15 minutes (per process).
* **The write gate** (`src/lib/admin/support-gate.ts`, called from `authenticate()` in `src/lib/session.ts`, plus the resolution points in `session.ts`): an admin USER (personal account) sending a POST / PUT / PATCH / DELETE to any route outside `/api/admin`, `/api/auth`, `/api/health` and `/api/me/locale` (matched on path segments, not prefixes) must hold an OPEN support grant for the tenant the request touches.
  `authenticate()` loads the admin's open grants onto the principal (`writeGrants`); `requireBusinessAccess` / `scopeBusinessId` / `authenticateTeam` then refuse any business that is not one of them, WHEREVER the id came from (URL path, `?business_id=`, the JSON body, or the resource: the booking a route loads). A grant for tenant A never authorises tenant B. The early check in the gate covers a tenant named in the URL (`/api/businesses/{id}/...`, `?business_id=`); when the URL names none, at least one open grant is required there and the exact check happens where the route resolves the business; a write that names no business at all is refused. The `rc_business` cookie is a dashboard hint and is never consulted. Otherwise `403 support_write_required` (UI text `at.err.support_write_required`). A `read_only` admin gets `403 forbidden`. Roles that can enter write mode: owner, ops, support (`tenants.support_enter`).
  **Support write mode is not owner write**: the `support` role with a grant may write only `SUPPORT_WRITE_SCOPE` (`tenants.overrides.write`, through `/api/admin/tenant-overrides`); every tenant route is `403 support_scope` for it (`SUPPORT_WRITE_ROUTES` in `permissions.ts` is the allowlist, empty today). Owner and ops keep owner-level writes inside a grant.
  **Platform actions without a tenant grant**: `POST /api/businesses` needs `tenants.users.create`, `POST /api/businesses/{id}/provision` by an admin needs `providers.repair` and a fresh sign-in (`PLATFORM_WRITE_ROUTES`); `read_only` and `support` get `403 forbidden`.
  Not gated: GET, the Bearer token and its cookie session (break-glass, audited and mailed per use), the dev open mode.
* Write mode: `POST /tenants/{id}/support-mode { reason }` (step-up, 30 minutes, needs a personal account); `DELETE` exits. The Support tab shows the state, the countdown and the history of grants.

### Tenant actions route
`POST /api/admin/tenants/{id}/actions { action, reason }`, permission `tenants.billing` (owner, ops), step-up, 20 per minute: `clear_owner_phone_verification` (owner phone back to unverified) and `clear_trial_fingerprint` (the business's card fingerprint and the fingerprints of its owners' e-mails).
Audited `tenant.<action>` with `business_id`, `reason`, `changed`, `support_grant_id`. `POST /tenants/{id}/suspend` now also mails every admin (critical tier). `POST /release-tenant { reason }` records the reason (`billing.release_reason`) on a real run.

### Plan entitlements (`planAllows`, `planAllowsLocation`, `planPriceId` in `plan-catalog.ts`)
A plan without a feature entry allows it; the seeded plans keep every feature on, so behaviour for existing tenants is identical. Wired:
| Feature | Where it is enforced |
| --- | --- |
| `owner_callin` | `detectOwnerCaller` (owner calls behave like any caller), `handleOwnerSms` (owner SMS commands ignored) |
| `owner_reply` | reply tools `precheck`, reply SMS codes (`handleReplyCode`, bare YES / NO), `sendOwnerReply` refusal `disabled` |
| `native_transfer` | `transferEnabledFor` |
| `calendar_sync` | `syncOnce` (outcome `skipped`, reason `plan`) |
| `deposits` | `resolveDepositAmount({ plan })` (AI tool, owner payment-link routes) |
| `multi_location` + `max_locations` | `createBusinessForOwner`: the account's roomiest plan decides (`limit_reached`) |
Checkout: `createCheckoutSession` bills the business plan's `stripe_price_id` / `stripe_price_id_annual` when set, else `STRIPE_PRICE_ID` / `_ANNUAL`; `annualAvailable(env, plan)` and `POST /api/billing/checkout` follow it. `voicemail`: `voicemailAllowance` refuses (`no_plan`: the caller is not offered voicemail). `call_forwarding`: `resolveCallRoute` answers `{ action: 'ai', why: 'forward_not_in_plan' }` (dashboard label `callmode.label.ai_plan`) and `forwardAllowance` refuses (`no_plan`).

### Tenant knobs (`src/lib/admin/tenant-knobs.ts`)
`knobOr(businessId, key, base)` (override validated + clamped at read, else the caller's own platform value), `knobFrom`, `quietWindowFor`, `loadTenantOverrides(Many)`; never throw. Wired: quiet hours (`isQuietHour(now, tz, window)` in `messaging/index.ts` decide, `inbox`, `manual`, `owner-reply`, `booking-manual`, `booking-changes`, briefing notice, gratitude sweep),
briefing hour and on / off (`briefingSlot / nextBriefingAt(now, tz, hour)`, `runDailyBriefings`, job status), thank-you toggle (`runGratitudeJob`, outcome `skipped_disabled`), ring seconds (`/api/voice/incoming`), owner reply daily limit (`reply-tools`, `claimReply`),
owner alert hourly limit, forward / voicemail calls per hour (`caller-limits.ts`, `forward-metering.ts`). The platform quiet-hours settings are also read by `isQuietHour` without a window (registry `messaging.quiet_*_hour`, default 21 / 8).
Owner card: `/dashboard/settings#comfort` (quiet hours, briefing on / off and hour, thank-you texts, ring seconds) through `GET / PUT / DELETE /api/businesses/{id}/settings-overrides`; an admin in the support view sees it read only.

### Residuals
* The support gate's early check names a tenant only from the URL; for a body-supplied or resource-derived business id the exact check runs where the route resolves it (`requireBusinessAccess` / `scopeBusinessId` / `authenticateTeam`). A new route that reads a business id WITHOUT going through one of those three is not covered: use them. Reads of other tenant routes are audited once per 15 minutes per process, not per request.
* The release / repair / resync previews show the server's own words (English) for the per-item outcome codes.
* `billingMode()` still requires `STRIPE_PRICE_ID` for live checkout even when every plan carries its own price id.
* The fingerprint of a secret changes when `APP_SECRET_KEY` rotates (it is keyed by it); history rows keep the fingerprint they were written with.
* The SMTP send path connects to the one validated address with the name as TLS servername (no second lookup); an operator-pinned `SMTP_HOST` / `SMTP_URL` (environment) is trusted as before and not pinned.
* `deploy.sh` turns a missing `.env` line for a console-capable setting into a warning and checks the running server afterwards (`/api/admin/selftest`, `/api/admin/settings` with the Bearer token, from inside the app container: one audited and mailed Bearer use per deploy that has deferred settings); it fails the deploy when neither `.env` nor the console holds it.

### D.8 Residuals (agent D)
* No background provider poller: the health history grows when the console tests providers.
* The alert notice runs from the hourly cleanup job: with `JOBS=off` only the button sends it.
* The stored tenant release / grandfather report keeps 40 rows (audit meta cap); the dry-run response has them all.
* The SMS view cannot show failures whose status callback never arrived, and does not list `sms_log` rows individually (no bodies are ever shown).
* MRR is an estimate (see `known-limitations.md`); usage rows are capped at 5000 businesses.
* The overview page (agent A) still lists stuck deletions and SMS failures as "not monitored yet"; the alerts API now answers both, and `/admin/operations/alerts` is the place to look.
