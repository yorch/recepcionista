/**
 * In-house i18n entry point for SERVER code and tests (it imports both catalogs; client components import
 * `@/lib/i18n/core` + the provider in `./client` so only the active language reaches the browser). See docs/i18n.md.
 */
import { en } from './en';
import { es } from './es';
import { translateFrom, type Locale, type MessageKey, type Messages, type Params, type TFunction } from './core';

export * from './core';

export const MESSAGES: Record<Locale, Messages> = { en, es };

/** Translate `key` in `locale`; a missing es entry falls back to English, then to the key (never throws). */
export function translate(locale: Locale, key: MessageKey, params: Params = {}): string {
  return translateFrom(MESSAGES[locale]?.[key] !== undefined ? MESSAGES[locale] : en, locale, key, params);
}

export function makeT(locale: Locale): TFunction {
  return (key, params) => translate(locale, key, params);
}
