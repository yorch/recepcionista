import { CALL_911_GENERIC, GREETING, HOURS_OFFICE, L, NO_EMERGENCY_RULES } from '../common';
import type { VerticalPack } from '../types';

export const cleaning: VerticalPack = {
  id: 'cleaning',
  label: L('Cleaning', 'Limpieza'),
  blurb: L('Home and office cleaning, deep cleans and move-outs.', 'Limpieza de casas y oficinas, limpiezas profundas y mudanzas.'),
  persona: L('a cleaning company', 'una empresa de limpieza'),
  provider: L('cleaning crew', 'equipo de limpieza'),
  services: [
    { name: L('Standard Home Cleaning', 'Limpieza estándar de casa'), description: L('Kitchen, bathrooms, floors, dusting and surfaces', 'Cocina, baños, pisos, polvo y superficies'), base_price: 120, duration_minutes: 120 },
    { name: L('Deep Cleaning', 'Limpieza profunda'), description: L('Detailed top-to-bottom clean including baseboards and appliances', 'Limpieza detallada de arriba abajo, con zócalos y electrodomésticos'), base_price: 220, duration_minutes: 240 },
    { name: L('Move-in / Move-out Cleaning', 'Limpieza de mudanza'), description: L('Empty-home clean for handover', 'Limpieza de casa vacía para entrega'), base_price: 260, duration_minutes: 240 },
    { name: L('Office Cleaning', 'Limpieza de oficina'), description: L('Recurring or one-time commercial cleaning', 'Limpieza comercial recurrente o única'), base_price: 150, duration_minutes: 120 },
  ],
  hours: HOURS_OFFICE,
  faqs: [
    { question: L('Do I need to be home during the cleaning?', '¿Tengo que estar en casa durante la limpieza?'), answer: L('No. Many clients leave a key or a door code; we will agree on access when we book.', 'No. Muchos clientes dejan una llave o un código; acordamos el acceso al agendar.') },
    { question: L('Do you bring your own supplies?', '¿Traen sus propios productos?'), answer: L('Yes, we bring supplies and equipment. Tell us if you prefer specific products.', 'Sí, traemos productos y equipo. Díganos si prefiere productos específicos.') },
    { question: L('How is the price decided?', '¿Cómo se decide el precio?'), answer: L('It depends on the size of the home and the type of clean. We give a starting price on the phone and confirm it before we begin.', 'Depende del tamaño de la casa y del tipo de limpieza. Damos un precio inicial por teléfono y lo confirmamos antes de empezar.') },
  ],
  pricing: {
    notes: L(
      'All prices are starting prices and depend on the size of the home and the type of clean. The final price is confirmed before the cleaning begins.',
      'Todos los precios son precios iniciales y dependen del tamaño de la casa y del tipo de limpieza. El precio final se confirma antes de empezar.',
    ),
    confirmLine: L('the crew confirms the final price before the cleaning begins, based on the size of the space', 'el equipo confirma el precio final antes de empezar la limpieza, según el tamaño del lugar'),
    unpriced: L('price on quote', 'precio según cotización'),
    fallbackService: { name: L('Home cleaning', 'Limpieza de casa'), description: L('Standard cleaning', 'Limpieza estándar') },
  },
  deposits: { defaultOn: false },
  emergency: {
    enabled: false, rules: [], triage: L('', ''), keywords: [], strong: [], vulnerable: false,
    call911: CALL_911_GENERIC, call911For: ['danger_to_life'], none: NO_EMERGENCY_RULES,
  },
  prompt: {
    greeting: GREETING,
    qualifying: [
      L('What type of clean is it (standard, deep, move-out, office) and how often?', '¿Qué tipo de limpieza es (estándar, profunda, mudanza, oficina) y con qué frecuencia?'),
      L('How many bedrooms and bathrooms, or roughly how many square feet?', '¿Cuántos cuartos y baños tiene, o cuántos pies cuadrados más o menos?'),
      L('Are there pets, and how will the crew get in?', '¿Hay mascotas, y cómo entrará el equipo?'),
    ],
    mixExample: L('"Hola, quiero una deep clean"', '"Hola, quiero una deep clean"'),
    mixTerms: L('"la limpieza", "the deep clean", "el move-out"', '"la limpieza", "la limpieza profunda", "la mudanza"'),
  },
  script: {
    triage: L(
      'To get the quote right — what type of clean is it, how many bedrooms and bathrooms, and are there any pets?',
      'Para darle bien el precio — ¿qué tipo de limpieza es, cuántos cuartos y baños tiene, y hay mascotas?',
    ),
    booking: L(
      "I can get a crew out to you. I have [slot 1] or [slot 2] — which works better? And what's the address? I'll use the number you're calling from, unless you'd like me to use a different one.",
      'Puedo mandarle un equipo. Tengo [opción 1] u [opción 2] — ¿cuál le queda mejor? ¿Y la dirección? Usaré el número desde el que llama, a menos que prefiera darme otro.',
    ),
  },
  sms: { fallbackService: L('cleaning', 'limpieza'), confirmationNote: L('Please make sure we can get in.', 'Por favor asegúrese de que podamos entrar.') },
  briefing: { providerWord: L('el equipo', 'el equipo'), tradeWords: 'booked, deposit, deep clean, move-out, the service names' },
  hints: {
    spanishWords: ['limpieza', 'casa', 'cuartos'],
    testPhrase: L('Hola, I need a deep clean before the weekend.', 'Hola, necesito una limpieza profunda antes del fin de semana.'),
    servicePlaceholder: L('Service name, e.g. Deep cleaning', 'Nombre del servicio, p. ej. limpieza profunda'),
  },
};
