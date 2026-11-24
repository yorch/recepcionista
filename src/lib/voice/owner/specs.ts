/**
 * Owner-only voice tool definitions (ElevenLabs webhook tools). They are registered on the agent next to the customer tools because
 * ElevenLabs configures tools per AGENT, not per call (the per-call initiation override can change the prompt, first message,
 * language and duration, not the tool list: UNVERIFIED against the live API, see docs/owner-call-in.md). The tool route therefore
 * REFUSES every one of them unless the call row is kind 'owner' (set server-side from the verified owner caller id). They are kept
 * out of TOOL_NAMES on purpose, so the customer prompt and its tool list are unchanged.
 */
export const OWNER_TOOL_NAMES = ['propose_kb_change', 'list_recent_changes', 'undo_last_change'] as const;
export type OwnerToolName = (typeof OWNER_TOOL_NAMES)[number];

export interface OwnerToolSpec { description: string; properties: Record<string, unknown>; required: string[] }

export const OWNER_TOOL_SPECS: Record<OwnerToolName, OwnerToolSpec> = {
  propose_kb_change: {
    description: 'OWNER LINE ONLY. Propose ONE change. First call with confirmed=false: it returns a read-back sentence to say to the owner. After the owner says yes, call again with identical details and confirmed=true: it texts the owner a confirmation code. The change is never live until the owner replies YES to that text. Services, FAQs and pricing notes change what the receptionist KNOWS. set_hours, add_closed_dates, remove_closed_dates and set_service_area change the REAL settings: they decide which times can be booked and what areas are served, so use them (never set_notice) whenever the owner changes opening hours, closes for a date, or changes where they work. set_notice is only extra words the receptionist may mention; it does not change what can be booked.',
    properties: {
      change_type: { type: 'string', enum: ['set_service', 'remove_service', 'add_faq', 'remove_faq', 'set_notice', 'clear_notice', 'add_pricing_note', 'set_hours', 'add_closed_dates', 'remove_closed_dates', 'set_service_area'], description: 'set_service = add a service or change its price/duration/description; remove_service; add_faq = add or replace a question and answer; remove_faq; set_hours = open/close times for some days, or closed on those days (real booking hours); add_closed_dates / remove_closed_dates = holiday closures on exact dates (real); set_service_area = the full list of places served (real); set_notice / clear_notice = informational wording only (kind closure, or other words), NEVER for hours or the service area; add_pricing_note.' },
      service_name: { type: 'string', description: 'Service name (set_service / remove_service).' },
      price: { type: 'number', description: 'Starting price in whole dollars, e.g. 99 (set_service).' },
      duration_minutes: { type: 'number', description: 'Typical duration in minutes (set_service).' },
      description: { type: 'string', description: 'Short description (set_service).' },
      question: { type: 'string', description: 'The FAQ question (add_faq / remove_faq).' },
      answer: { type: 'string', description: 'The FAQ answer (add_faq).' },
      notice_kind: { type: 'string', enum: ['closure', 'hours', 'service_area'], description: 'What the informational notice is about (set_notice / clear_notice). Use closure for extra wording only; hours and service_area notices are refused, use the real operations.' },
      text: { type: 'string', description: 'The notice or pricing note wording, e.g. "Closed for lunch 12 to 1" (set_notice / add_pricing_note).' },
      days: { type: 'array', items: { type: 'string' }, description: 'Days of the week for set_hours, e.g. ["monday","tuesday"], or "weekdays" / "weekends" / "every day".' },
      open_time: { type: 'string', description: 'Opening time for set_hours, e.g. "8:00 AM" or "08:00".' },
      close_time: { type: 'string', description: 'Closing time for set_hours, e.g. "5:00 PM" or "17:00". Same day as opening.' },
      closed: { type: 'boolean', description: 'set_hours: true = closed all day on those days (no times needed).' },
      dates: { type: 'array', items: { type: 'string' }, description: 'EXACT calendar dates as YYYY-MM-DD in the business time zone (add_closed_dates / remove_closed_dates), e.g. ["2026-12-25"]. Work out the year; the read-back repeats the weekday so the owner can catch a wrong date.' },
      areas: { type: 'array', items: { type: 'string' }, description: 'The COMPLETE list of cities / counties served (set_service_area): it replaces the current list.' },
      confirmed: { type: 'boolean', description: 'false = only read the change back. true = ONLY after the owner clearly said yes to the exact read-back.' },
    },
    required: ['change_type', 'confirmed'],
  },
  list_recent_changes: {
    description: 'OWNER LINE ONLY. List the most recent knowledge changes and whether each was applied, cancelled or reverted.',
    properties: {},
    required: [],
  },
  undo_last_change: {
    description: 'OWNER LINE ONLY. Ask to revert the most recent applied change. It texts the owner a code; the change is reverted only when the owner replies UNDO with that code.',
    properties: {},
    required: [],
  },
};
