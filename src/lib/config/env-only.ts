/**
 * Names that stay in the environment and are NEVER stored in the database or writable from the console (24e section 6, owner decisions D3,
 * D8, D10, D11). Exported as a list so the CI scan (tests/config-boundary.test.ts) and docs/env-vars.md can be checked against it.
 * Everything a registry entry carries as `env` is NOT here: those names are settings that an environment variable may additionally PIN.
 */
import type { EnvOnlyEntry, RetiredEnvEntry } from './types';

export const ENV_ONLY: readonly EnvOnlyEntry[] = [
  // bootstrap: needed before the settings store can load
  { name: 'DATABASE_URL', reason: 'bootstrap', note: 'The settings live in this database.', secret: true },
  { name: 'DATABASE_URL_OVERRIDE', reason: 'deploy_tooling', note: 'compose only: managed Postgres instead of the bundled one.', secret: true },
  { name: 'POSTGRES_USER', reason: 'deploy_tooling', note: 'compose db service.' },
  { name: 'POSTGRES_PASSWORD', reason: 'deploy_tooling', note: 'compose db service.', secret: true },
  { name: 'POSTGRES_DB', reason: 'deploy_tooling', note: 'compose db service.' },
  { name: 'APP_SECRET_KEY', reason: 'master_secret', note: 'Key of every encrypted secret (TOTP now, provider credentials from Phase 4). Never in the database.', secret: true },
  { name: 'APP_SECRET_KEY_PREVIOUS', reason: 'master_secret', note: 'Decrypt-only previous key during a rotation (envelope v2, Phase 4).', secret: true },
  { name: 'ADMIN_TOKEN', reason: 'bootstrap', note: 'Break-glass and recovery only (D8): never the routine operator credential.', secret: true },
  { name: 'NODE_ENV', reason: 'infrastructure', note: 'Gates every dev-only bypass; inlined by Next.' },
  { name: 'NEXT_RUNTIME', reason: 'infrastructure', note: 'Set by Next; never by hand.' },
  { name: 'NEXT_PHASE', reason: 'infrastructure', note: 'Set by Next; never by hand.' },
  { name: 'PORT', reason: 'infrastructure', note: 'Container listen port.' },
  { name: 'HOSTNAME', reason: 'infrastructure', note: 'Container bind address.' },
  // the public origin (D3): read-only in the console
  { name: 'APP_URL', reason: 'public_origin', note: 'THE public origin: CSRF allowlist, Twilio signatures, ElevenLabs tool URLs, Stripe return URLs, WebAuthn default. Read-only in the console with re-sync actions.' },
  { name: 'PUBLIC_BASE_URL', reason: 'public_origin', note: 'Fallback for APP_URL only.' },
  // proxy and security identity
  { name: 'TRUSTED_PROXY', reason: 'infrastructure', note: 'Depends on the deployment topology; a wrong value lets clients spoof X-Forwarded-For.' },
  { name: 'TRUSTED_PROXY_HOPS', reason: 'infrastructure', note: 'Proxies appending to X-Forwarded-For (1-5).' },
  { name: 'WEBAUTHN_RP_ID', reason: 'security_identity', note: 'Changing it orphans every registered passkey.' },
  { name: 'WEBAUTHN_ORIGINS', reason: 'security_identity', note: 'Extra passkey origins.' },
  { name: 'CSP_REPORT_ONLY', reason: 'security_identity', note: 'Flipping it disables XSS protection for every tenant; changes only with infrastructure.' },
  { name: 'CSP_UPGRADE_INSECURE', reason: 'security_identity', note: 'upgrade-insecure-requests decision.' },
  { name: 'CSP_REPORT_URI', reason: 'security_identity', note: 'CSP report collector.' },
  { name: 'LOG_LEVEL', reason: 'infrastructure', note: 'Base level, needed before the database is up (a time-boxed runtime override may be added later).' },
  { name: 'PRISMA_LOG', reason: 'infrastructure', note: 'Logs every query.' },
  { name: 'PRISMA_QUERY_EVENTS', reason: 'dev_only', note: 'Tests count SQL statements; module-load constant.' },
  // security ratchets (D10): the console may tighten, only the environment may loosen
  { name: 'SIGNUP_ALLOW_WITHOUT_CAPTCHA', reason: 'security_ratchet', note: 'Open signup without a captcha in production: loosening must not be a click.' },
  { name: 'REQUIRE_2FA_FOR_ADMINS', reason: 'security_ratchet', note: 'On in production; `false` is ignored there. Forced ON whenever console writes are enabled.' },
  { name: 'LOG_PII', reason: 'security_ratchet', note: 'Stops masking phone numbers and emails in logs; debugging only.' },
  // new platform controls
  { name: 'SETTINGS_FREEZE', reason: 'platform_control', note: 'true: the whole console is read-only (incident switch).' },
  { name: 'ADMIN_TOKEN_ALLOW_SETTINGS', reason: 'platform_control', note: 'true: the Bearer ADMIN_TOKEN may also write secrets and critical settings (default: recovery only, D8).' },
  { name: 'ALERT_EMAIL', reason: 'platform_control', note: 'Out-of-band recipient of critical-change and Bearer-use notifications; does not depend on database-held email settings.' },
  // dev-only escape hatches: never exposed
  { name: 'ALLOW_INSECURE_DEV', reason: 'dev_only', note: 'Requires NODE_ENV != production; deploy.sh refuses it.' },
  { name: 'DEMO_MODE', reason: 'dev_only', note: 'Ignored in production.' },
  { name: 'GOOGLE_OAUTH_MOCK', reason: 'dev_only', note: 'Ignored in production.' },
  { name: 'STRIPE_ALLOW_UNSIGNED', reason: 'dev_only', note: 'Also needs ALLOW_INSECURE_DEV.' },
  { name: 'ALLOWED_DEV_ORIGINS', reason: 'dev_only', note: 'next dev behind a tunnel.' },
  // deploy tooling and scripts
  { name: 'DOMAIN', reason: 'deploy_tooling', note: 'compose / Traefik host rule.' },
  { name: 'TRAEFIK_NAME', reason: 'deploy_tooling', note: 'Traefik router name.' },
  { name: 'APP_IMAGE', reason: 'deploy_tooling', note: 'compose image name.' },
  { name: 'TOOLS_IMAGE', reason: 'deploy_tooling', note: 'compose image name.' },
  { name: 'BACKUP_DIR', reason: 'deploy_tooling', note: 'deploy.sh.' },
  { name: 'COMPOSE', reason: 'deploy_tooling', note: 'deploy.sh.' },
  { name: 'FOLLOW_LOGS', reason: 'deploy_tooling', note: 'deploy.sh.' },
  { name: 'ENV_FILE', reason: 'deploy_tooling', note: 'dev helper script.' },
  { name: 'CREATE_USER_PASSWORD', reason: 'deploy_tooling', note: 'scripts/create-user.ts non-interactive password.', secret: true },
];

/** Build-time `NEXT_PUBLIC_*` reads that stay literal property reads on the process environment (Next inlines them) until Phase 6 removes them. */
export const BUILD_TIME_ENV = [
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'NEXT_PUBLIC_PLAN_PRICE_DISPLAY',
  'NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL',
  'NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ES',
  'NEXT_PUBLIC_PLAN_PRICE_DISPLAY_ANNUAL_ES',
] as const;

/**
 * Retired (D11). They still behave as today for ONE more release but the startup banner warns; after `removeAfter` the names are
 * ignored. `warnedBy`: another banner line already explains this one (so it is not repeated).
 */
export const RETIRED_ENV: readonly RetiredEnvEntry[] = [
  { name: 'OWNER_PHONE_GRANDFATHER', removeAfter: '0.3', note: 'One-off rollout switch that bypasses opt-outs and the country list; not a product setting. Re-verify owner phones instead.', warnedBy: 'owner_phone_grandfather' },
  { name: 'OWNER_PHONE_GRANDFATHER_ACK', removeAfter: '0.3', note: 'Part of OWNER_PHONE_GRANDFATHER.' },
  { name: 'OWNER_PHONE_GRANDFATHER_BEFORE', removeAfter: '0.3', note: 'Part of OWNER_PHONE_GRANDFATHER.' },
  { name: 'OWNER_PHONE_GRANDFATHER_UNTIL', removeAfter: '0.3', note: 'Part of OWNER_PHONE_GRANDFATHER.' },
  { name: 'ELEVENLABS_AGENT_ID', removeAfter: '0.3', note: 'Only honoured while exactly one business exists; agents are provisioned per tenant. Remove it.' },
  { name: 'NEXT_PUBLIC_APP_URL', use: 'APP_URL', removeAfter: '0.3', note: 'No longer read (Phase 0); it was the third fallback of the public origin.', warnedBy: 'base_url' },
];
