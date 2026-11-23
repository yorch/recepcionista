import { fail, ok, readJson } from '@/lib/http';
import { getBusiness } from '@/lib/db';
import { limitRequest } from '@/lib/ratelimit';
import { createPaymentLink } from '@/lib/providers/stripe';
import type { PaymentLink } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const MIN_CENTS = 100; // $1 — Stripe's floor
export const MAX_CENTS = 50_000; // $500 — the deposit cap in the call script

export interface CreateLinkResult extends PaymentLink {
  mock: boolean;
  booking_id: string | null;
}

export async function POST(req: Request) {
  const limited = limitRequest(req, 'payments/create-link', 20);
  if (limited) return limited;
  try {
    const body = await readJson<{
      business_id?: string;
      amount_cents?: number;
      description?: string;
      booking_id?: string;
    }>(req);

    const business = body.business_id ? await getBusiness(body.business_id) : null;
    if (!business) return fail('business not found', 404);

    const amountCents = Number(body.amount_cents);
    if (!Number.isFinite(amountCents) || amountCents < MIN_CENTS || amountCents > MAX_CENTS) {
      return fail(`amount_cents must be between ${MIN_CENTS} and ${MAX_CENTS}`, 422);
    }

    const link = await createPaymentLink(
      Math.round(amountCents),
      body.description?.trim() || `${business.name} deposit`,
      business.name,
    );

    return ok<CreateLinkResult>({ ...link, booking_id: body.booking_id ?? null });
  } catch (err) {
    return fail(err, 500);
  }
}
