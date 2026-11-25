/** Shared checks of the owner privacy routes (lookup / export / erase): a phone that parses, and a per-business rate limit. */
import { NextResponse } from 'next/server';
import { countryForBusiness } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { rateLimit } from '@/lib/ratelimit';
import type { Business } from '@/lib/types';

export { ERASE_CONFIRM_WORD } from '@/lib/messaging/privacy-words';

export type PhoneCheck = { ok: true; e164: string; last4: string } | { ok: false; response: NextResponse };

const refuse = (status: number, error: string, code?: string): { ok: false; response: NextResponse } => ({
  ok: false,
  response: NextResponse.json({ ok: false as const, error, ...(code ? { code } : {}) }, { status }),
});

export function checkPhone(business: Business, phone: unknown): PhoneCheck {
  if (typeof phone !== 'string' || phone.replace(/\D/g, '').length < 7) return refuse(422, 'phone must have at least 7 digits');
  const e164 = toE164(phone, countryForBusiness(business));
  if (!e164) return refuse(422, 'phone must be a valid number (use +country code for non-US numbers)');
  return { ok: true, e164, last4: e164.slice(-4) };
}

/** Privacy requests are rare: a small hourly budget per business and kind keeps a stolen session from mass-exporting customers. */
export async function privacyBudget(businessId: string, kind: 'lookup' | 'export' | 'erase'): Promise<NextResponse | null> {
  const limit = kind === 'lookup' ? 60 : 20;
  const r = await rateLimit(`privacy:${kind}:${businessId}`, limit, 60 * 60_000, { failClosed: true });
  if (r.allowed) return null;
  return NextResponse.json({ ok: false as const, error: 'Too many privacy requests. Try again later.', code: 'rate_limited' }, { status: 429, headers: { 'retry-after': String(r.retryAfterS) } });
}
