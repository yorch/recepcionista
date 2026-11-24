import type { Hours } from '@/lib/types';
import type { L10n } from './types';

export const L = (en: string, es: string): L10n => ({ en, es });

/** Mon-Fri 8-6, Sat 9-2, closed Sunday: the long-standing default of the product. */
export const HOURS_TRADE: Hours = {
  monday: { open: '08:00', close: '18:00' },
  tuesday: { open: '08:00', close: '18:00' },
  wednesday: { open: '08:00', close: '18:00' },
  thursday: { open: '08:00', close: '18:00' },
  friday: { open: '08:00', close: '18:00' },
  saturday: { open: '09:00', close: '14:00' },
  sunday: null,
};

export const HOURS_OFFICE: Hours = {
  monday: { open: '08:00', close: '17:00' },
  tuesday: { open: '08:00', close: '17:00' },
  wednesday: { open: '08:00', close: '17:00' },
  thursday: { open: '08:00', close: '17:00' },
  friday: { open: '08:00', close: '16:00' },
  saturday: null,
  sunday: null,
};

export const GREETING = L(
  'Thank you for calling {name}, how can I help you today?',
  '¡Gracias por llamar a {name}, ¿cómo le puedo ayudar?',
);

/** 911 copy for a trade with no hazard of its own: still spoken wherever the agent flags something dangerous. */
export const CALL_911_GENERIC = L(
  'If anyone is in danger, hang up and call 911 right now.',
  'Si alguien está en peligro, cuelgue y llame al 911 ahora mismo.',
);

export const NO_EMERGENCY_RULES = L(
  'This business does not run emergency dispatch. If the caller describes something urgent, offer the earliest open slot, or use handoff_to_human so the owner can decide. Never promise same-day service. If anyone is in danger, follow the 911 rule below.',
  'Este negocio no atiende emergencias. Si la persona describe algo urgente, ofrezca el primer horario libre o use handoff_to_human para que el dueño decida. Nunca prometa servicio el mismo día. Si alguien está en peligro, siga la regla del 911 de abajo.',
);
