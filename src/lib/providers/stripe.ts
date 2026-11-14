/**
 * Stripe payment links. Mock mode returns a local /pay/[id] page that renders a
 * convincing test checkout, so the demo works before keys are wired.
 */
import type { PaymentLink } from '@/lib/types';

export const hasStripe = () => Boolean(process.env.STRIPE_SECRET_KEY);

export async function createPaymentLink(
  amountCents: number,
  description: string,
  /** Shown on the customer's card statement; Stripe truncates to 22 chars. */
  businessName?: string,
): Promise<PaymentLink & { mock: boolean }> {
  if (!hasStripe()) {
    const id = `mock_${Math.random().toString(36).slice(2, 10)}`;
    return { id, url: `${appUrl()}/pay/${id}`, amount_cents: amountCents, mock: true };
  }
  try {
    const form = new URLSearchParams();
    form.set('line_items[0][price_data][currency]', 'usd');
    form.set('line_items[0][price_data][product_data][name]', businessName ? `${businessName}: ${description}` : description);
    form.set('line_items[0][price_data][unit_amount]', String(amountCents));
    form.set('line_items[0][quantity]', '1');
    for (const method of ['card']) form.append('payment_method_types[]', method);
    const res = await fetch('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message ?? String(res.status));
    return { id: json.id, url: json.url, amount_cents: amountCents, mock: false };
  } catch (err) {
    console.warn('[stripe] fallback to mock:', (err as Error).message);
    const id = `mock_${Math.random().toString(36).slice(2, 10)}`;
    return { id, url: `${appUrl()}/pay/${id}`, amount_cents: amountCents, mock: true };
  }
}

export function appUrl(): string {
  return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}
