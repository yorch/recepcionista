import { intlTag, type Locale } from '@/lib/i18n/core';

/** Shared by the server-rendered amount and the client form: "$189.00" (always two decimals: the amount is a figure the customer confirms). */
export function formatMoney(cents: number, locale: Locale = 'en'): string {
  return new Intl.NumberFormat(intlTag(locale), {
    style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Math.round(cents) / 100);
}
