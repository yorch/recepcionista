/**
 * Settings that do NOT exist as environment variables today: constants promoted from code (24c, the ones worth tuning; "Const ok"
 * items stay in code), plus the configuration 24e section 2.3 found missing (brand, support contact, legal URLs, maintenance, signup mode,
 * locales). They have no env alias, so only the console (Phase 2+) can set them; until a consumer is wired to `setting()` the code
 * constant named in `codeRef` is still the effective value, and tests/config-registry.test.ts asserts that the registry default equals it.
 *
 * Legal page CONTENT (Terms, Privacy, SMS terms) is not a setting: it is versioned markdown content owned by the console's page editor
 * (Phase 7). `legal.*_url` below are the alternative: link to an externally hosted page.
 */
import { defineSetting } from './define';
import { s } from './schema';
import type { SettingInput } from './types';

type Extra<T> = Omit<SettingInput<T>, 'key' | 'kind' | 'schema' | 'default' | 'label' | 'help' | 'group'>;
type Base = { label: string; help: string; codeRef?: string };

const int = <const K extends string>(key: K, group: SettingInput<number>['group'], b: Base & Extra<number>, o: { min: number; max: number; def: number }) =>
  defineSetting({ key, group, kind: 'int', schema: s.int({ min: o.min, max: o.max }), default: o.def, ...b });
const flag = <const K extends string>(key: K, group: SettingInput<boolean>['group'], b: Base & Extra<boolean>, def: boolean) =>
  defineSetting({ key, group, kind: 'bool', schema: s.bool(), default: def, ...b });
const text = <const K extends string>(key: K, group: SettingInput<string>['group'], b: Base & Extra<string>, o: { max?: number; min?: number; def: string | null; multiline?: boolean }) =>
  defineSetting({ key, group, kind: 'string', schema: s.string({ max: o.max ?? 200, min: o.min, multiline: o.multiline }), default: o.def, ...b });
const url = <const K extends string>(key: K, group: SettingInput<string>['group'], b: Base & Extra<string>) =>
  defineSetting({ key, group, kind: 'url', schema: s.url(), default: null, ...b });

/** Platform quiet-hours window and per-tenant "stricter" overrides. */
const quiet = { editableBy: 'owner', rule: 'stricter_than_platform', min: 0, max: 23 } as const;

export const PROMOTED_SETTINGS = [
  // ---- Messaging budgets and quiet hours (messaging/policy.ts, manual.ts, inbox.ts, capacity.ts, call-handling-changes.ts) -----
  int('messaging.quiet_start_hour', 'messaging', { label: 'Quiet hours start', help: 'Local hour (business time zone) from which no non-urgent text is sent. A tenant may only make its window stricter.', codeRef: 'src/lib/messaging/policy.ts:QUIET_START_HOUR', unit: 'count', scope: 'platform+tenant', tenant: quiet, tier: 'sensitive' }, { min: 0, max: 23, def: 21 }),
  int('messaging.quiet_end_hour', 'messaging', { label: 'Quiet hours end', help: 'Local hour at which texts resume. A tenant may only make its window stricter.', codeRef: 'src/lib/messaging/policy.ts:QUIET_END_HOUR', unit: 'count', scope: 'platform+tenant', tenant: quiet, tier: 'sensitive' }, { min: 0, max: 23, def: 8 }),
  int('messaging.manual_business_hourly_limit', 'messaging', { label: 'Manual texts per business per hour', help: 'Texts an owner may send by hand per hour.', codeRef: 'src/lib/messaging/manual.ts:MANUAL_BUSINESS_HOURLY_LIMIT', tier: 'sensitive' }, { min: 1, max: 1000, def: 40 }),
  int('messaging.manual_recipient_hourly_limit', 'messaging', { label: 'Manual texts per recipient per hour', help: 'Hand-sent texts to ONE number per hour.', codeRef: 'src/lib/messaging/manual.ts:MANUAL_RECIPIENT_HOURLY_LIMIT', tier: 'sensitive' }, { min: 1, max: 100, def: 6 }),
  int('messaging.inbox_sender_hourly_limit', 'messaging', { label: 'Inbox auto-replies per sender per hour', help: 'Anti-pumping budget: automatic replies to one sender per hour.', codeRef: 'src/lib/messaging/inbox.ts:INBOX_SENDER_HOURLY_LIMIT', tier: 'sensitive' }, { min: 1, max: 100, def: 10 }),
  int('messaging.inbox_business_hourly_limit', 'messaging', { label: 'Inbox auto-replies per business per hour', help: 'Anti-pumping budget: automatic replies of one business per hour.', codeRef: 'src/lib/messaging/inbox.ts:INBOX_BUSINESS_HOURLY_LIMIT', tier: 'sensitive' }, { min: 1, max: 5000, def: 300 }),
  int('messaging.inbox_sender_forward_hourly_limit', 'messaging', { label: 'Inbox forwards per sender per hour', help: 'Owner texts about ONE sender per hour.', codeRef: 'src/lib/messaging/inbox.ts:INBOX_SENDER_FORWARD_HOURLY_LIMIT' }, { min: 1, max: 100, def: 2 }),
  int('messaging.missed_call_alerts_per_hour', 'messaging', { label: 'Missed-call alerts per hour', help: 'Owner texts about missed calls per business per hour.', codeRef: 'src/lib/voice/capacity.ts:MISSED_CALL_ALERTS_PER_HOUR' }, { min: 1, max: 100, def: 6 }),
  int('messaging.change_notices_per_hour', 'messaging', { label: 'Call-handling change notices per hour', help: 'Owner texts about call-handling changes per business per hour.', codeRef: 'src/lib/voice/call-handling-changes.ts:CHANGE_NOTICES_PER_HOUR' }, { min: 1, max: 100, def: 6 }),

  // ---- Voice -----------------------------------------------------------------------------------------------------------------
  int('voice.voicemail_max_seconds', 'voice', { label: 'Longest voicemail', help: 'Maximum length of one voicemail recording.', codeRef: 'src/lib/voice/twiml.ts:VOICEMAIL_MAX_SECONDS', unit: 'seconds' }, { min: 15, max: 600, def: 90 }),
  int('voice.out_of_service_max_seconds', 'voice', { label: 'Out-of-service call length', help: 'How long a call to a suspended line stays connected.', codeRef: 'src/lib/voice/capacity.ts:OUT_OF_SERVICE_MAX_SECONDS', unit: 'seconds' }, { min: 10, max: 300, def: 60 }),
  text('voice.default_assistant_name', 'voice', { label: 'Default assistant name', help: 'Name of the assistant for a business that has not picked its own.', codeRef: 'src/lib/voice/assistant-name.ts:DEFAULT_ASSISTANT_NAME', applies: 'new_records_only' }, { max: 40, def: 'Maria' }),
  int('owner.sessions_per_day', 'owner', { label: 'Owner call-in sessions per day', help: 'Abuse brake on owner call-in sessions per business per day.', codeRef: 'src/lib/voice/owner/config.ts:OWNER_SESSIONS_PER_DAY', tier: 'sensitive' }, { min: 1, max: 100, def: 10 }),
  int('owner.proposals_per_call', 'owner', { label: 'Owner change proposals per call', help: 'Proposed changes an owner may make in one call.', codeRef: 'src/lib/voice/owner/config.ts:OWNER_PROPOSALS_PER_CALL' }, { min: 1, max: 50, def: 5 }),
  int('owner.confirm_sms_per_hour', 'owner', { label: 'Owner confirmation texts per hour', help: 'Confirmation texts per business per hour.', codeRef: 'src/lib/voice/owner/config.ts:OWNER_CONFIRM_SMS_PER_HOUR' }, { min: 1, max: 100, def: 6 }),

  // ---- Jobs and schedules ----------------------------------------------------------------------------------------------------
  int('jobs.briefing_hour', 'jobs', { label: 'Briefing hour', help: 'Local hour (business time zone) the end-of-day briefing is generated. Owners may move their own within bounds.', codeRef: 'src/lib/jobs/schedule.ts:BRIEFING_HOUR', unit: 'count', scope: 'platform+tenant', tenant: { editableBy: 'owner', min: 0, max: 23, rule: 'within_bounds' } }, { min: 0, max: 23, def: 18 }),
  flag('jobs.briefing_enabled', 'jobs', { label: 'Daily briefing', help: 'Generate the evening briefing. Owners may switch their own off.', scope: 'platform+tenant', tenant: { editableBy: 'owner' }, source: 'new' }, true),
  flag('jobs.gratitude_enabled', 'jobs', { label: 'Thank-you and review follow-ups', help: 'Send the post-visit thank-you text. Owners may switch their own off.', scope: 'platform+tenant', tenant: { editableBy: 'owner' }, source: 'new' }, true),
  int('jobs.gratitude_min_age_hours', 'jobs', { label: 'Thank-you earliest', help: 'A completed call is eligible for a thank-you text this many hours later.', codeRef: 'src/lib/gratitude/index.ts:MIN_AGE_MS', unit: 'hours' }, { min: 1, max: 168, def: 20 }),
  int('jobs.gratitude_max_age_hours', 'jobs', { label: 'Thank-you latest', help: 'A completed call older than this is no longer eligible.', codeRef: 'src/lib/gratitude/index.ts:MAX_AGE_MS', unit: 'hours' }, { min: 2, max: 336, def: 48 }),
  int('jobs.cleanup_every_minutes', 'jobs', { label: 'Cleanup interval', help: 'How often expired sessions, tokens, events and rate-limit rows are cleaned.', codeRef: 'src/lib/jobs/index.ts:CLEANUP_EVERY_MS', unit: 'minutes' }, { min: 5, max: 1440, def: 60 }),
  int('jobs.retention_every_hours', 'jobs', { label: 'Retention purge interval', help: 'How often the retention purge runs when enabled.', codeRef: 'src/lib/jobs/index.ts:RETENTION_EVERY_MS', unit: 'hours' }, { min: 1, max: 168, def: 24 }),
  int('jobs.usage_warnings_every_minutes', 'jobs', { label: 'Usage warnings interval', help: 'Safety-net sweep for plan usage warnings.', codeRef: 'src/lib/jobs/index.ts:USAGE_WARNINGS_EVERY_MS', unit: 'minutes' }, { min: 1, max: 1440, def: 10 }),
  int('jobs.tenant_release_every_hours', 'jobs', { label: 'Tenant release interval', help: 'How often the tenant release job runs when enabled.', codeRef: 'src/lib/jobs/index.ts:TENANT_RELEASE_EVERY_MS', unit: 'hours' }, { min: 1, max: 168, def: 24 }),
  int('jobs.calendar_poll_minutes', 'jobs', { label: 'Calendar fallback poll', help: 'Fallback poll interval per Google Calendar connection.', codeRef: 'src/lib/jobs/calendar.ts:POLL_EVERY_MS', unit: 'minutes' }, { min: 1, max: 1440, def: 15 }),
  int('jobs.max_releases_per_run', 'jobs', { label: 'Tenant releases per run', help: 'Most tenants the release job releases in one run.', codeRef: 'src/lib/jobs/tenants.ts:MAX_RELEASES_PER_RUN', tier: 'sensitive' }, { min: 1, max: 100, def: 10 }),
  int('jobs.max_release_errors_per_run', 'jobs', { label: 'Release errors before stopping', help: 'The release job stops a run after this many errors.', codeRef: 'src/lib/jobs/tenants.ts:MAX_RELEASE_ERRORS_PER_RUN', tier: 'sensitive' }, { min: 1, max: 20, def: 3 }),
  int('data.processed_events_retention_days', 'data', { label: 'Processed-event retention', help: 'Days webhook idempotency rows are kept.', codeRef: 'src/lib/db/events.ts:PROCESSED_EVENTS_RETENTION_MS', unit: 'days' }, { min: 1, max: 365, def: 30 }),

  // ---- Billing lifecycle -----------------------------------------------------------------------------------------------------
  int('billing.trial_banner_days', 'billing', { label: 'Trial-ending banner', help: 'Days before the trial ends that the banner appears.', codeRef: 'src/lib/billing/banner-state.ts:TRIAL_BANNER_DAYS', unit: 'days' }, { min: 1, max: 30, def: 3 }),
  int('billing.release_grace_days', 'billing', { label: 'Release grace period', help: 'Days after cancellation before the number and agent are released (data-retention policy).', codeRef: 'src/lib/billing/release.ts:DEFAULT_GRACE_DAYS', unit: 'days', tier: 'critical' }, { min: 1, max: 365, def: 30 }),
  int('billing.release_notice_days', 'billing', { label: 'Release notice', help: 'Days before the release that the heads-up mail is sent.', codeRef: 'src/lib/billing/release.ts:DEFAULT_NOTIFY_DAYS', unit: 'days', tier: 'sensitive' }, { min: 1, max: 90, def: 7 }),
  defineSetting({ key: 'billing.comp_plans', group: 'billing', label: 'Comped plan names', help: 'Plans that are never released and never billed (derived from a plans table later).', codeRef: 'src/lib/billing/release.ts:COMP_PLANS', kind: 'list', schema: s.list(s.string({ min: 1, max: 60, pattern: /^[a-z0-9_-]+$/ }), { max: 20 }), default: ['legacy', 'grandfathered'], tier: 'critical' }),

  // ---- Security policy (ratchets: the console may only tighten) --------------------------------------------------------------
  int('security.session_max_age_hours', 'security', { label: 'Session cookie lifetime', help: 'Lifetime of the session cookie. The console may only shorten it.', codeRef: 'src/lib/auth.ts:SESSION_MAX_AGE_S', unit: 'hours', ratchet: 'tighten_only_in_ui', tightenIs: 'lower', tier: 'sensitive', applies: 'new_records_only' }, { min: 1, max: 12, def: 12 }),
  int('security.user_session_ttl_days', 'security', { label: 'Owner session lifetime', help: 'Server-side lifetime of an owner session. The console may only shorten it.', codeRef: 'src/lib/db/users.ts:SESSION_TTL_MS', unit: 'days', ratchet: 'tighten_only_in_ui', tightenIs: 'lower', tier: 'sensitive', applies: 'new_records_only' }, { min: 1, max: 7, def: 7 }),
  int('security.admin_session_ttl_hours', 'security', { label: 'Admin session lifetime', help: 'Server-side lifetime of an admin session. The console may only shorten it.', codeRef: 'src/lib/db/users.ts:ADMIN_SESSION_TTL_MS', unit: 'hours', ratchet: 'tighten_only_in_ui', tightenIs: 'lower', tier: 'sensitive', applies: 'new_records_only' }, { min: 1, max: 12, def: 12 }),
  int('security.recent_auth_minutes', 'security', { label: 'Step-up window', help: 'How long a fresh sign-in or 2FA counts as recent for sensitive actions. The console may only shorten it.', codeRef: 'src/lib/session.ts:RECENT_AUTH_MS', unit: 'minutes', ratchet: 'tighten_only_in_ui', tightenIs: 'lower', tier: 'sensitive' }, { min: 1, max: 5, def: 5 }),
  int('security.password_min_chars', 'security', { label: 'Minimum password length', help: 'The console may only raise it.', codeRef: 'src/lib/user-policy.ts:MIN_PASSWORD_CHARS', unit: 'count', ratchet: 'tighten_only_in_ui', tightenIs: 'higher', tier: 'sensitive' }, { min: 12, max: 256, def: 12 }),

  // ---- Knowledge base and retention ------------------------------------------------------------------------------------------
  int('kb.max_services', 'data', { label: 'Services per knowledge base', help: 'Most services a saved knowledge base may hold (over the limit is an error, never a silent cut).', codeRef: 'src/lib/kb/limits.ts:KB_LIMITS.services' }, { min: 1, max: 1000, def: 200 }),
  int('kb.max_faqs', 'data', { label: 'FAQs per knowledge base', help: 'Most FAQs a saved knowledge base may hold.', codeRef: 'src/lib/kb/limits.ts:KB_LIMITS.faqs' }, { min: 1, max: 1000, def: 200 }),
  int('data.retention_default_days', 'data', { label: 'Default retention window', help: 'Retention window of a new business (days).', codeRef: 'prisma/schema.prisma:businesses.retention_days', unit: 'days', applies: 'new_records_only', tier: 'sensitive' }, { min: 1, max: 3650, def: 365 }),
  int('data.retention_min_days', 'data', { label: 'Shortest retention window', help: 'Lowest value an owner may choose.', codeRef: 'src/app/api/businesses/[id]/settings/route.ts', unit: 'days', tier: 'sensitive' }, { min: 1, max: 3650, def: 1 }),
  int('data.retention_max_days', 'data', { label: 'Longest retention window', help: 'Highest value an owner may choose.', codeRef: 'src/app/api/businesses/[id]/settings/route.ts', unit: 'days', tier: 'sensitive' }, { min: 1, max: 3650, def: 3650 }),

  // ---- Platform maxima every tenant is clamped by (DB CHECKs still apply: the database ceiling is a hard maximum) -------------
  int('limits.deposit_min_cents', 'limits', { label: 'Smallest deposit', help: 'Platform minimum deposit. The database CHECK constraint is a hard floor.', codeRef: 'src/lib/business-config.ts:DEPOSIT_MIN_CENTS', unit: 'cents', tier: 'sensitive' }, { min: 100, max: 100_000, def: 100 }),
  int('limits.deposit_max_cents', 'limits', { label: 'Largest deposit', help: 'Platform maximum deposit. The database CHECK constraint is a hard ceiling.', codeRef: 'src/lib/business-config.ts:DEPOSIT_MAX_CENTS', unit: 'cents', tier: 'sensitive' }, { min: 100, max: 100_000, def: 100_000 }),
  int('limits.min_lead_max_minutes', 'limits', { label: 'Longest minimum lead time', help: 'Most a business may require as booking lead time.', codeRef: 'src/lib/business-config.ts:MIN_LEAD_MAX', unit: 'minutes' }, { min: 0, max: 43_200, def: 10_080 }),
  int('limits.horizon_days_max', 'limits', { label: 'Longest booking horizon', help: 'Furthest ahead a business may take bookings.', codeRef: 'src/lib/business-config.ts:HORIZON_DAYS_MAX', unit: 'days' }, { min: 1, max: 730, def: 180 }),
  int('limits.buffer_max_minutes', 'limits', { label: 'Longest buffer', help: 'Most buffer time between bookings.', codeRef: 'src/lib/business-config.ts:BUFFER_MAX', unit: 'minutes' }, { min: 0, max: 1440, def: 240 }),
  int('limits.max_crews', 'limits', { label: 'Most crews per business', help: 'Parallel crews a business may configure.', codeRef: 'src/lib/crews.ts:MAX_CREWS' }, { min: 1, max: 200, def: 20 }),

  // ---- New-tenant defaults (schema defaults cannot change without a migration; these apply when a business is created) --------
  text('defaults.timezone', 'defaults', { label: 'New business time zone', help: 'IANA zone given to a new business until it picks its own.', codeRef: 'prisma/schema.prisma:businesses.timezone', applies: 'new_records_only' }, { max: 64, def: 'America/New_York' }),
  defineSetting({ key: 'defaults.vertical', group: 'defaults', label: 'New business vertical', help: 'Vertical pack given to a new business.', codeRef: 'prisma/schema.prisma:businesses.vertical', kind: 'enum', schema: s.enum(['hvac', 'plumbing', 'electrical', 'cleaning', 'landscaping', 'dental', 'general']), default: 'hvac', applies: 'new_records_only' }),
  defineSetting({ key: 'defaults.locale', group: 'defaults', label: 'New business language', help: 'Default language of a new business.', codeRef: 'prisma/schema.prisma:businesses.locale_default', kind: 'enum', schema: s.enum(['en', 'es']), default: 'en', applies: 'new_records_only' }),
  defineSetting({ key: 'defaults.call_mode', group: 'defaults', label: 'New business call mode', help: 'Call handling of a new business.', codeRef: 'prisma/schema.prisma:businesses.call_mode', kind: 'enum', schema: s.enum(['ai', 'paused', 'forward']), default: 'ai', applies: 'new_records_only' }),
  defineSetting({ key: 'defaults.refund_policy', group: 'defaults', label: 'New business refund policy', help: 'Deposit refund policy of a new business.', codeRef: 'prisma/schema.prisma:businesses.refund_policy', kind: 'enum', schema: s.enum(['none', 'full_24h', 'full_48h', 'full_always']), default: 'full_24h', applies: 'new_records_only' }),
  defineSetting({ key: 'defaults.slot_minutes', group: 'defaults', label: 'New business slot length', help: 'Booking slot length: 15, 30 or 60 minutes.', codeRef: 'src/lib/business-config.ts:DEFAULT_SCHEDULING.slot_minutes', kind: 'int', schema: s.int({ min: 15, max: 60 }), default: 60, unit: 'minutes', applies: 'new_records_only' }),
  int('defaults.min_lead_minutes', 'defaults', { label: 'New business minimum lead', help: 'Minimum notice for a booking.', codeRef: 'src/lib/business-config.ts:DEFAULT_SCHEDULING.min_lead_minutes', unit: 'minutes', applies: 'new_records_only' }, { min: 0, max: 43_200, def: 60 }),
  int('defaults.horizon_days', 'defaults', { label: 'New business booking horizon', help: 'How far ahead bookings are taken.', codeRef: 'src/lib/business-config.ts:DEFAULT_SCHEDULING.horizon_days', unit: 'days', applies: 'new_records_only' }, { min: 1, max: 730, def: 14 }),
  int('defaults.buffer_minutes', 'defaults', { label: 'New business buffer', help: 'Buffer between bookings.', codeRef: 'src/lib/business-config.ts:DEFAULT_SCHEDULING.buffer_minutes', unit: 'minutes', applies: 'new_records_only' }, { min: 0, max: 1440, def: 0 }),
  int('defaults.crews', 'defaults', { label: 'New business crews', help: 'Parallel crews of a new business.', codeRef: 'src/lib/business-config.ts:DEFAULT_SCHEDULING.crews', applies: 'new_records_only' }, { min: 1, max: 200, def: 1 }),

  // ---- Brand, support, legal and platform controls (24e 2.3: all missing today) ----------------------------------------------
  text('brand.name', 'brand', { label: 'Product name', help: 'Shown in the app, emails and texts. White-label without a deploy.', source: 'new', applies: 'live' }, { min: 1, max: 60, def: 'Recepcionista' }),
  text('brand.support_email', 'brand', { label: 'Support email', help: 'Shown on error pages and in emails and help replies.', source: 'new' }, { max: 200, def: null }),
  text('brand.support_phone', 'brand', { label: 'Support phone', help: 'Shown on error pages and in help replies.', source: 'new' }, { max: 40, def: null }),
  url('brand.support_url', 'brand', { label: 'Support page URL', help: 'Help center or contact page.', source: 'new' }),
  text('brand.company_address', 'brand', { label: 'Company postal address', help: 'Required in email footers (CAN-SPAM) and by A2P 10DLC and Google verification.', source: 'new', tier: 'sensitive' }, { max: 400, def: null, multiline: true }),
  url('legal.terms_url', 'brand', { label: 'Terms of service URL', help: 'Public terms page. Leave empty to use the built-in page (Phase 7 editor).', source: 'new', tier: 'sensitive' }),
  url('legal.privacy_url', 'brand', { label: 'Privacy policy URL', help: 'Public privacy page. Required by Twilio A2P 10DLC, Google OAuth verification and Stripe.', source: 'new', tier: 'sensitive' }),
  url('legal.sms_terms_url', 'brand', { label: 'SMS terms URL', help: 'Public SMS terms and opt-out page for the A2P campaign.', source: 'new', tier: 'sensitive' }),
  flag('platform.maintenance_mode', 'platform', { label: 'Maintenance mode', help: 'Read-only incident switch: writes are refused and the banner is shown. Needs no redeploy.', source: 'new', tier: 'sensitive' }, false),
  text('platform.announcement', 'platform', { label: 'Announcement banner', help: 'A short notice shown to every signed-in user. Empty: none.', source: 'new' }, { max: 300, def: null }),
  defineSetting({ key: 'signup.mode', group: 'signup', label: 'Signup mode', help: 'open: anyone may sign up; invite_only: accounts are created by an admin; closed: no new accounts. Launch control and abuse response.', kind: 'enum', schema: s.enum(['open', 'invite_only', 'closed']), default: 'open', tier: 'sensitive', source: 'new' }),
  defineSetting({ key: 'platform.enabled_locales', group: 'platform', label: 'Enabled languages', help: 'Turn off a half-translated language.', kind: 'list', schema: s.list(s.enum(['en', 'es']), { minItems: 1, max: 2 }), default: ['en', 'es'], source: 'new', tier: 'sensitive' }),
  defineSetting({ key: 'platform.default_locale', group: 'platform', label: 'Default language', help: 'Language for visitors with no preference.', kind: 'enum', schema: s.enum(['en', 'es']), default: 'en', source: 'new' }),
  defineSetting({ key: 'platform.alert_recipients', group: 'platform', label: 'Platform alert recipients', help: 'Emails notified about stuck recording deletions, delivery failures and job errors (in addition to every admin and ALERT_EMAIL).', kind: 'list', schema: s.list(s.string({ min: 3, max: 200, pattern: /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/, patternHint: 'an email address' }), { max: 20 }), default: [], source: 'new', tier: 'sensitive' }),
] as const;
