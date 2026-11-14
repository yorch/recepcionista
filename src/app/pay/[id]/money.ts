/** Shared by the server-rendered amount and the client form. No 'use client' here. */
export function formatMoney(cents: number): string {
  return `$${(Math.round(cents) / 100).toFixed(2)}`;
}
