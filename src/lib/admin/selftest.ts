/**
 * Provider readiness for GET /api/admin/selftest: which providers are configured, and where each field comes from (env | console | default). It reads the SAME registry
 * values the runtime uses, so it answers "would the app use this provider right now?". It never returns, logs or hashes a value, and makes NO network call
 * (`tested: false`): Phase 4 adds the real connection tests behind the same shape.
 */
import { setting, settingSource, type SettingKey } from '@/lib/config';
import { emailConfigured, resolveEmailProvider } from '@/lib/email';

export interface ProviderReadiness {
  provider: string;
  ready: boolean;
  /** Registry keys required for the provider to work that are not set. */
  missing: string[];
  fields: Record<string, { set: boolean; source: 'env' | 'console' | 'default' }>;
  /** Phase 4: a real connection test. Always false here. */
  tested: boolean;
  note?: string;
}

const isSet = (key: SettingKey): boolean => {
  const v = setting(key);
  return typeof v === 'string' ? v.trim() !== '' : v !== null && v !== undefined;
};

function card(provider: string, required: SettingKey[], optional: SettingKey[] = [], note?: string, anyOf?: SettingKey[][]): ProviderReadiness {
  const fields: ProviderReadiness['fields'] = {};
  for (const k of [...required, ...optional, ...(anyOf ?? []).flat()]) fields[k] = { set: isSet(k), source: settingSource(k) };
  const missing = required.filter((k) => !fields[k].set);
  const anyOk = !anyOf || anyOf.some((group) => group.every((k) => fields[k].set));
  if (!anyOk) missing.push(...(anyOf as SettingKey[][])[0].filter((k) => !fields[k].set));
  return { provider, ready: missing.length === 0 && anyOk, missing, fields, tested: false, ...(note ? { note } : {}) };
}

export function selftest(): { providers: ProviderReadiness[]; ready: boolean; tested: false } {
  let emailProvider = 'unset';
  try { emailProvider = resolveEmailProvider(); } catch { /* reported below */ }
  const emailCard = card('email', [], ['email.provider', 'email.from', 'email.resend_api_key', 'email.smtp_url', 'email.smtp_host']);
  const emailReady = emailConfigured();
  const email: ProviderReadiness = { ...emailCard, ready: emailReady, missing: emailReady ? [] : ['email.provider'], note: `active provider: ${emailProvider}` };
  const providers: ProviderReadiness[] = [
    card('twilio', ['twilio.account_sid', 'twilio.auth_token'], ['twilio.phone_number', 'twilio.messaging_service_sid'], undefined, [['twilio.phone_number'], ['twilio.messaging_service_sid']]),
    card('elevenlabs', ['elevenlabs.api_key', 'elevenlabs.webhook_secret', 'elevenlabs.tool_secret'], ['elevenlabs.tool_secret_id', 'elevenlabs.phone_number_id', 'elevenlabs.voice_id']),
    card('stripe', ['stripe.secret_key', 'stripe.webhook_secret'], ['stripe.billing_webhook_secret', 'stripe.price_id', 'stripe.price_id_annual']),
    card('llm', [], ['llm.openai_api_key', 'llm.anthropic_api_key', 'llm.openai_model', 'llm.anthropic_model'], 'one of the two API keys is required in production', [['llm.openai_api_key'], ['llm.anthropic_api_key']]),
    email,
    card('google', ['google.client_id', 'google.client_secret'], ['google.webhook_secret', 'google.oauth_redirect_uri']),
    card('turnstile', ['signup.turnstile_secret_key', 'signup.turnstile_site_key']),
  ];
  return { providers, ready: providers.every((p) => p.ready), tested: false };
}
