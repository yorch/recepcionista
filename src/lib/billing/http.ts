/**
 * Error -> response mapping shared by the billing routes.
 */
import { fail } from '@/lib/http';
import { authErrorResponse } from '@/lib/session';
import { BillingConfigError, BillingProviderError } from '@/lib/providers/stripe-billing';
import { billingRequiredResponse } from './gate';
import { logger } from '@/lib/log';

const log = logger('billing.route');

export function billingErrorResponse(err: unknown) {
  const auth = authErrorResponse(err);
  if (auth) return auth;
  const required = billingRequiredResponse(err);
  if (required) return required;
  if (err instanceof BillingConfigError) {
    log.error('not_configured', { message: err.message });
    return fail('billing is not configured', 503);
  }
  if (err instanceof BillingProviderError) return fail('billing provider error', 502);
  return fail(err, 500);
}
