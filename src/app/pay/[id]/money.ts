import { formatCents } from '@/lib/money';

/** Shared by the server-rendered amount and the client form: "$189.00" (one money formatter for the app). */
export function formatMoney(cents: number): string {
  return formatCents(cents, { fractionalAlways: true });
}
