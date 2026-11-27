/**
 * The single answer to "did this text really go out?". Pure (no imports) so any layer can use it.
 *
 * `sent` = Twilio accepted it. `mock` = no Twilio credentials: the text was only logged. A mock is treated as delivered
 * ONLY outside production (dev, tests, the demo); in production it is NEVER delivered, so no caller may tell a customer
 * "I texted you", record consent, meter the plan, or report "code sent" off it.
 */
import { configEnv } from '@/lib/config';
export type SmsProviderStatus = 'sent' | 'mock' | 'failed' | string;

/** Error code `sendSms` returns in production when Twilio is not (fully) configured. */
export const SMS_PROVIDER_NOT_CONFIGURED = 'sms_provider_not_configured';

export function mockSmsAllowed(env: NodeJS.ProcessEnv = configEnv()): boolean {
  return env.NODE_ENV !== 'production';
}

export function smsDelivered(status: SmsProviderStatus | null | undefined, env: NodeJS.ProcessEnv = configEnv()): boolean {
  if (status === 'sent') return true;
  return status === 'mock' && mockSmsAllowed(env);
}
