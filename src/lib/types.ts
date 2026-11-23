// Shared domain contracts. Every workstream codes against these.
// Do not change a field name without telling the lead.

export type ID = string;

export type BusinessStatus = 'onboarding' | 'live' | 'paused';
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
}

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
  status: 'queued' | 'sent' | 'failed' | 'mock' | 'blocked_opt_out' | 'blocked_quiet_hours' | 'blocked_no_consent';
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
}

export interface UserSession {
  id: ID;
  user_id: ID;
  expires_at: string;
  created_at: string;
  last_used_at: string;
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
