/**
 * The Stripe customer of a business: reuse the stored one, else create it once. Node runtime only.
 */
import { prisma } from '@/lib/db/client';
import { createCustomer } from '@/lib/providers/stripe-billing';
import type { Business } from '@/lib/types';

/**
 * Returns the business's Stripe customer id, creating the customer on first use. Two concurrent first
 * checkouts both create a customer, but only one id is stored (compare-and-set); the loser adopts the winner's,
 * leaving at most one empty orphan customer in Stripe.
 */
export async function ensureCustomer(business: Business, email: string | null): Promise<string> {
  if (business.stripe_customer_id) return business.stripe_customer_id;
  const created = await createCustomer(business, email);
  const won = await prisma.business.updateMany({ where: { id: business.id, stripeCustomerId: null }, data: { stripeCustomerId: created } });
  if (won.count === 1) return created;
  const row = await prisma.business.findUnique({ where: { id: business.id }, select: { stripeCustomerId: true } });
  return row?.stripeCustomerId ?? created;
}
