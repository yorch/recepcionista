import { GREETING, HOURS_TRADE, L } from '../common';
import type { VerticalPack } from '../types';

export const electrical: VerticalPack = {
  id: 'electrical',
  label: L('Electrical', 'Electricidad'),
  blurb: L('Repairs, panels, lighting and EV chargers.', 'Reparaciones, paneles, iluminación y cargadores de autos eléctricos.'),
  persona: L('an electrical contractor', 'una empresa de electricidad'),
  provider: L('electrician', 'electricista'),
  services: [
    { name: L('Electrical Troubleshooting', 'Diagnóstico eléctrico'), description: L('Find and fix outlets, switches and circuits that fail', 'Localizar y reparar enchufes, interruptores y circuitos con fallas'), base_price: 130, duration_minutes: 90 },
    { name: L('Panel Upgrade', 'Mejora de panel eléctrico'), description: L('Replace or upgrade the main electrical panel', 'Reemplazo o mejora del panel eléctrico principal'), base_price: 1800, duration_minutes: 360 },
    { name: L('Lighting and Fan Installation', 'Instalación de luces y ventiladores'), description: L('Light fixtures, recessed lights and ceiling fans', 'Lámparas, luces empotradas y ventiladores de techo'), base_price: 120, duration_minutes: 90 },
    { name: L('EV Charger Installation', 'Instalación de cargador de auto eléctrico'), description: L('Level 2 home charger with a dedicated circuit', 'Cargador residencial nivel 2 con circuito dedicado'), base_price: 650, duration_minutes: 180 },
    { name: L('Emergency Electrical Service', 'Servicio eléctrico de emergencia'), description: L('Same-day response for sparking, burning or dead circuits', 'Atención el mismo día por chispas, olor a quemado o circuitos sin energía'), base_price: 225, duration_minutes: 90 },
  ],
  hours: HOURS_TRADE,
  faqs: [
    { question: L('Do you offer same-day service?', '¿Ofrecen servicio el mismo día?'), answer: L('Yes, call and we will find the earliest slot. If you see sparks or smell burning, turn off the main breaker if it is safe and call 911.', 'Sí, llame y buscamos el primer horario. Si ve chispas o huele a quemado, apague el interruptor principal si es seguro y llame al 911.') },
    { question: L('Are your electricians licensed and insured?', '¿Sus electricistas tienen licencia y seguro?'), answer: L('Yes. Ask us for our license number and we will send it with your confirmation.', 'Sí. Pídanos nuestro número de licencia y lo enviamos con su confirmación.') },
    { question: L('How much does a service call cost?', '¿Cuánto cuesta una visita?'), answer: L('Troubleshooting starts around $130; the electrician confirms the price after inspecting the work.', 'El diagnóstico empieza alrededor de $130; el electricista confirma el precio después de revisar el trabajo.') },
  ],
  pricing: {
    notes: L(
      'All prices are starting prices and vary by the job and local permit needs. The electrician confirms the exact price after inspection, before any work begins.',
      'Todos los precios son precios iniciales y varían según el trabajo y los permisos locales. El electricista confirma el precio exacto después de la inspección, antes de empezar.',
    ),
    confirmLine: L('the electrician confirms the exact price after inspection, before any work begins', 'el electricista confirma el precio exacto después de la inspección, antes de empezar cualquier trabajo'),
    unpriced: L('price after inspection', 'precio después de la inspección'),
    fallbackService: { name: L('Electrical service call', 'Visita eléctrica'), description: L('Inspection and repair', 'Inspección y reparación') },
  },
  deposits: { defaultOn: true },
  emergency: {
    enabled: true,
    rules: [
      L('Sparking, arcing or a hot, buzzing or smoking panel, outlet or wire', 'Chispas, arcos o un panel, enchufe o cable caliente, zumbando o echando humo'),
      L('A burning smell from the electrical system', 'Olor a quemado en el sistema eléctrico'),
      L('A downed or damaged power line, or water reaching electrical equipment', 'Un cable de luz caído o dañado, o agua llegando a equipos eléctricos'),
      L('Total loss of power with a vulnerable occupant (baby, elderly, sick person or medical equipment)', 'Sin energía total con una persona vulnerable (bebé, adulto mayor, enfermo o equipo médico)'),
    ],
    triage: L('sparks or a burning smell? a hot or buzzing panel? water near electrical equipment? anyone shocked? no power with someone vulnerable at home?', '¿chispas u olor a quemado? ¿panel caliente o zumbando? ¿agua cerca de equipo eléctrico? ¿alguien recibió una descarga? ¿sin luz con alguien vulnerable en casa?'),
    keywords: [
      'sparks', 'sparking', 'arcing', 'burning', 'burnt', 'smoke', 'smoking', 'fire', 'shock', 'shocked', 'power line', 'downed line', 'buzzing', 'hot panel', 'emergency', 'no power',
      'chispas', 'chispeando', 'quemado', 'olor a quemado', 'humo', 'fuego', 'descarga', 'cable caído', 'cable caido', 'zumbando', 'sin luz', 'emergencia',
    ],
    strong: ['sparks', 'sparking', 'arcing', 'burning', 'burnt', 'smoke', 'smoking', 'fire', 'shocked', 'power line', 'downed line', 'chispas', 'chispeando', 'quemado', 'humo', 'fuego', 'descarga', 'cable caído', 'cable caido'],
    vulnerable: true,
    call911: L(
      'If there is fire, smoke, a burning smell from the panel, a downed power line or anyone has been shocked, hang up and call 911 right now.',
      'Si hay fuego, humo, olor a quemado en el panel, un cable de luz caído o alguien recibió una descarga, cuelgue y llame al 911 ahora mismo.',
    ),
    call911For: ['fire', 'smoke', 'electrical_shock', 'downed_line'],
    none: null,
  },
  prompt: {
    greeting: GREETING,
    qualifying: [
      L('What is happening (no power, a dead outlet, a breaker that keeps tripping, a flickering light)?', '¿Qué está pasando (sin luz, un enchufe sin energía, un breaker que se baja, una luz parpadeando)?'),
      L('Is it one room or the whole house, and is it a house or a business?', '¿Es un cuarto o toda la casa, y es una casa o un negocio?'),
    ],
    mixExample: L('"Hola, el breaker keeps tripping"', '"Hola, el breaker keeps tripping"'),
    mixTerms: L('"el breaker", "el panel", "the outlet"', '"el breaker", "el panel", "el enchufe"'),
  },
  script: {
    triage: L(
      'Before we book — do you see sparks or smell burning, is a panel or outlet hot or buzzing, is there water near electrical equipment, or has anyone been shocked?',
      'Antes de agendar — ¿ve chispas o huele a quemado, hay un panel o enchufe caliente o zumbando, hay agua cerca de equipo eléctrico, o alguien recibió una descarga?',
    ),
    booking: L(
      "I can get an electrician out to you. I have [slot 1] or [slot 2] — which works better? And what's the service address? I'll use the number you're calling from, unless you'd like me to use a different one.",
      'Puedo mandarle un electricista. Tengo [opción 1] u [opción 2] — ¿cuál le queda mejor? ¿Y la dirección del servicio? Usaré el número desde el que llama, a menos que prefiera darme otro.',
    ),
  },
  sms: { fallbackService: L('electrical visit', 'visita eléctrica'), confirmationNote: L('Please clear access to the electrical panel.', 'Por favor deje libre el acceso al panel eléctrico.') },
  briefing: { providerWord: L('el electricista', 'el electricista'), tradeWords: 'booked, deposit, electrician, panel, breaker, the service names' },
  hints: {
    spanishWords: ['electricista', 'luz', 'enchufe', 'breaker'],
    testPhrase: L('Hola, the breaker keeps tripping.', 'Hola, el breaker se sigue bajando.'),
    servicePlaceholder: L('Service name, e.g. Panel upgrade', 'Nombre del servicio, p. ej. mejora de panel'),
  },
};
