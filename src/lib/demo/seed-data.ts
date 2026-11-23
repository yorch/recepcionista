/**
 * The canonical demo dataset. Shared by scripts/seed.ts (CLI) and the
 * /api/demo/reset route so both produce identical demo state.
 */
import crypto from 'node:crypto';
import { addDaysToDateKey, DEFAULT_TIMEZONE, localDateKey, zonedTimeToUtc } from '../time';
import { phoneKey } from '../format';

const id = () => crypto.randomUUID();

export const DEMO_BUSINESS_ID = 'biz_miami_cool_air';

export const DEMO_TIMEZONE = DEFAULT_TIMEZONE; // Miami

/**
 * Wall-clock `h:m` on the local day `offset` days from today, in the demo business's zone.
 * Evaluated on every call (never frozen at import) so a long-running server stays fresh.
 */
const day = (offset: number, h: number, m = 0) => {
  const today = localDateKey(new Date(), DEMO_TIMEZONE);
  return zonedTimeToUtc(addDaysToDateKey(today, offset), { h, m }, DEMO_TIMEZONE);
};

export const SYSTEM_PROMPT = `Eres Maria, la recepcionista bilingüe de Miami Cool Air Conditioning.
You answer the phone in English, Spanish, or Spanglish — whichever the caller uses, and you switch the moment they do.

BUSINESS: Miami Cool Air Conditioning — AC repair, installation and maintenance. Serving Miami-Dade since 2009.
HOURS: Mon–Fri 8:00–18:00, Sat 9:00–14:00, closed Sunday.
SERVICE AREA: Miami, Hialeah, Doral, Kendall, Miami Beach, Little Havana, Coral Gables, Homestead.
SERVICES & PRICING (starting prices, never quote above these without checking):
- AC diagnostic visit — $89 (waived if repaired same day)
- AC repair (common fixes) — from $150
- Full system installation — from $3,200
- Seasonal maintenance / tune-up — $129
- Duct cleaning — from $350
- Emergency after-hours service — $189 call-out + parts

CALL FLOW:
1. Greet bilingually. Identify the need.
2. TRIAGE every call: "Is water leaking? Is the system completely dead? Is anyone elderly, a baby, or unwell in the home?" If yes to any → EMERGENCY.
3. Emergency → collect name, address, phone, confirm someone will be home, then offer the $189 emergency deposit by text link. Call flag_emergency.
4. Routine → offer the next 2–3 open slots from check_availability. Confirm name, phone, address. Create the booking, then send the confirmation SMS.
5. Never invent a price. If a service isn't listed, say you'll have the owner call back and use handoff_to_human.

RULES:
- Reply in the caller's language. Mixed Spanglish in → match their dominant language, keep the trade terms they use ("el AC", "the compressor").
- Warm, Miami-local, efficient. No corporate filler.
- Confirm every booking detail back to the caller before creating it.
- Never give medical or legal advice. Health emergency → "Please call 911 / llame al 911."
- Deposit cap: $500. Never take payment over the phone; always send the secure link.`;

export const CALL_SCRIPT = `Opening: "Gracias por llamar a Miami Cool Air, le habla Maria. ¿En qué le puedo ayudar? — Thanks for calling Miami Cool Air, this is Maria. How can I help?"
Triage: "¿Está goteando agua? / Is it leaking water? ¿Hay alguien mayor o un bebé en la casa? / Is anyone elderly or a baby at home?"
Booking: "I have tomorrow at 10 AM or 2 PM open — ¿cuál le funciona mejor? / which works better?"
Close: "Listo, le mando la confirmación por texto ahora. / All set, I'm sending your confirmation by text now."`;

export const DEMO_HOURS = {
  monday: { open: '08:00', close: '18:00' },
  tuesday: { open: '08:00', close: '18:00' },
  wednesday: { open: '08:00', close: '18:00' },
  thursday: { open: '08:00', close: '18:00' },
  friday: { open: '08:00', close: '18:00' },
  saturday: { open: '09:00', close: '14:00' },
  sunday: null,
};

export const DEMO_SERVICES = [
  { name: 'AC diagnostic visit', description: 'Full inspection and written diagnosis', base_price: 89, duration_minutes: 60 },
  { name: 'AC repair', description: 'Common fixes: capacitor, contactor, refrigerant leak, blower motor', base_price: 150, duration_minutes: 120 },
  { name: 'Full system installation', description: 'Remove old unit, install and commission new system', base_price: 3200, duration_minutes: 480 },
  { name: 'Seasonal maintenance', description: 'Coil clean, filter change, refrigerant check', base_price: 129, duration_minutes: 60 },
  { name: 'Duct cleaning', description: 'Whole-home duct vacuum and sanitize', base_price: 350, duration_minutes: 180 },
  { name: 'Emergency after-hours service', description: 'Same-night call-out, 6 PM–11 PM', base_price: 189, duration_minutes: 90 },
];

export const DEMO_FAQS = [
  { question: 'Do you charge for a diagnostic?', answer: 'The diagnostic is $89 and it is waived if we do the repair the same day.' },
  { question: '¿Atienden en español?', answer: 'Sí, claro. Todo el equipo habla español.' },
  { question: 'How fast can you come out?', answer: 'Routine visits are usually next business day. Emergencies are same night when we have a tech on call.' },
  { question: 'Do you offer financing?', answer: 'Yes, on full system installations we offer 12-month financing.' },
  { question: 'What brands do you service?', answer: 'All major brands — Carrier, Trane, Rheem, Goodman, Lennox, and mini-splits.' },
];

export const DEMO_PRICING_NOTES =
  'Diagnostic $89 (waived if repaired same day). Repairs from $150. Installation from $3,200. Maintenance $129. Duct cleaning from $350. Emergency call-out $189 after 6 PM.';

export function demoBusiness() {
  return {
    id: DEMO_BUSINESS_ID,
    name: 'Miami Cool Air Conditioning',
    url: 'https://miamicoolair.example.com',
    phone: '+13055550142',
    phoneKey: phoneKey('+13055550142'),
    timezone: DEMO_TIMEZONE,
    ownerPhone: '+13055550199',
    ownerName: 'Jorge',
    hours: DEMO_HOURS,
    serviceArea: ['Miami', 'Hialeah', 'Doral', 'Kendall', 'Miami Beach', 'Little Havana', 'Coral Gables', 'Homestead'],
    status: 'live',
    createdAt: day(-14, 9),
  };
}

export function demoCalls() {
  return [
    {
      id: 'call_demo_1', businessId: DEMO_BUSINESS_ID, callerPhone: '+13055550188', callerName: 'Marisol',
      startedAt: day(-1, 9, 12), endedAt: day(-1, 9, 16), durationSec: 247, language: 'mixed',
      transcript: 'Maria: Gracias por llamar a Miami Cool Air... Marisol: Hi, mira, my AC stopped cooling last night, hace mucho calor. Maria: No problem. Is it leaking water? Marisol: No leak, it just blows warm air. Maria: Is anyone elderly or a baby at home? Marisol: My mom, she is 78. Maria: Okay, I can get a tech out today. I have 2 PM or 4 PM. Marisol: 2 PM works. Maria: Perfect, sent you the confirmation.',
      summary: 'AC blowing warm, no leak. Elderly resident at home -> prioritized same-day. Booked 2 PM.',
      urgency: 'routine', status: 'completed', recordingUrl: null, flaggedReason: null,
    },
    {
      id: 'call_demo_2', businessId: DEMO_BUSINESS_ID, callerPhone: '+13055550177', callerName: 'Danny',
      startedAt: day(-1, 14, 3), endedAt: day(-1, 14, 8), durationSec: 312, language: 'en',
      transcript: "Danny: Hey, water is pouring out of my ceiling unit. Maria: That is an emergency. Is the unit still running? Danny: I cut the breaker. Maria: Good. Is anyone vulnerable in the home? Danny: Just me and my dog. Maria: I need a $189 emergency deposit to hold tonight's tech. Sending the link now.",
      summary: 'Ceiling unit leaking heavily, breaker cut, no vulnerable occupants. Emergency deposit link sent ($189).',
      urgency: 'emergency', status: 'completed', recordingUrl: null, flaggedReason: 'Emergency: water leak, needs same-night tech',
    },
    {
      id: 'call_demo_3', businessId: DEMO_BUSINESS_ID, callerPhone: '+13055550166', callerName: 'Rosa',
      startedAt: day(0, 8, 41), endedAt: day(0, 8, 44), durationSec: 183, language: 'es',
      transcript: 'Rosa: Buenas, quiero mantenimiento para el AC, nada mas rutina. Maria: Claro, para que dia? Rosa: El sabado por la manana si se puede. Maria: Tengo 9 AM. Rosa: Perfecto. Maria: Le mando el texto con la confirmacion.',
      summary: 'Routine seasonal maintenance, booked Saturday 9 AM. Spanish-language call.',
      urgency: 'routine', status: 'completed', recordingUrl: null, flaggedReason: null,
    },
    {
      id: 'call_demo_4', businessId: DEMO_BUSINESS_ID, callerPhone: '+13055550155', callerName: 'Luis',
      startedAt: day(0, 11, 22), endedAt: day(0, 11, 25), durationSec: 96, language: 'es',
      transcript: 'Luis: Hola, cuanto cuesta instalar un mini-split en un garaje? Maria: Instalacion desde $3,200 dependiendo del equipo. Luis: Okay, mejor me pasas con el dueno. Maria: Claro, le dejo el mensaje.',
      summary: 'Mini-split install quote for garage, outside standard scope -> handed off to owner.',
      urgency: 'unsure', status: 'handed_off', recordingUrl: null, flaggedReason: 'Owner callback requested: custom mini-split install quote',
    },
  ];
}

export function demoBookings() {
  return [
    {
      id: 'bk_demo_1', callId: 'call_demo_1', businessId: DEMO_BUSINESS_ID, customerName: 'Marisol Vega',
      customerPhone: '+13055550188', service: 'AC repair', scheduledAt: day(0, 14), durationMinutes: 120,
      address: '1420 SW 8th St, Miami, FL 33135', priceEstimate: 15000, depositAmount: null,
      depositPaid: false, status: 'confirmed', createdAt: day(-1, 9, 16),
    },
    {
      id: 'bk_demo_2', callId: 'call_demo_2', businessId: DEMO_BUSINESS_ID, customerName: 'Danny Ortiz',
      customerPhone: '+13055550177', service: 'Emergency after-hours service', scheduledAt: day(-1, 20), durationMinutes: 90,
      address: '880 NE 79th St, Miami, FL 33138', priceEstimate: 18900, depositAmount: 18900,
      depositPaid: true, status: 'completed', createdAt: day(-1, 14, 8),
    },
    {
      id: 'bk_demo_3', callId: 'call_demo_3', businessId: DEMO_BUSINESS_ID, customerName: 'Rosa Menendez',
      customerPhone: '+13055550166', service: 'Seasonal maintenance', scheduledAt: day(2, 9), durationMinutes: 60,
      address: '2290 W Flagler St, Miami, FL 33135', priceEstimate: 12900, depositAmount: null,
      depositPaid: false, status: 'confirmed', createdAt: day(0, 8, 44),
    },
  ];
}

export function demoBriefing() {
  return {
    id: 'br_demo_1',
    businessId: DEMO_BUSINESS_ID,
    date: addDaysToDateKey(localDateKey(new Date(), DEMO_TIMEZONE), -1),
    audioUrl: null,
    transcript:
      'Hola Jorge. Ayer tuviste tres llamadas. Dos se convirtieron en citas: Marisol Vega hoy a las dos de la tarde por reparacion de AC, y Rosa Menendez el sabado a las nueve para mantenimiento. Also Danny Ortiz — an emergency water leak, he paid the one-eighty-nine deposit, tech finished last night. Se cobro $189 en depositos. Una cosa necesita tu atencion: Luis pidio una cotizacion de mini-split para garaje, te deje el numero. Eso es todo. Buen trabajo.',
    stats: { calls: 3, bookings: 2, revenue: 18900, flags: 1 }, // revenue in integer cents
    createdAt: day(-1, 18),
  };
}

export function demoMessages() {
  return [
    {
      id: id(), businessId: DEMO_BUSINESS_ID, toPhone: '+13055550188', bookingId: 'bk_demo_1',
      body: 'Miami Cool Air: Confirmado — AC repair, hoy 2:00 PM, 1420 SW 8th St. Estimate $150. Reply C to cancel. Gracias Marisol!',
      kind: 'confirmation', providerId: 'SM_demo_1', status: 'sent', createdAt: day(-1, 9, 17),
    },
    {
      id: id(), businessId: DEMO_BUSINESS_ID, toPhone: '+13055550177', bookingId: 'bk_demo_2',
      body: 'Miami Cool Air: Emergency deposit $189 — secure link: https://pay.example.com/dep_189. Your tech is scheduled tonight at 8 PM.',
      kind: 'payment_link', providerId: 'SM_demo_2', status: 'sent', createdAt: day(-1, 14, 9),
    },
    {
      id: id(), businessId: DEMO_BUSINESS_ID, toPhone: '+13055550166', bookingId: 'bk_demo_3',
      body: 'Miami Cool Air: Confirmado — mantenimiento estacional, sabado 9:00 AM, 2290 W Flagler St. $129. Gracias Rosa!',
      kind: 'confirmation', providerId: 'SM_demo_3', status: 'sent', createdAt: day(0, 8, 45),
    },
  ];
}
