import { CALL_911_GENERIC, GREETING, HOURS_TRADE, L, NO_EMERGENCY_RULES } from '../common';
import type { VerticalPack } from '../types';

export const landscaping: VerticalPack = {
  id: 'landscaping',
  label: L('Landscaping', 'Jardinería y paisajismo'),
  blurb: L('Lawn care, trimming, tree work and landscape design.', 'Cuidado del césped, poda, árboles y diseño de jardines.'),
  persona: L('a landscaping company', 'una empresa de jardinería'),
  provider: L('crew', 'equipo'),
  services: [
    { name: L('Lawn Mowing', 'Corte de césped'), description: L('Mowing, edging and blowing for one visit or a regular schedule', 'Corte, bordes y soplado en una visita o con calendario regular'), base_price: 55, duration_minutes: 60 },
    { name: L('Hedge and Shrub Trimming', 'Poda de setos y arbustos'), description: L('Shaping and cleanup of hedges, shrubs and small trees', 'Podado y limpieza de setos, arbustos y árboles pequeños'), base_price: 90, duration_minutes: 90 },
    { name: L('Yard Cleanup', 'Limpieza de jardín'), description: L('Leaves, branches and overgrowth cleared and hauled away', 'Hojas, ramas y maleza retiradas y llevadas'), base_price: 180, duration_minutes: 180 },
    { name: L('Mulch and Planting', 'Mantillo y siembra'), description: L('Mulch beds, new plants, sod and seasonal color', 'Camas de mantillo, plantas nuevas, césped en rollo y flores de temporada'), base_price: 250, duration_minutes: 240 },
    { name: L('Landscape Design Consultation', 'Consulta de diseño de jardín'), description: L('On-site visit and written estimate for a larger project', 'Visita al sitio y cotización escrita para un proyecto grande'), base_price: 75, duration_minutes: 60 },
  ],
  hours: HOURS_TRADE,
  faqs: [
    { question: L('Do you offer recurring lawn care?', '¿Ofrecen mantenimiento regular del césped?'), answer: L('Yes, weekly or every other week. We set a schedule when we book the first visit.', 'Sí, cada semana o cada dos semanas. Fijamos un calendario al agendar la primera visita.') },
    { question: L('What happens if it rains?', '¿Qué pasa si llueve?'), answer: L('We reschedule to the next available day at no charge.', 'Lo movemos al siguiente día disponible sin costo.') },
    { question: L('Do you give free estimates?', '¿Dan cotizaciones gratis?'), answer: L('For larger projects we visit the property and give a written estimate. Routine mowing is priced by lot size.', 'Para proyectos grandes visitamos la propiedad y damos una cotización escrita. El corte regular se cobra según el tamaño del terreno.') },
  ],
  pricing: {
    notes: L(
      'All prices are starting prices and depend on lot size and the work involved. Larger projects get a written estimate before work begins.',
      'Todos los precios son precios iniciales y dependen del tamaño del terreno y del trabajo. Los proyectos grandes reciben una cotización escrita antes de empezar.',
    ),
    confirmLine: L('the crew confirms the final price on site, or in a written estimate for larger projects, before any work begins', 'el equipo confirma el precio final en el sitio, o en una cotización escrita para proyectos grandes, antes de empezar'),
    unpriced: L('price on estimate', 'precio según cotización'),
    fallbackService: { name: L('Yard service', 'Servicio de jardín'), description: L('Lawn and yard work', 'Trabajo de césped y jardín') },
  },
  deposits: { defaultOn: true },
  emergency: {
    enabled: false, rules: [], triage: L('', ''), keywords: [], strong: [], vulnerable: false,
    call911: CALL_911_GENERIC, call911For: ['danger_to_life'], none: NO_EMERGENCY_RULES,
  },
  prompt: {
    greeting: GREETING,
    qualifying: [
      L('What work do you need (mowing, trimming, cleanup, planting, a bigger project)?', '¿Qué trabajo necesita (corte, poda, limpieza, siembra, un proyecto más grande)?'),
      L('Roughly how big is the yard, and is it one visit or a regular schedule?', '¿Más o menos qué tan grande es el jardín, y es una visita o un calendario regular?'),
    ],
    mixExample: L('"Hola, necesito el lawn cut"', '"Hola, necesito el lawn cut"'),
    mixTerms: L('"el lawn", "el yard", "the mulch"', '"el césped", "el jardín", "el mantillo"'),
  },
  script: {
    triage: L(
      'To get the quote right — what work do you need, roughly how big is the yard, and is it a one-time visit or a regular schedule?',
      'Para darle bien el precio — ¿qué trabajo necesita, más o menos qué tan grande es el jardín, y es una sola visita o un calendario regular?',
    ),
    booking: L(
      "I can get a crew out to you. I have [slot 1] or [slot 2] — which works better? And what's the property address? I'll use the number you're calling from, unless you'd like me to use a different one.",
      'Puedo mandarle un equipo. Tengo [opción 1] u [opción 2] — ¿cuál le queda mejor? ¿Y la dirección de la propiedad? Usaré el número desde el que llama, a menos que prefiera darme otro.',
    ),
  },
  sms: { fallbackService: L('yard service', 'servicio de jardín'), confirmationNote: L('Please unlock the gate and secure pets.', 'Por favor abra el portón y guarde a las mascotas.') },
  briefing: { providerWord: L('el equipo', 'el equipo'), tradeWords: 'booked, deposit, crew, lawn, mulch, the service names' },
  hints: {
    spanishWords: ['jardin', 'cesped', 'pasto'],
    testPhrase: L('Hola, I need my lawn mowed this week.', 'Hola, necesito que corten mi césped esta semana.'),
    servicePlaceholder: L('Service name, e.g. Lawn mowing', 'Nombre del servicio, p. ej. corte de césped'),
  },
};
