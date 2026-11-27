import { ok } from '@/lib/http';
import { requireRecentAuth } from '@/lib/session';
import { guardAdminRoute, adminFail, readBody } from '@/lib/admin/guard';
import { can } from '@/lib/admin/permissions';
import { SettingsError } from '@/lib/admin/settings-store';
import { isProviderId, secretFormatOk, testProvider } from '@/lib/admin/provider-tests';
import { settingDef } from '@/lib/config';
import { recordProviderHealth } from '@/lib/admin/provider-health';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ provider: string }> };

/** Candidate keys a test may carry, per provider (everything else is refused: a test never accepts an arbitrary setting). */
const ALLOWED: Record<string, readonly string[]> = {
  twilio: ['twilio.account_sid', 'twilio.auth_token', 'twilio.messaging_service_sid'],
  elevenlabs: ['elevenlabs.api_key'],
  stripe: ['stripe.secret_key', 'stripe.price_id', 'stripe.price_id_annual'],
  openai: ['llm.openai_api_key', 'llm.openai_model'],
  anthropic: ['llm.anthropic_api_key', 'llm.anthropic_model'],
  resend: ['email.resend_api_key', 'email.from'],
  smtp: ['email.smtp_url', 'email.smtp_host', 'email.smtp_port', 'email.smtp_user', 'email.smtp_pass', 'email.smtp_secure'],
  google: ['google.client_id', 'google.client_secret'],
  turnstile: ['signup.turnstile_secret_key', 'signup.turnstile_site_key'],
};

/**
 * POST { candidate?: { "<registry key>": "<value>" } } tests ONE provider against the real provider API and answers a COARSE result
 * (`outcome`: ok | auth_failed | unreachable | misconfigured, a few enumerated sub-checks, for Stripe the test / live and account comparison with the current key and how many
 * businesses would be orphaned). Without `candidate` it tests what is configured now. A candidate is NOT saved and never stored, logged or echoed; remote error text is never returned.
 * Writes nothing. A candidate test needs a recent sign-in (step-up) because the server then uses typed credentials and, for SMTP, connects to a typed host; a candidate that names the SMTP target (url / host / port) never inherits the STORED login. Provider API addresses are fixed in code. 6 requests per minute. Permission: settings.secrets.write (owner) for a candidate, providers.repair (ops, owner) for the stored configuration.
 */
export async function POST(req: Request, { params }: Ctx) {
  const g = await guardAdminRoute(req, { permission: ['settings.secrets.write', 'providers.repair'], rate: { name: 'provider-test', max: 6 } });
  if (!g.ok) return g.response;
  try {
    const provider = (await params).provider;
    if (!isProviderId(provider)) throw new SettingsError(404, 'not_found', 'unknown provider');
    const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
    let candidate: Record<string, string> | undefined;
    if (body.candidate !== undefined) {
      if (!can(g.ctx.principal, 'settings.secrets.write')) throw new SettingsError(403, 'forbidden', 'testing a new value needs the secrets permission');
      const stale = requireRecentAuth(g.ctx.auth); // a candidate makes the server send the typed credentials (and, for SMTP, connect to the typed host): step-up like the save itself
      if (stale) return stale;
      const c = body.candidate;
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new SettingsError(422, 'invalid_body', 'candidate must be an object');
      candidate = {};
      for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
        if (!ALLOWED[provider].includes(k) || !settingDef(k)) throw new SettingsError(422, 'invalid_body', `"${k}" is not a field of this provider`);
        if (typeof v !== 'string' || v.length > 8192) throw new SettingsError(422, 'invalid_value', `"${k}" must be a string`);
        if (settingDef(k)?.kind === 'secret' && !secretFormatOk(v, k)) throw new SettingsError(422, 'invalid_value', `"${k}" has an invalid format`);
        candidate[k] = v.trim();
      }
    }
    const result = await testProvider(provider, { candidate });
    if (!candidate) await recordProviderHealth({ provider, outcome: result.outcome, ms: result.ms, tested_at: result.tested_at, checks: result.checks as Record<string, string> | undefined }, g.ctx.actor); // a candidate test says nothing about the stored configuration
    return ok(result);
  } catch (err) { return adminFail(err); }
}
