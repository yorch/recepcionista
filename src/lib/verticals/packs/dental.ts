import { GREETING, HOURS_OFFICE, L } from '../common';
import type { VerticalPack } from '../types';

export const dental: VerticalPack = {
  id: 'dental',
  label: L('Dental', 'Dental'),
  blurb: L('Checkups, cleanings, fillings and dental emergencies.', 'Revisiones, limpiezas, empastes y emergencias dentales.'),
  persona: L('a dental office', 'un consultorio dental'),
  provider: L('dentist', 'dentista'),
  services: [
    { name: L('New Patient Exam and Cleaning', 'Examen y limpieza para paciente nuevo'), description: L('Full exam, X-rays and a cleaning', 'Examen completo, radiografías y limpieza'), base_price: 150, duration_minutes: 60 },
    { name: L('Routine Cleaning and Checkup', 'Limpieza y revisión de rutina'), description: L('Six-month cleaning and exam', 'Limpieza y examen cada seis meses'), base_price: 110, duration_minutes: 45 },
    { name: L('Filling', 'Empaste'), description: L('Tooth-colored filling for a cavity', 'Empaste del color del diente para una caries'), base_price: 180, duration_minutes: 60 },
    { name: L('Teeth Whitening', 'Blanqueamiento dental'), description: L('In-office whitening treatment', 'Tratamiento de blanqueamiento en el consultorio'), base_price: 350, duration_minutes: 75 },
    { name: L('Emergency Dental Visit', 'Visita dental de emergencia'), description: L('Same-day exam for pain, a broken or knocked-out tooth', 'Examen el mismo día por dolor, un diente roto o desprendido'), base_price: 125, duration_minutes: 45 },
  ],
  hours: HOURS_OFFICE,
  faqs: [
    { question: L('Are you accepting new patients?', '¿Aceptan pacientes nuevos?'), answer: L('Yes. Tell us a day that works and we will book a new patient exam.', 'Sí. Díganos un día que le acomode y agendamos un examen para paciente nuevo.') },
    { question: L('Which insurance do you accept?', '¿Qué seguros aceptan?'), answer: L('We work with most major plans. Give us your plan name when you book and the office will confirm your coverage before the visit.', 'Trabajamos con la mayoría de los planes. Díganos el nombre de su plan al agendar y el consultorio confirmará su cobertura antes de la visita.') },
    { question: L('What should I do if I have a toothache or a broken tooth?', '¿Qué hago si tengo dolor de muela o un diente roto?'), answer: L('Call us and we will see you the same day when we can. For heavy bleeding, swelling that affects breathing or swallowing, or a head injury, call 911.', 'Llámenos y lo atendemos el mismo día cuando sea posible. Si hay sangrado abundante, hinchazón que afecte la respiración o al tragar, o un golpe en la cabeza, llame al 911.') },
  ],
  pricing: {
    notes: L(
      'Prices are estimates before insurance. The office confirms your cost and coverage after the exam, before any treatment begins.',
      'Los precios son estimados antes del seguro. El consultorio confirma su costo y cobertura después del examen, antes de cualquier tratamiento.',
    ),
    confirmLine: L('the office confirms the cost and insurance coverage after the exam, before any treatment begins', 'el consultorio confirma el costo y la cobertura del seguro después del examen, antes de cualquier tratamiento'),
    unpriced: L('price after exam', 'precio después del examen'),
    fallbackService: { name: L('Dental visit', 'Visita dental'), description: L('Exam and consultation', 'Examen y consulta') },
  },
  deposits: { defaultOn: false },
  emergency: {
    enabled: true,
    rules: [
      L('Severe, uncontrolled tooth or jaw pain', 'Dolor fuerte e incontrolable en un diente o la mandíbula'),
      L('A knocked-out, loose or broken tooth after an injury (dental trauma)', 'Un diente desprendido, flojo o roto después de un golpe (trauma dental)'),
      L('Bleeding from the mouth that will not stop', 'Sangrado de la boca que no para'),
      L('Swelling of the face, jaw or gums, or signs of an abscess (fever, bad taste, pus)', 'Hinchazón de la cara, la mandíbula o las encías, o señales de absceso (fiebre, mal sabor, pus)'),
    ],
    triage: L('severe pain? a knocked-out or broken tooth? bleeding that will not stop? swelling of the face or jaw? trouble breathing or swallowing?', '¿dolor fuerte? ¿diente desprendido o roto? ¿sangrado que no para? ¿hinchazón de la cara o la mandíbula? ¿dificultad para respirar o tragar?'),
    keywords: [
      'knocked out', 'knocked-out', 'broken tooth', 'chipped tooth', 'severe pain', 'swelling', 'swollen', 'bleeding', 'abscess', 'trauma', 'infection', 'emergency', 'toothache',
      'diente roto', 'se me cayó el diente', 'se me cayo el diente', 'dolor fuerte', 'hinchazón', 'hinchazon', 'hinchado', 'sangrado', 'sangrando', 'absceso', 'infección', 'infeccion', 'emergencia',
    ],
    strong: ['knocked out', 'knocked-out', 'severe pain', 'swelling', 'swollen', 'bleeding', 'abscess', 'trauma', 'dolor fuerte', 'hinchazón', 'hinchazon', 'hinchado', 'sangrado', 'sangrando', 'absceso', 'se me cayó el diente', 'se me cayo el diente'],
    vulnerable: false,
    call911: L(
      'If you have trouble breathing or swallowing, bleeding you cannot stop, swelling spreading across your face or neck, or a serious injury to your head or face, hang up and call 911 right now.',
      'Si tiene dificultad para respirar o tragar, un sangrado que no puede detener, hinchazón que se extiende por la cara o el cuello, o una lesión grave en la cabeza o la cara, cuelgue y llame al 911 ahora mismo.',
    ),
    call911For: ['breathing', 'uncontrolled_bleeding', 'facial_trauma'],
    none: null,
  },
  prompt: {
    greeting: GREETING,
    qualifying: [
      L('Is this a new or an existing patient, and what do they need (checkup, cleaning, a problem tooth)?', '¿Es paciente nuevo o ya es paciente, y qué necesita (revisión, limpieza, un diente con problema)?'),
      L('Which insurance, if any? Only note the plan name; never ask for member numbers or card numbers.', '¿Qué seguro tiene, si tiene? Solo anote el nombre del plan; nunca pida números de afiliado ni de tarjeta.'),
    ],
    mixExample: L('"Hola, I need una limpieza"', '"Hola, I need una limpieza"'),
    mixTerms: L('"la cita", "el checkup", "the cleaning"', '"la cita", "la revisión", "la limpieza"'),
  },
  script: {
    triage: L(
      'Before we book — are you in severe pain, did you break or lose a tooth, is there bleeding that will not stop, or is your face or jaw swollen?',
      'Antes de agendar — ¿tiene dolor fuerte, se rompió o perdió un diente, hay sangrado que no para, o tiene la cara o la mandíbula hinchada?',
    ),
    booking: L(
      "I can get you in with us. I have [slot 1] or [slot 2] — which works better? Is this a new or an existing patient? I'll use the number you're calling from, unless you'd like me to use a different one.",
      'Puedo agendarle una cita. Tengo [opción 1] u [opción 2] — ¿cuál le queda mejor? ¿Es paciente nuevo o ya es paciente? Usaré el número desde el que llama, a menos que prefiera darme otro.',
    ),
  },
  sms: { fallbackService: L('appointment', 'cita'), confirmationNote: L('Please arrive 10 minutes early.', 'Por favor llegue 10 minutos antes.') },
  briefing: { providerWord: L('el consultorio', 'el consultorio'), tradeWords: 'booked, deposit, checkup, cleaning, the service names' },
  hints: {
    spanishWords: ['dentista', 'diente', 'muela', 'cita'],
    testPhrase: L('Hola, I need to book a cleaning.', 'Hola, necesito agendar una limpieza.'),
    servicePlaceholder: L('Service name, e.g. Routine cleaning', 'Nombre del servicio, p. ej. limpieza de rutina'),
  },
};
