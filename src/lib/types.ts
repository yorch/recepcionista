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
}

export interface Booking {
  id: ID;
  call_id?: ID | null;
  business_id: ID;
  customer_name: string;
  customer_phone: string;
  service: string;
  scheduled_at: string;           // ISO
  address?: string | null;
  price_estimate?: number | null;
  deposit_amount?: number | null;
  deposit_paid: boolean;
  status: BookingStatus;
  created_at: string;
}

export interface BriefingStats {
  calls: number;
  bookings: number;
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
  kind: 'confirmation' | 'payment_link' | 'gratitude' | 'review_request' | 'owner_alert' | 'other';
  provider_id?: string | null;
  status: 'queued' | 'sent' | 'failed' | 'mock';
  created_at: string;
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
