/**
 * The time zones an owner can pick in the UI: US and Canada (the markets the platform sells in), as canonical IANA names. The choice is stored
 * as the IANA name, never as an offset, so daylight saving time is handled by `Intl` (src/lib/time.ts) and the label's UTC offset is computed
 * for the instant it is shown (it changes twice a year). Pure: usable in the browser. `isIanaTimeZone` (tz-infer) is the server-side gate.
 */
import { offsetLabel } from './time';

export interface TzOption { id: string; en: string; es: string }

export const TIME_ZONE_OPTIONS: readonly TzOption[] = Object.freeze([
  { id: 'America/New_York', en: 'Eastern - New York', es: 'Este - Nueva York' },
  { id: 'America/Detroit', en: 'Eastern - Detroit', es: 'Este - Detroit' },
  { id: 'America/Toronto', en: 'Eastern - Toronto', es: 'Este - Toronto' },
  { id: 'America/Indiana/Indianapolis', en: 'Eastern - Indianapolis', es: 'Este - Indianápolis' },
  { id: 'America/Kentucky/Louisville', en: 'Eastern - Louisville', es: 'Este - Louisville' },
  { id: 'America/Puerto_Rico', en: 'Atlantic - Puerto Rico (no daylight saving)', es: 'Atlántico - Puerto Rico (sin horario de verano)' },
  { id: 'America/St_Thomas', en: 'Atlantic - U.S. Virgin Islands (no daylight saving)', es: 'Atlántico - Islas Vírgenes de EE. UU. (sin horario de verano)' },
  { id: 'America/Halifax', en: 'Atlantic - Halifax', es: 'Atlántico - Halifax' },
  { id: 'America/St_Johns', en: 'Newfoundland - St. John\'s', es: 'Terranova - St. John\'s' },
  { id: 'America/Chicago', en: 'Central - Chicago', es: 'Centro - Chicago' },
  { id: 'America/Winnipeg', en: 'Central - Winnipeg', es: 'Centro - Winnipeg' },
  { id: 'America/Regina', en: 'Central - Regina (no daylight saving)', es: 'Centro - Regina (sin horario de verano)' },
  { id: 'America/Denver', en: 'Mountain - Denver', es: 'Montaña - Denver' },
  { id: 'America/Boise', en: 'Mountain - Boise', es: 'Montaña - Boise' },
  { id: 'America/Edmonton', en: 'Mountain - Edmonton', es: 'Montaña - Edmonton' },
  { id: 'America/Phoenix', en: 'Mountain - Arizona (no daylight saving)', es: 'Montaña - Arizona (sin horario de verano)' },
  { id: 'America/Los_Angeles', en: 'Pacific - Los Angeles', es: 'Pacífico - Los Ángeles' },
  { id: 'America/Vancouver', en: 'Pacific - Vancouver', es: 'Pacífico - Vancouver' },
  { id: 'America/Anchorage', en: 'Alaska - Anchorage', es: 'Alaska - Anchorage' },
  { id: 'America/Adak', en: 'Hawaii-Aleutian - Adak', es: 'Hawái-Aleutianas - Adak' },
  { id: 'Pacific/Guam', en: 'Chamorro - Guam (no daylight saving)', es: 'Chamorro - Guam (sin horario de verano)' },
  { id: 'Pacific/Honolulu', en: 'Hawaii - Honolulu (no daylight saving)', es: 'Hawái - Honolulu (sin horario de verano)' },
]);

export const TIME_ZONE_IDS: readonly string[] = TIME_ZONE_OPTIONS.map((o) => o.id);

/** "Eastern - New York (UTC-05:00)": the offset is the one in force at `now` for that zone (DST aware). */
export function tzOptionLabel(opt: TzOption, lang: 'en' | 'es', now: Date = new Date()): string {
  return `${lang === 'es' ? opt.es : opt.en} (${offsetLabel(now, opt.id)})`;
}

/** The list for a select: the standard options, plus the business's current zone when it is not one of them (never silently dropped). */
export function tzSelectOptions(current: string | null | undefined, lang: 'en' | 'es', now: Date = new Date()): { id: string; label: string }[] {
  const list = TIME_ZONE_OPTIONS.map((o) => ({ id: o.id, label: tzOptionLabel(o, lang, now) }));
  if (current && !TIME_ZONE_IDS.includes(current)) list.unshift({ id: current, label: `${current} (${offsetLabel(now, current)})` });
  return list;
}
