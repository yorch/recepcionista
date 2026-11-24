'use client';
import { createContext, useCallback, useContext, useMemo } from 'react';
import {
  formatDateTime, formatMoney, intlTag, translateFrom, type Locale, type MessageKey, type Messages, type Params, type TFunction,
} from './core';

interface Ctx { locale: Locale; messages: Messages }
const I18nContext = createContext<Ctx | null>(null);

/** Supplied once by the root layout with the active locale's catalog. */
export function I18nProvider({ locale, messages, children }: { locale: Locale; messages: Messages; children: React.ReactNode }) {
  const value = useMemo(() => ({ locale, messages }), [locale, messages]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(I18nContext)?.locale ?? 'en';
}

export function useT(): TFunction {
  const ctx = useContext(I18nContext);
  const locale = ctx?.locale ?? 'en';
  const messages = ctx?.messages;
  return useCallback((key: MessageKey, params?: Params) => {
    // Same formatter as the server; the provider's catalog is used first so only one language ships to the browser.
    return translateFrom(messages, locale, key, params ?? {});
  }, [locale, messages]);
}

/** Locale-bound Intl helpers for client components. */
export function useFormat() {
  const locale = useLocale();
  return useMemo(() => ({
    locale,
    tag: intlTag(locale),
    money: (cents: number | null | undefined) => formatMoney(locale, cents),
    dateTime: (at: Date | string | number, opts: Intl.DateTimeFormatOptions) => formatDateTime(locale, at, opts),
  }), [locale]);
}
