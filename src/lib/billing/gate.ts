/**
 * Billing gates shared by routes. Node runtime only (imports session/db).
 */
import { configEnv } from '@/lib/config';
import { NextResponse } from 'next/server';
import { isProvisioningAllowed } from '@/lib/db';
import type { Principal } from '@/lib/session';
import type { Business } from '@/lib/types';

export const CHECKOUT_PATH = '/api/billing/checkout';

/** The business has no paid plan (billing enforced, or any production non-admin provisioning). Surface as 402. */
export class BillingRequiredError extends Error {
  readonly code = 'billing_required';
  constructor() {
    super('billing_required');
    this.name = 'BillingRequiredError';
  }
}

/**
 * Throws BillingRequiredError when `business` may not buy a number / create an agent.
 * Admin principals bypass (they comp accounts and provision on their behalf). In production a non-admin
 * always needs a plan (even with BILLING_ENFORCED=false); in development nothing is refused unless BILLING_ENFORCED=true.
 */
export function assertProvisioningAllowed(
  principal: Principal,
  business: Pick<Business, 'billing_status' | 'past_due_since'>,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = configEnv(),
): void {
  if (principal.kind === 'admin') return;
  if (!isProvisioningAllowed(business, now, env)) throw new BillingRequiredError();
}

/** 402 response for a BillingRequiredError, null for any other error. */
export function billingRequiredResponse(err: unknown): NextResponse | null {
  if (!(err instanceof BillingRequiredError)) return null;
  return NextResponse.json({ ok: false, error: 'billing_required', checkout: CHECKOUT_PATH }, { status: 402 });
}
