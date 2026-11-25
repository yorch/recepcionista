/**
 * Dependency-free SMS sender configuration check. Lives apart from sender.ts (which imports the database layer) so `instrumentation.ts`, which is also traced for the
 * Edge runtime, can import it without pulling node-only modules into that bundle.
 */
const MESSAGING_SERVICE_RE = /^MG[0-9a-fA-F]{32}$/;
function messagingServiceSid(env: NodeJS.ProcessEnv): string | null {
  const v = (env.TWILIO_MESSAGING_SERVICE_SID ?? '').trim();
  return MESSAGING_SERVICE_RE.test(v) ? v : null;
}

/**
 * The warning for a deployment whose SMS sending is not production-safe, or null: Twilio is live but TWILIO_MESSAGING_SERVICE_SID is missing (or malformed), so every
 * customer text leaves from the tenant's own number, which US carriers filter unless it is registered to an A2P 10DLC campaign. Twilio still answers 201, so the app
 * cannot tell: delivery failures only surface through the status callback (audit `sms.delivery_failed`) and are never retried.
 */
export function smsSenderProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const has = (v?: string) => Boolean(v && v.trim());
  if (!(has(env.TWILIO_ACCOUNT_SID) && has(env.TWILIO_AUTH_TOKEN) && has(env.TWILIO_PHONE_NUMBER))) return null; // mock / not configured: other checks report that
  if (has(env.TWILIO_MESSAGING_SERVICE_SID)) {
    return messagingServiceSid(env) ? null : 'TWILIO_MESSAGING_SERVICE_SID is set but is not a Messaging Service sid (MG followed by 32 hex characters): it is IGNORED, so customer texts leave from each tenant\'s own number.';
  }
  if (env.NODE_ENV !== 'production') return null;
  return 'TWILIO_MESSAGING_SERVICE_SID is not set: customer texts leave from each tenant\'s own Twilio number, and US carriers filter texts from a number that is not registered to an A2P 10DLC campaign (Twilio still answers 201, so the app cannot see the loss; only the status callback reports failures). Register the numbers under one platform campaign and set TWILIO_MESSAGING_SERVICE_SID (docs/runbook.md section 3).';
}
