// Shared domain contracts. Every workstream codes against these.
// Do not change a field name without telling the lead.

export type ID = string;

export type BusinessStatus = 'onboarding' | 'live' | 'paused';
/** How inbound calls are handled: the AI answers (default), nobody answers (polite message + voicemail), or the call rings a human number. */
export type CallMode = 'ai' | 'paused' | 'forward';
export type Urgency = 'emergency' | 'routine' | 'unsure';
export type CallStatus = 'in_progress' | 'completed' | 'handed_off' | 'failed';
export type BookingStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled';

export interface Service {
  name: string;
  description?: string;
  /** Catalog price in whole DOLLARS (the only dollar-denominated value; use dollarsToCents). */
  base_price?: number | null;
  duration_minutes?: number;
}

export interface FAQ {
  question: string;
  answer: string;
}

export interface Hours {
  [day: string]: { open: string; close: string } | null;
}

export interface Business {
  id: ID;
  name: string;
  url?: string | null;
  phone?: string | null;          // the AI employee's number
  owner_phone?: string | null;
  owner_name?: string | null;
  hours: Hours;
  service_area: string[];
  /** Holiday closures (YYYY-MM-DD in the business zone, at most 366): no slots on these dates whatever `hours` says. */
  closed_dates?: string[];
  status: BusinessStatus;
  agent_id?: string | null;
  /** IANA zone, e.g. America/New_York. Defaults to America/New_York when absent. */
  timezone?: string;
  /** PII retention window in days (default 365). */
  retention_days?: number;
  /** Custom recording disclosure spoken at call start; null = default text. */
  recording_disclosure_text?: string | null;
  created_at: string;
  /** E.164 forms (null when the stored number could not be normalised). */
  phone_e164?: string | null;
  owner_phone_e164?: string | null;
  owner_phone_verified_at?: string | null;
  /** Call handling mode (default 'ai'). See src/lib/voice/call-mode.ts. */
  call_mode?: CallMode;
  /** The human number 'forward' rings, as stored, and its E.164 form. */
  forward_number?: string | null;
  forward_number_e164?: string | null;
  /** When the SMS-code verification of the forward number succeeded (null = not verified; it is never dialled). */
  forward_number_verified_at?: string | null;
  /** 'forward' only during business hours; the AI answers outside them. */
  forward_during_hours?: boolean;
  /** Default dashboard/text language (default 'en'). */
  locale_default?: Locale;
  /** Trade the default prompt/templates are written for (default 'hvac'). */
  vertical?: Vertical;
  /** Chosen ElevenLabs voice; null = platform default. */
  voice_id?: string | null;
  voice_name?: string | null;
  /** Deposit refund policy on cancellation (default 'full_24h') and optional free text (<= 2000 chars). */
  refund_policy?: RefundPolicy;
  refund_policy_text?: string | null;
  /** Subscription cadence (default 'month'). */
  billing_interval?: BillingInterval;
  /** Billing. Absent/'none' on legacy and demo tenants (only enforced when BILLING_ENFORCED=true). */
  billing_status?: BillingStatus;
  plan?: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  trial_ends_at?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  /** When billing_status last became 'past_due' (start of the grace period). */
  past_due_since?: string | null;
  sms_cap_override?: number | null;
  call_minutes_cap_override?: number | null;
  /** This tenant's own AI line (docs/design/mock-replacement-contracts.md): the ElevenLabs phone-number id and the Twilio phone sid. The shared env ELEVENLABS_PHONE_NUMBER_ID is only a fallback. */
  elevenlabs_phone_number_id?: string | null;
  twilio_phone_sid?: string | null;
  /** Google review link (https, <= 300 chars) texted after a job; null = none. */
  review_url?: string | null;
  /** What the assistant calls itself (1-40 chars); null = platform default. */
  assistant_name?: string | null;
  /** Deposit policy. deposit_enabled=false (default) = no policy (legacy: the amount is whatever the agent / owner asks for). Cents are integers within 100..100000. */
  deposit_enabled?: boolean;
  deposit_mode?: DepositMode;
  deposit_fixed_cents?: number | null;
  deposit_percent?: number | null;
  deposit_min_cents?: number | null;
  deposit_max_cents?: number | null;
  /** Scheduling config. Defaults: 60 / 60 / 14 / 0 / 1 (see DEFAULT_SCHEDULING in src/lib/business-config.ts). */
  slot_minutes?: 15 | 30 | 60;
  min_lead_minutes?: number;
  horizon_days?: number;
  buffer_minutes?: number;
  crews?: number;
  /** Go-live confirmation of the template content (see contentConfirmationState). */
  content_confirmed_at?: string | null;
  content_confirmed_hash?: string | null;
  /** Opt-in: the provider's native call transfer to the owner (default false). */
  native_transfer_enabled?: boolean;
}

export type DepositMode = 'fixed' | 'percent';
export const DEPOSIT_SOURCES = ['stripe', 'manual'] as const;
export type DepositSource = (typeof DEPOSIT_SOURCES)[number];
export const BOOKING_CREATED_VIA = ['ai', 'dashboard', 'sms', 'api', 'system'] as const;
export type BookingCreatedVia = (typeof BOOKING_CREATED_VIA)[number];

export type Locale = 'en' | 'es';
export const LOCALES: readonly Locale[] = ['en', 'es'];
export type Vertical = 'hvac' | 'plumbing' | 'electrical' | 'cleaning' | 'landscaping' | 'dental' | 'general';
export const VERTICALS: readonly Vertical[] = ['hvac', 'plumbing', 'electrical', 'cleaning', 'landscaping', 'dental', 'general'];
export type RefundPolicy = 'none' | 'full_24h' | 'full_48h' | 'full_always';
export const REFUND_POLICIES: readonly RefundPolicy[] = ['none', 'full_24h', 'full_48h', 'full_always'];
export const REFUND_POLICY_TEXT_MAX = 2000;
export type BillingInterval = 'month' | 'year';
export const BILLING_INTERVALS: readonly BillingInterval[] = ['month', 'year'];

export type BillingStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid';

export interface KnowledgeBase {
  id: ID;
  business_id: ID;
  services: Service[];
  faqs: FAQ[];
  pricing_notes: string;
  system_prompt: string;
  call_script: string;
  updated_at: string;
}

export interface Call {
  id: ID;
  business_id: ID;
  /** Telephony call SID (Twilio/ElevenLabs) — the reliable way to match a live call. */
  call_sid?: string | null;
  /** ElevenLabs conversation id (system__conversation_id) — the key the post-call webhook correlates on. */
  conversation_id?: string | null;
  caller_phone?: string | null;
  caller_name?: string | null;
  started_at: string;
  ended_at?: string | null;
  duration_sec?: number | null;
  language?: 'en' | 'es' | 'mixed' | null;
  transcript?: string | null;
  summary?: string | null;
  urgency: Urgency;
  status: CallStatus;
  recording_url?: string | null;
  flagged_reason?: string | null;
  /** True once the recording disclosure was spoken to the caller. */
  recording_disclosed?: boolean;
  consent_status?: ConsentStatus;
  /** 'customer' (default) or 'owner' (the owner phoned in to update the knowledge base). */
  kind?: CallKind;
  /** Live transfer to a human (default 'none'). */
  transfer_status?: TransferStatus;
  /** Twilio StirStatus (verstat) as received, e.g. 'TN-Validation-Passed-A'. */
  stir_status?: string | null;
  /** True when STIR/SHAKEN verified the number (attestation A); null = not evaluated. */
  caller_verified?: boolean | null;
  /** When this call's usage was added to the counters; null = not metered yet. */
  metered_at?: string | null;
  /** Reconcile attempts so far. */
  reconcile_attempts?: number;
}

export type CallKind = 'customer' | 'owner';
export type TransferStatus = 'none' | 'attempted' | 'connected' | 'failed' | 'declined';
export const TRANSFER_STATUSES: readonly TransferStatus[] = ['none', 'attempted', 'connected', 'failed', 'declined'];

export type ConsentStatus = 'unknown' | 'disclosed' | 'declined';

export interface Booking {
  id: ID;
  call_id?: ID | null;
  business_id: ID;
  customer_name: string;
  customer_phone: string;
  service: string;
  scheduled_at: string;           // ISO
  /** Job length; blocks [scheduled_at, scheduled_at + duration). Default 60. */
  duration_minutes?: number;
  address?: string | null;
  /** INTEGER CENTS */
  price_estimate?: number | null;
  /** INTEGER CENTS */
  deposit_amount?: number | null;
  deposit_paid: boolean;
  status: BookingStatus;
  created_at: string;
  /** Set when customer PII was removed (retention/erasure); financial fields stay. */
  anonymized_at?: string | null;
  /** When the customer was told about follow-up (gratitude) texts; null = no recorded consent. */
  followup_consent_at?: string | null;
  followup_consent_source?: string | null;
  /** Rebook lineage: the booking this one replaced. */
  rescheduled_from_id?: ID | null;
  /** How many times the booking was moved (rescheduleBooking). */
  reschedule_count?: number;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  /** When the customer was last told about a cancel/reschedule; null = not notified. */
  customer_notified_at?: string | null;
  stripe_payment_intent_id?: string | null;
  stripe_checkout_session_id?: string | null;
  refund_status?: RefundStatus;
  /** INTEGER CENTS refunded. */
  refund_amount_cents?: number | null;
  stripe_refund_id?: string | null;
  refunded_at?: string | null;
  /** Card dispute on the deposit (Stripe charge.dispute.* events): none | open | won | lost. */
  dispute_status?: DisputeStatus;
  /** How the deposit was paid: 'stripe' | 'manual' (owner marked it) | null (unknown / unpaid). */
  deposit_source?: DepositSource | null;
  /** Who (user id / 'admin_token') and when marked the deposit paid manually. */
  deposit_marked_by?: string | null;
  deposit_marked_at?: string | null;
  /** Where the booking came from (default 'ai'). */
  created_via?: BookingCreatedVia;
  /** Crew 1..businesses.crews the job is assigned to (default 1). */
  crew?: number;
}

export type DisputeStatus = 'none' | 'open' | 'won' | 'lost';
export type RefundStatus = 'none' | 'pending' | 'refunded' | 'failed' | 'not_applicable';

export interface BriefingStats {
  calls: number;
  bookings: number;
  /** INTEGER CENTS */
  revenue: number;
  flags: number;
  /** How the transcript was written: by the AI writer, or by the automatic template (no key / provider failure). Absent on older briefings. */
  narration?: 'ai' | 'automatic';
}

export interface Briefing {
  id: ID;
  business_id: ID;
  date: string;                   // YYYY-MM-DD
  audio_url?: string | null;
  transcript: string;
  stats: BriefingStats;
  created_at: string;
}

export const SMS_KINDS = ['confirmation', 'payment_link', 'gratitude', 'review_request', 'owner_alert', 'manual', 'owner_inbox_reply', 'inbox_autoreply', 'other'] as const;
export type SmsKind = (typeof SMS_KINDS)[number];

export interface SmsLog {
  id: ID;
  business_id: ID;
  to_phone: string;
  body: string;
  kind: SmsKind;
  /** Which booking this message belongs to — makes confirmation dedupe exact. */
  booking_id?: ID | null;
  provider_id?: string | null;
  status: 'queued' | 'sent' | 'failed' | 'mock' | 'blocked_opt_out' | 'blocked_quiet_hours' | 'blocked_no_consent' | 'blocked_cap' | 'blocked_owner_unverified';
  /** Why this text was allowed, e.g. 'transactional_booking' | 'caller_initiated' | 'express_opt_in' | 'owner_alert'. */
  consent_basis?: string | null;
  created_at: string;
}

export type InboundStatus = 'new' | 'handled' | 'ignored';
export const INBOUND_STATUSES: readonly InboundStatus[] = ['new', 'handled', 'ignored'];

/** A customer text received on the business's number (the owner's inbox). */
export interface InboundMessage {
  id: ID;
  business_id: ID;
  from_e164: string;
  from_phone: string;
  /** At most 1600 chars. */
  body: string;
  twilio_message_sid: string;
  received_at: string;
  status: InboundStatus;
  handled_at: string | null;
  handled_by: string | null;
  forwarded_to_owner_at: string | null;
  auto_replied_at: string | null;
  booking_id: ID | null;
}

/** Metadata of stored briefing audio (the bytes are only read by getBriefingAudio). */
export interface BriefingAudioMeta {
  briefing_id: ID;
  content_type: string;
  size_bytes: number;
  voice_id: string | null;
  created_at: string;
}

export interface SmsOptOut {
  id: ID;
  business_id: ID;
  /** Last 10 digits of the phone number. */
  phone_key: string;
  opted_out_at: string;
  source: string;
}

export type UserRole = 'owner' | 'staff' | 'admin';

export interface User {
  id: ID;
  email: string;
  /** Legacy "primary" business (kept for compatibility). Who may access which business is `Membership`. */
  business_id: ID | null;
  role: UserRole;
  created_at: string;
  disabled_at: string | null;
  email_verified_at: string | null;
  /** E.164 or null. */
  phone: string | null;
  /** True once TOTP enrolment was confirmed. The secret itself never leaves src/lib/db/users.ts. */
  totp_enabled: boolean;
  /** UI/text language (default 'en'). */
  locale?: Locale;
}

export type MembershipRole = 'owner' | 'staff';

export interface Membership {
  id: ID;
  user_id: ID;
  business_id: ID;
  role: MembershipRole;
  created_at: string;
  disabled_at: string | null;
}

/** A membership with the business name (account switcher). */
export interface MembershipWithBusiness extends Membership {
  business_name: string;
}

/** A person on a business's team: the account plus their role IN THAT business. */
export interface BusinessMember {
  user_id: ID;
  email: string;
  role: MembershipRole;
  /** Per-business disable (membership). */
  membership_disabled_at: string | null;
  /** Account-level disable (the person cannot sign in anywhere). */
  user_disabled_at: string | null;
  email_verified_at: string | null;
  totp_enabled: boolean;
  joined_at: string;
}

export type SessionKind = 'user' | 'admin_token';

export interface UserSession {
  id: ID;
  /** Null only for kind 'admin_token' (break-glass). */
  user_id: ID | null;
  kind: SessionKind;
  expires_at: string;
  created_at: string;
  last_used_at: string;
  mfa_verified_at: string | null;
  /** Last proof of identity (login or re-authentication); sensitive changes need it within 5 minutes. */
  sudo_at: string | null;
  ip: string | null;
  user_agent: string | null;
  /** The business the session is working in (multi-business accounts); null = primary / only. */
  active_business_id?: ID | null;
  /** Businesses this session may no longer act in or switch to (signed out of them, or the membership was disabled / removed). Empty = none. */
  revoked_business_ids?: ID[];
}

export type EmailTokenPurpose = 'verify' | 'reset' | 'invite';

export interface EmailToken {
  id: ID;
  user_id: ID | null;
  email: string;
  purpose: EmailTokenPurpose;
  business_id: ID | null;
  role: 'owner' | 'staff' | null;
  invited_by: ID | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export type AuditActorKind = 'user' | 'admin_token' | 'system' | 'webhook';

export interface AuditEvent {
  id: ID;
  at: string;
  actor_user_id: ID | null;
  actor_kind: AuditActorKind;
  business_id: ID | null;
  action: string;
  target: string;
  ip: string | null;
  meta: Record<string, unknown>;
}

// ── Google Calendar ──────────────────────────────────────────────────────────

export type CalendarProvider = 'google';
export type CalendarConnectionStatus = 'active' | 'needs_reauth' | 'revoked' | 'error';
export const CALENDAR_STATUSES: readonly CalendarConnectionStatus[] = ['active', 'needs_reauth', 'revoked', 'error'];

/** A calendar connection as the rest of the app sees it: NEVER carries a token (only whether one is stored). */
export interface CalendarConnection {
  id: ID;
  business_id: ID;
  connected_by_user_id: ID | null;
  provider: CalendarProvider;
  account_email: string;
  calendar_id: string;
  token_expires_at: string | null;
  scopes: string;
  has_refresh_token: boolean;
  sync_token: string | null;
  watch_channel_id: string | null;
  watch_resource_id: string | null;
  watch_expires_at: string | null;
  status: CalendarConnectionStatus;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarTokens {
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
}

export interface CalendarEventLink {
  id: ID;
  booking_id: ID;
  connection_id: ID;
  google_event_id: string;
  etag: string | null;
  last_synced_at: string;
  last_pushed_hash: string | null;
}

export type BusyTransparency = 'opaque' | 'transparent';

/** Busy time mirrored from Google. Times only: no title, description or attendee is ever stored. */
export interface CalendarBusyBlock {
  id: ID;
  connection_id: ID;
  business_id: ID;
  google_event_id: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  transparency: BusyTransparency;
  summary_redacted: boolean;
  updated_at: string;
}

// ── Owner call-in knowledge-base updates ─────────────────────────────────────

export type OwnerKbSource = 'owner_voice' | 'owner_sms' | 'dashboard';
export type OwnerKbStatus = 'proposed' | 'applied' | 'reverted' | 'rejected';
export const OWNER_KB_SOURCES: readonly OwnerKbSource[] = ['owner_voice', 'owner_sms', 'dashboard'];

/** The knowledge-base fields an owner change may touch (values are the NEW content). */
export type KbPatch = Partial<Pick<KnowledgeBase, 'services' | 'faqs' | 'pricing_notes' | 'system_prompt' | 'call_script'>> & {
  /** BUSINESS fields an owner call-in change may set for real (applied to businesses.hours / service_area / closed_dates). */
  hours?: Hours;
  service_area?: string[];
  /** Holiday closures: YYYY-MM-DD dates in the business zone (at most 366). */
  closed_dates?: string[];
};

export interface OwnerKbChange {
  id: ID;
  business_id: ID;
  call_id: ID | null;
  source: OwnerKbSource;
  status: OwnerKbStatus;
  summary: string;
  patch: KbPatch;
  /** The values `patch` replaced, captured when the change was applied (null before). */
  previous: KbPatch | null;
  applied_at: string | null;
  reverted_at: string | null;
  created_by: string | null;
  created_at: string;
}

// ── Live transcript ──────────────────────────────────────────────────────────

export type TranscriptRole = 'agent' | 'caller' | 'system';

export interface TranscriptEvent {
  call_id: ID;
  seq: number;
  role: TranscriptRole;
  text: string;
  at: string;
  is_final: boolean;
}

// ── Passkeys (WebAuthn) ──────────────────────────────────────────────────────

export type WebauthnPurpose = 'register' | 'login' | 'reauth';

/** A passkey as listed to its owner: never carries the public key. */
export interface PasskeySummary {
  id: ID;
  user_id: ID;
  credential_id: string;
  transports: string[];
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: boolean;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** What the WebAuthn verifier needs. Returned only by getPasskeyByCredentialId. */
export interface PasskeyForVerification extends PasskeySummary {
  public_key: Uint8Array;
  counter: number;
}

export interface ExtractionResult {
  name: string;
  services: Service[];
  hours: Hours;
  service_area: string[];
  faqs: FAQ[];
  pricing_notes: string;
  confidence: 'high' | 'medium' | 'low';
  source: 'scrape' | 'llm_only' | 'template';
}

export interface TimeSlot {
  start: string;                  // ISO
  end: string;
  available: boolean;
}

export interface PaymentLink {
  url: string;
  amount_cents: number;
  id: string;
}

/** Result envelope used by every API route so the UI never guesses. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };
