import { call911Of, packOf } from '@/lib/verticals';
import type { Business } from '@/lib/types';

/** Spoken in EVERY emergency outcome (success, failure, exception): life safety is never gated on our plumbing. These two are the HVAC copy (the default vertical). */
export const CALL_911_EN = 'If there is a gas smell, carbon monoxide, smoke, fire or anyone in danger, hang up and call 911 right now.';
export const CALL_911_ES = 'Si huele a gas, hay monóxido de carbono, humo, fuego o alguien en peligro, cuelgue y llame al 911 ahora mismo.';

type VerticalOf = Pick<Business, 'vertical'> | null | undefined;

/** The 911 sentence of the business's vertical (HVAC copy when unknown). */
export function call911For(business: VerticalOf): { en: string; es: string } {
  return call911Of(business);
}

/** The hazards behind that sentence, for the machine-readable part of a tool result. */
export function call911Hazards(business: VerticalOf): string[] {
  return [...packOf(business).emergency.call911For];
}
