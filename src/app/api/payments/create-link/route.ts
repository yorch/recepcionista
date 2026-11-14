import { fail, ok, readJson } from '@/lib/http';
import { getBusiness } from '@/lib/db';
import { createPaymentLink } from '@/lib/providers/stripe';

export const dynamic = 'force-dynamic';

const MIN_CENTS = 100;
const MAX_CENTS = 50_000; // $500 deposit cap, enforced in one place

export async function POST(req: Request) {
  try {
    const body = await readJson<{
      business_id: string;
      amount_cents: number;
      description?: string;
      booking_id?: string;
    }>(req);

    if (!body.business_id || !body.amount_cents) {
      return fail('business_id and amount_cents are required', 422);
    }
    if (body.amount_cents < MIN_CENTS || body.amount_cents > MAX_CENTS) {
      return fail(`amount_cents must be between ${MIN_CENTS} and ${MAX_CENTS}`, 422);
    }

    const business = getBusiness(body.business_id);
    if (!business) return fail('business not found', 404);

    const link = await createPaymentLink(
      body.amount_cents,
      body.description ?? `${business.name} deposit`,
      business.name,
    );
    return ok({ ...link, booking_id: body.booking_id ?? null });
  } catch (err) {
    return fail(err, 500);
  }
}
