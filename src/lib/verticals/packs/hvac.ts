import { GREETING, HOURS_TRADE, L } from '../common';
import type { VerticalPack } from '../types';

/** HVAC: the original behaviour of the product and the default for every business without a vertical. Wording is kept byte-compatible with the previous hard-coded prompt. */
export const hvac: VerticalPack = {
  id: 'hvac',
  label: L('HVAC', 'Aire acondicionado y calefacción'),
  blurb: L('Air conditioning and heating repair, maintenance and installation.', 'Reparación, mantenimiento e instalación de aire acondicionado y calefacción.'),
  persona: L('a home-services trade company', 'una empresa de servicios para el hogar'),
  provider: L('technician', 'técnico'),
  services: [
    { name: L('AC Repair', 'Reparación de aire acondicionado'), description: L('Diagnose and repair air conditioning failures', 'Diagnóstico y reparación de fallas del aire acondicionado'), base_price: 120, duration_minutes: 90 },
    { name: L('AC Maintenance / Tune-up', 'Mantenimiento del aire acondicionado'), description: L('Seasonal inspection, coil cleaning, refrigerant check', 'Inspección de temporada, limpieza de serpentines, revisión de refrigerante'), base_price: 89, duration_minutes: 60 },
    { name: L('AC Installation / Replacement', 'Instalación o reemplazo de aire acondicionado'), description: L('Full unit replacement with new equipment', 'Reemplazo completo del equipo por uno nuevo'), base_price: 2500, duration_minutes: 240 },
    { name: L('Emergency AC Service', 'Servicio de emergencia de aire acondicionado'), description: L('Same-day urgent repair for no-cooling situations', 'Reparación urgente el mismo día cuando no enfría'), base_price: 195, duration_minutes: 90 },
  ],
  hours: HOURS_TRADE,
  faqs: [
    { question: L('Do you offer same-day service?', '¿Ofrecen servicio el mismo día?'), answer: L('Yes, we offer same-day emergency service — call and we will find the earliest slot.', 'Sí, ofrecemos servicio de emergencia el mismo día: llame y buscamos el primer horario.') },
    { question: L('How much does a repair cost?', '¿Cuánto cuesta una reparación?'), answer: L('Repairs start around $120 depending on the issue; the technician confirms pricing after diagnosis.', 'Las reparaciones empiezan alrededor de $120 según el problema; el técnico confirma el precio después del diagnóstico.') },
  ],
  pricing: {
    notes: L(
      'All prices are starting prices and vary by equipment and job scope. The technician confirms the exact price after diagnosis, before any work begins.',
      'Todos los precios son precios iniciales y varían según el equipo y el trabajo. El técnico confirma el precio exacto después del diagnóstico, antes de empezar.',
    ),
    confirmLine: L('the technician confirms the exact price after diagnosis, before any work begins', 'el técnico confirma el precio exacto después del diagnóstico, antes de empezar cualquier trabajo'),
    unpriced: L('price on diagnosis', 'precio después del diagnóstico'),
    fallbackService: { name: L('Service call', 'Visita de servicio'), description: L('General diagnosis and repair', 'Diagnóstico y reparación en general') },
  },
  deposits: { defaultOn: true },
  emergency: {
    enabled: true,
    rules: [
      L('Water leaking from the system or around it', 'Agua goteando del equipo o a su alrededor'),
      L('No cooling AND a vulnerable occupant (baby, elderly, sick person) in the home', 'Sin enfriamiento Y una persona vulnerable (bebé, adulto mayor, enfermo) en la casa'),
      L('A burning smell or smoke from the unit', 'Olor a quemado o humo del equipo'),
      L('Complete system failure during extreme heat', 'Falla total del sistema durante calor extremo'),
    ],
    triage: L('water leaking? anyone vulnerable at home? burning smell? total failure in extreme heat?', '¿agua goteando? ¿alguien vulnerable en casa? ¿olor a quemado? ¿falla total con calor extremo?'),
    keywords: [
      'leaking', 'leak', 'water', 'flooding', 'flood', 'no cooling', 'not cooling',
      'burning', 'smoke', 'sparks', 'gas smell', 'emergency', 'dead unit',
      'agua', 'goteando', 'gotea', 'fuga', 'inundación', 'inundacion', 'humo',
      'quemado', 'olor a quemado', 'no enfría', 'no enfria', 'calor', 'emergencia',
    ],
    strong: ['leaking', 'leak', 'flood', 'burning', 'smoke', 'sparks', 'fuga', 'humo', 'quemado', 'inundacion', 'inundación'],
    vulnerable: true,
    call911: L(
      'If there is a gas smell, carbon monoxide, smoke, fire or anyone in danger, hang up and call 911 right now.',
      'Si huele a gas, hay monóxido de carbono, humo, fuego o alguien en peligro, cuelgue y llame al 911 ahora mismo.',
    ),
    call911For: ['gas', 'carbon_monoxide', 'smoke', 'fire'],
    none: null,
  },
  prompt: {
    greeting: GREETING,
    qualifying: [
      L('What is the equipment doing (not cooling, not heating, noise, leak)?', '¿Qué hace el equipo (no enfría, no calienta, ruido, fuga)?'),
      L('Roughly how old is the system, and is it a house or a business?', '¿Más o menos qué edad tiene el sistema, y es una casa o un negocio?'),
    ],
    mixExample: L('"Hola, my AC is not cooling"', '"Hola, my AC is not cooling"'),
    mixTerms: L('"el AC", "la unidad", "the compressor"', '"el AC", "la unidad", "el compresor"'),
  },
  script: {
    triage: L(
      "Before we book — is there any water leaking, a burning smell, or anyone at home who's elderly, a baby, or sick, with no cooling right now?",
      'Antes de agendar — ¿hay agua goteando, algún olor a quemado, o alguien en la casa (un bebé, un adulto mayor o alguien enfermo) sin aire ahora mismo?',
    ),
    booking: L(
      "I can get a technician out to you. I have [slot 1] or [slot 2] — which works better? And what's the service address? I'll use the number you're calling from, unless you'd like me to use a different one.",
      'Puedo mandarle un técnico. Tengo [opción 1] u [opción 2] — ¿cuál le queda mejor? ¿Y la dirección del servicio? Usaré el número desde el que llama, a menos que prefiera darme otro.',
    ),
  },
  sms: { fallbackService: L('service', 'servicio'), confirmationNote: null },
  briefing: { providerWord: L('el tech', 'el tech'), tradeWords: 'booked, deposit, tech, the service names' },
  hints: {
    spanishWords: ['ac', 'aire'],
    testPhrase: L('Hola, my AC is not cooling.', 'Hola, my AC is not cooling.'),
    servicePlaceholder: L('Service name, e.g. AC repair', 'Nombre del servicio, p. ej. reparación de AC'),
  },
};
