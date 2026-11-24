import { GREETING, HOURS_TRADE, L } from '../common';
import type { VerticalPack } from '../types';

export const plumbing: VerticalPack = {
  id: 'plumbing',
  label: L('Plumbing', 'Plomería'),
  blurb: L('Leaks, drains, water heaters and fixtures.', 'Fugas, drenajes, calentadores de agua y accesorios.'),
  persona: L('a plumbing company', 'una empresa de plomería'),
  provider: L('plumber', 'plomero'),
  services: [
    { name: L('Leak Repair', 'Reparación de fugas'), description: L('Find and fix leaking pipes, fittings and fixtures', 'Localizar y reparar tuberías, conexiones y accesorios con fugas'), base_price: 150, duration_minutes: 90 },
    { name: L('Drain Cleaning', 'Destape de drenajes'), description: L('Clear clogged sinks, tubs, toilets and main lines', 'Destape de lavamanos, tinas, inodoros y línea principal'), base_price: 125, duration_minutes: 60 },
    { name: L('Water Heater Repair / Replacement', 'Reparación o cambio de calentador de agua'), description: L('Repair or replace tank and tankless water heaters', 'Reparación o cambio de calentadores de tanque y sin tanque'), base_price: 350, duration_minutes: 180 },
    { name: L('Fixture Installation', 'Instalación de accesorios'), description: L('Faucets, toilets, sinks and disposals installed', 'Instalación de grifos, inodoros, lavabos y trituradores'), base_price: 110, duration_minutes: 90 },
    { name: L('Emergency Plumbing Service', 'Servicio de plomería de emergencia'), description: L('Same-day response for burst pipes and active flooding', 'Atención el mismo día para tuberías rotas e inundaciones'), base_price: 225, duration_minutes: 90 },
  ],
  hours: HOURS_TRADE,
  faqs: [
    { question: L('Do you offer same-day service?', '¿Ofrecen servicio el mismo día?'), answer: L('Yes, call us and we will find the earliest slot. For a burst pipe, shut off the main water valve first.', 'Sí, llámenos y buscamos el primer horario. Si hay una tubería rota, cierre primero la llave de paso principal.') },
    { question: L('How much does a drain cleaning cost?', '¿Cuánto cuesta destapar un drenaje?'), answer: L('Drain cleaning starts around $125; the plumber confirms the price once they see the problem.', 'Destapar un drenaje empieza alrededor de $125; el plomero confirma el precio cuando ve el problema.') },
    { question: L('Do you replace water heaters?', '¿Cambian calentadores de agua?'), answer: L('Yes, tank and tankless. We can usually replace a standard tank heater in one visit.', 'Sí, de tanque y sin tanque. Normalmente cambiamos un calentador de tanque en una sola visita.') },
  ],
  pricing: {
    notes: L(
      'All prices are starting prices and vary by the job. The plumber confirms the exact price once they have seen the problem, before any work begins.',
      'Todos los precios son precios iniciales y varían según el trabajo. El plomero confirma el precio exacto cuando ve el problema, antes de empezar.',
    ),
    confirmLine: L('the plumber confirms the exact price once they have seen the problem, before any work begins', 'el plomero confirma el precio exacto cuando ve el problema, antes de empezar cualquier trabajo'),
    unpriced: L('price after inspection', 'precio después de la inspección'),
    fallbackService: { name: L('Plumbing service call', 'Visita de plomería'), description: L('Inspection and repair', 'Inspección y reparación') },
  },
  deposits: { defaultOn: true },
  emergency: {
    enabled: true,
    rules: [
      L('A burst or actively leaking pipe, or water flooding the property', 'Una tubería rota o con fuga activa, o agua inundando la propiedad'),
      L('Sewage backing up into the home', 'Aguas negras regresando a la casa'),
      L('No water at all together with a vulnerable occupant (baby, elderly, sick person)', 'Sin nada de agua Y una persona vulnerable (bebé, adulto mayor, enfermo)'),
      L('A water heater leaking heavily, or any smell of gas', 'Un calentador de agua con fuga fuerte, o cualquier olor a gas'),
    ],
    triage: L('is water flowing and not stopping? is it near electrical outlets? sewage backing up? any smell of gas?', '¿está saliendo agua sin parar? ¿cerca de enchufes? ¿aguas negras regresando? ¿olor a gas?'),
    keywords: [
      'burst', 'flooding', 'flood', 'flooded', 'sewage', 'sewer', 'gas smell', 'smell gas', 'water everywhere', 'pipe broke', 'emergency', 'no water',
      'tubería rota', 'tuberia rota', 'se rompió', 'se rompio', 'inundación', 'inundacion', 'inundando', 'aguas negras', 'olor a gas', 'sin agua', 'emergencia',
    ],
    strong: ['burst', 'flooding', 'flood', 'flooded', 'sewage', 'gas smell', 'smell gas', 'pipe broke', 'water everywhere', 'tubería rota', 'tuberia rota', 'inundación', 'inundacion', 'inundando', 'aguas negras', 'olor a gas'],
    vulnerable: true,
    call911: L(
      'If there is a gas smell, flooding near electrical outlets or anyone in danger, hang up and call 911 right now.',
      'Si huele a gas, hay agua cerca de enchufes eléctricos o alguien en peligro, cuelgue y llame al 911 ahora mismo.',
    ),
    call911For: ['gas', 'flooding_electrical', 'fire'],
    none: null,
  },
  prompt: {
    greeting: GREETING,
    qualifying: [
      L('Where is the problem (kitchen, bathroom, outside, water heater) and what is it doing?', '¿Dónde está el problema (cocina, baño, exterior, calentador) y qué hace?'),
      L('Is the water shut off at the main valve, and is any water still running?', '¿Está cerrada la llave de paso y sigue saliendo agua?'),
    ],
    mixExample: L('"Hola, tengo a leak under the sink"', '"Hola, tengo a leak under the sink"'),
    mixTerms: L('"el drain", "la llave", "the water heater"', '"el drenaje", "la llave", "el calentador"'),
  },
  script: {
    triage: L(
      'Before we book — is water flowing and not stopping, is it near electrical outlets, is sewage backing up, or do you smell gas?',
      'Antes de agendar — ¿está saliendo agua sin parar, cerca de enchufes, están regresando aguas negras o huele a gas?',
    ),
    booking: L(
      "I can get a plumber out to you. I have [slot 1] or [slot 2] — which works better? And what's the service address? I'll use the number you're calling from, unless you'd like me to use a different one.",
      'Puedo mandarle un plomero. Tengo [opción 1] u [opción 2] — ¿cuál le queda mejor? ¿Y la dirección del servicio? Usaré el número desde el que llama, a menos que prefiera darme otro.',
    ),
  },
  sms: { fallbackService: L('plumbing visit', 'visita de plomería'), confirmationNote: L('If water is running, shut off the main valve.', 'Si sale agua, cierre la llave de paso.') },
  briefing: { providerWord: L('el plomero', 'el plomero'), tradeWords: 'booked, deposit, plumber, the service names' },
  hints: {
    spanishWords: ['plomero', 'fuga', 'drenaje', 'llave'],
    testPhrase: L('Hola, I have a leak under my kitchen sink.', 'Hola, tengo una fuga debajo del fregadero.'),
    servicePlaceholder: L('Service name, e.g. Drain cleaning', 'Nombre del servicio, p. ej. destape de drenaje'),
  },
};
