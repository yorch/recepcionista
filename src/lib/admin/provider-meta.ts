/**
 * What the /admin/providers page knows about each provider card: which registry keys belong to it, which ones travel together (credential pairs), which test checks which
 * secret, which paths are the webhook addresses and when a follow-up (re-sync agents / repair numbers) is still pending. PURE: no I/O, safe in a client bundle.
 */

export type CardId = 'telephony' | 'voice' | 'payments' | 'ai' | 'email' | 'calendar' | 'captcha';
export type TestId = 'twilio' | 'elevenlabs' | 'stripe' | 'openai' | 'anthropic' | 'resend' | 'smtp' | 'google' | 'turnstile';
export type FieldRole = 'id' | 'secret' | 'setting';

export interface FieldDef {
  key: string;
  role: FieldRole;
  /** Which provider test checks this secret (absent: format check only). */
  test?: TestId;
}

export interface CardDef {
  id: CardId;
  /** The `selftest` card name (status tile). */
  selftest: string;
  fields: readonly FieldDef[];
  /** The tests this card offers (candidate testing of a single secret uses the field's `test`). */
  tests: readonly TestId[];
}

const id = (key: string): FieldDef => ({ key, role: 'id' });
const set = (key: string): FieldDef => ({ key, role: 'setting' });
const sec = (key: string, test?: TestId): FieldDef => ({ key, role: 'secret', ...(test ? { test } : {}) });

export const CARDS: readonly CardDef[] = [
  { id: 'telephony', selftest: 'twilio', tests: ['twilio'], fields: [id('twilio.account_sid'), sec('twilio.auth_token', 'twilio'), id('twilio.phone_number'), id('twilio.messaging_service_sid')] },
  { id: 'voice', selftest: 'elevenlabs', tests: ['elevenlabs'], fields: [sec('elevenlabs.api_key', 'elevenlabs'), sec('elevenlabs.webhook_secret'), sec('elevenlabs.tool_secret'), id('elevenlabs.tool_secret_id'), id('elevenlabs.phone_number_id'), id('elevenlabs.voice_id')] },
  { id: 'payments', selftest: 'stripe', tests: ['stripe'], fields: [sec('stripe.secret_key', 'stripe'), sec('stripe.webhook_secret'), sec('stripe.billing_webhook_secret'), id('stripe.price_id'), id('stripe.price_id_annual')] },
  { id: 'ai', selftest: 'llm', tests: ['openai', 'anthropic'], fields: [sec('llm.openai_api_key', 'openai'), id('llm.openai_model'), sec('llm.anthropic_api_key', 'anthropic'), id('llm.anthropic_model')] },
  {
    id: 'email', selftest: 'email', tests: ['resend', 'smtp'],
    fields: [set('email.provider'), set('email.from'), sec('email.resend_api_key', 'resend'), sec('email.smtp_url', 'smtp'), set('email.smtp_host'), set('email.smtp_port'), set('email.smtp_secure'), set('email.smtp_user'), sec('email.smtp_pass', 'smtp')],
  },
  { id: 'calendar', selftest: 'google', tests: ['google'], fields: [id('google.client_id'), sec('google.client_secret', 'google'), sec('google.webhook_secret'), set('google.oauth_redirect_uri')] },
  { id: 'captcha', selftest: 'turnstile', tests: ['turnstile'], fields: [id('signup.turnstile_site_key'), sec('signup.turnstile_secret_key', 'turnstile')] },
];

export const cardOf = (cardId: string): CardDef | undefined => CARDS.find((c) => c.id === cardId);
export const cardOfKey = (key: string): CardDef | undefined => CARDS.find((c) => c.fields.some((f) => f.key === key));

/** Secret key -> the test that checks it against its provider (candidate testing). */
export const SECRET_TEST: Readonly<Record<string, TestId>> = Object.fromEntries(CARDS.flatMap((c) => c.fields.filter((f) => f.role === 'secret' && f.test).map((f) => [f.key, f.test as TestId])));

/** Credential pairs saved atomically in ONE change set (mirrors the registry `pairedWith`): the secret and the plain id that must travel with it. */
export const PAIRS: Readonly<Record<string, readonly string[]>> = {
  'twilio.auth_token': ['twilio.account_sid'],
  'elevenlabs.tool_secret': ['elevenlabs.tool_secret_id'],
  'google.client_secret': ['google.client_id'],
};

/** The address ElevenLabs / Stripe / Twilio / Google call, as paths under the base URL (the base URL itself is the single resolver `src/lib/base-url.ts`, read-only here). */
export interface WebhookDef { id: string; card: CardId; path: string; /** The secret that verifies it (absent: the Twilio signature is verified with the auth token). */ secret?: string }
export const WEBHOOKS: readonly WebhookDef[] = [
  { id: 'twilio_sms', card: 'telephony', path: '/api/sms/inbound', secret: 'twilio.auth_token' },
  { id: 'twilio_voice', card: 'telephony', path: '/api/voice/incoming', secret: 'twilio.auth_token' },
  { id: 'elevenlabs_postcall', card: 'voice', path: '/api/voice/post-call', secret: 'elevenlabs.webhook_secret' },
  { id: 'elevenlabs_tools', card: 'voice', path: '/api/voice/tools', secret: 'elevenlabs.tool_secret' },
  { id: 'elevenlabs_initiation', card: 'voice', path: '/api/voice/initiation', secret: 'elevenlabs.tool_secret' },
  { id: 'stripe_billing', card: 'payments', path: '/api/billing/webhook', secret: 'stripe.billing_webhook_secret' },
  { id: 'stripe_deposits', card: 'payments', path: '/api/payments/webhook', secret: 'stripe.webhook_secret' },
  { id: 'google_push', card: 'calendar', path: '/api/integrations/google/webhook' },
];
/** The OAuth redirect is derived from the base URL (or the override), never typed: read-only. */
export const GOOGLE_REDIRECT_PATH = '/api/integrations/google/callback';

export type FollowUpAction = 'resync_agents' | 'repair_numbers';
export interface FollowUpState {
  action: FollowUpAction;
  pending: boolean;
  /** When the most recent change that needs this follow-up was saved. */
  since: string | null;
  /** The keys changed since the last completed run. */
  keys: string[];
}

/**
 * A follow-up is pending when a key that needs it was changed AFTER the last COMPLETE real run of that action (a run whose last batch had no `next_cursor`).
 * `revisions` newest first or any order; `doneAt` is the completion time of the last full run per action (null = never).
 */
export function pendingFollowUps(
  revisions: readonly { key: string; at: Date }[],
  doneAt: Readonly<Record<FollowUpAction, Date | null>>,
  followUpOf: (key: string) => FollowUpAction | null,
): FollowUpState[] {
  return (['resync_agents', 'repair_numbers'] as const).map((action) => {
    const done = doneAt[action]?.getTime() ?? 0;
    const newer = revisions.filter((r) => followUpOf(r.key) === action && r.at.getTime() > done);
    const since = newer.reduce<Date | null>((m, r) => (!m || r.at > m ? r.at : m), null);
    return { action, pending: newer.length > 0, since: since ? since.toISOString() : null, keys: [...new Set(newer.map((r) => r.key))].sort() };
  });
}

/** Absolute address of a path under the base URL; null when the base URL is not an absolute http(s) address (nothing to register). */
export const webhookUrl = (base: string | null, path: string): string | null => (base ? `${base.replace(/\/+$/, '')}${path}` : null);

/** 'previous secret accepted until HH:MM' source: the ISO time the dual-secret window closes, when it is still in the future. */
export function windowOpenUntil(iso: string | null | undefined, now: number = Date.now()): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) || d.getTime() <= now ? null : d;
}

/**
 * The format a secret must satisfy before it is stored, tested or sent in a header: one line, no control characters, no whitespace (an app password such as the SMTP
 * password may contain inner spaces, never at the edges).
 */
export function secretFormatOk(v: string, key?: string): boolean {
  if (v.length === 0 || v.length > 8192) return false;
  if (key === 'email.smtp_pass') return !/[\u0000-\u001f\u007f]/.test(v) && v === v.trim();
  return !/[\s\u0000-\u001f\u007f]/.test(v);
}
