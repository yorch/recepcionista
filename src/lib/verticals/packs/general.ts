import { CALL_911_GENERIC, GREETING, HOURS_OFFICE, L, NO_EMERGENCY_RULES } from '../common';
import type { VerticalPack } from '../types';

/** A neutral pack for any local service business that is none of the others. Nothing trade-specific. */
export const general: VerticalPack = {
  id: 'general',
  label: L('Other service business', 'Otro negocio de servicios'),
  blurb: L('Any local business that takes appointments.', 'Cualquier negocio local que agende citas.'),
  persona: L('a local service business', 'un negocio local de servicios'),
  provider: L('team member', 'integrante del equipo'),
  services: [
    { name: L('Consultation', 'Consulta'), description: L('A first visit to understand what you need and give a quote', 'Una primera visita para entender lo que necesita y dar una cotización'), base_price: 75, duration_minutes: 60 },
    { name: L('Standard Service', 'Servicio estándar'), description: L('Our most common service', 'Nuestro servicio más común'), base_price: 120, duration_minutes: 90 },
    { name: L('Follow-up Visit', 'Visita de seguimiento'), description: L('A return visit for earlier work', 'Una visita de regreso por un trabajo anterior'), base_price: 60, duration_minutes: 45 },
  ],
  hours: HOURS_OFFICE,
  faqs: [
    { question: L('How do I book an appointment?', '¿Cómo agendo una cita?'), answer: L('Call us and tell us what you need. We will offer the next open times and text you a confirmation.', 'Llámenos y díganos lo que necesita. Le ofrecemos los próximos horarios y le enviamos una confirmación por texto.') },
    { question: L('How much does it cost?', '¿Cuánto cuesta?'), answer: L('We give a starting price on the phone and confirm the final price before any work begins.', 'Damos un precio inicial por teléfono y confirmamos el precio final antes de empezar cualquier trabajo.') },
    { question: L('Can I change or cancel my appointment?', '¿Puedo cambiar o cancelar mi cita?'), answer: L('Yes, call us or reply to your confirmation text.', 'Sí, llámenos o responda al texto de confirmación.') },
  ],
  pricing: {
    notes: L(
      'All prices are starting prices. The final price is confirmed before any work begins.',
      'Todos los precios son precios iniciales. El precio final se confirma antes de empezar cualquier trabajo.',
    ),
    confirmLine: L('the team confirms the final price before any work begins', 'el equipo confirma el precio final antes de empezar cualquier trabajo'),
    unpriced: L('price on quote', 'precio según cotización'),
    fallbackService: { name: L('Service visit', 'Visita de servicio'), description: L('General service', 'Servicio en general') },
  },
  deposits: { defaultOn: false },
  emergency: {
    enabled: false, rules: [], triage: L('', ''), keywords: [], strong: [], vulnerable: false,
    call911: CALL_911_GENERIC, call911For: ['danger_to_life'], none: NO_EMERGENCY_RULES,
  },
  prompt: {
    greeting: GREETING,
    qualifying: [
      L('What do they need, and when would suit them?', '¿Qué necesitan, y cuándo les acomodaría?'),
      L('Is this their first visit with us?', '¿Es su primera visita con nosotros?'),
    ],
    mixExample: L('"Hola, I need una cita"', '"Hola, I need una cita"'),
    mixTerms: L('"la cita", "the quote", "el servicio"', '"la cita", "la cotización", "el servicio"'),
  },
  script: {
    triage: L(
      'To get you the right appointment — what do you need, and is this your first visit with us?',
      'Para darle la cita correcta — ¿qué necesita, y es su primera visita con nosotros?',
    ),
    booking: L(
      "I can book that for you. I have [slot 1] or [slot 2] — which works better? And what's the address, if we are coming to you? I'll use the number you're calling from, unless you'd like me to use a different one.",
      'Se lo puedo agendar. Tengo [opción 1] u [opción 2] — ¿cuál le queda mejor? ¿Y la dirección, si vamos a su domicilio? Usaré el número desde el que llama, a menos que prefiera darme otro.',
    ),
  },
  sms: { fallbackService: L('appointment', 'cita'), confirmationNote: null },
  briefing: { providerWord: L('el equipo', 'el equipo'), tradeWords: 'booked, deposit, the service names' },
  hints: {
    spanishWords: ['cita', 'servicio'],
    testPhrase: L('Hola, I would like to book an appointment.', 'Hola, quisiera agendar una cita.'),
    servicePlaceholder: L('Service name', 'Nombre del servicio'),
  },
};
