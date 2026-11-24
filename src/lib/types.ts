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
}

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
}

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
}

export interface BriefingStats {
  calls: number;
  bookings: number;
  /** INTEGER CENTS */
  revenue: number;
  flags: number;
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

export interface SmsLog {
  id: ID;
  business_id: ID;
  to_phone: string;
  body: string;
  kind: 'confirmation' | 'payment_link' | 'gratitude' | 'review_request' | 'owner_alert' | 'manual' | 'other';
  /** Which booking this message belongs to — makes confirmation dedupe exact. */
  booking_id?: ID | null;
  provider_id?: string | null;
  status: 'queued' | 'sent' | 'failed' | 'mock' | 'blocked_opt_out' | 'blocked_quiet_hours' | 'blocked_no_consent' | 'blocked_cap' | 'blocked_owner_unverified';
  /** Why this text was allowed, e.g. 'transactional_booking' | 'caller_initiated' | 'express_opt_in' | 'owner_alert'. */
  consent_basis?: string | null;
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
  business_id: ID | null;
  role: UserRole;
  created_at: string;
  disabled_at: string | null;
  email_verified_at: string | null;
  /** E.164 or null. */
  phone: string | null;
  /** True once TOTP enrolment was confirmed. The secret itself never leaves src/lib/db/users.ts. */
  totp_enabled: boolean;
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
  ip: string | null;
  user_agent: string | null;
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
