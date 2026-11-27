/**
 * Component-level checks of the providers page (server render, no browser): every state of a secret (Set / Not set / Locked by environment), the source badges, the
 * "applies" notes, the dual-secret window, role-dependent controls, webhook addresses with a copy button, labels and roles for assistive technology, Spanish copy, and the
 * one thing that matters most: a secret value never appears in the markup.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminProvider, type AdminMe } from '../src/components/admin/provider';
import { ProviderCard } from '../src/components/admin/provider-card';
import { FollowUpBanner } from '../src/components/admin/provider-followup';
import { KeyRotationPanel } from '../src/components/admin/provider-rotation';
import { SecretField } from '../src/components/admin/secret-field';
import { I18nProvider } from '../src/lib/i18n/client';
import { en } from '../src/lib/i18n/en';
import { es } from '../src/lib/i18n/es';
import { allSettings } from '../src/lib/config/registry';
import { CARDS } from '../src/lib/admin/provider-meta';
import { PERMISSIONS } from '../src/lib/admin/permissions';
import type { ProvidersInfo, SettingView } from '../src/components/admin/provider-api';

const SECRET_VALUE = 'sk_live_NEVER_IN_THE_MARKUP_0123456789';

function view(key: string, over: Partial<SettingView> = {}, secret?: Partial<NonNullable<SettingView['secret']>>): SettingView {
  const def = allSettings().find((d) => d.key === key)!;
  const isSecret = def.kind === 'secret';
  return {
    key, env: def.env ?? null, group: def.group, label: def.label, help: def.help, kind: def.kind, class: def.class, tier: def.tier, scope: def.scope, applies: def.applies,
    follow_up: def.followUp ?? null, ratchet: null, tighten_is: null, paired_with: def.pairedWith ?? [], unit: null, schema: { type: 'string', ...(def.schema.info as object) }, tenant: null,
    source: 'default', locked: false, locked_reason: null, env_invalid: false, value: isSecret ? null : null, default: null, console_value: null, version: null, updated_at: null, updated_by: null,
    secret: isSecret ? { key, set: false, source: 'none', ...secret } : null, ...over,
  } as SettingView;
}
const views = (patch: Record<string, SettingView> = {}) => new Map<string, SettingView>([...CARDS.flatMap((c) => c.fields).map((f) => [f.key, view(f.key)] as const), ...Object.entries(patch)]);

const me = (permissions: readonly string[], over: Partial<AdminMe> = {}): AdminMe => ({ role: 'owner', via: 'user', email: 'o@example.test', twoFactor: true, permissions: permissions as AdminMe['permissions'], sudoAt: null, frozen: false, frozenByEnv: false, ...over });
const OWNER = me(PERMISSIONS);
const READ_ONLY = me(['settings.read', 'selftest.read', 'system.read'], { role: 'read_only' });
const page = (node: React.ReactNode, who: AdminMe = OWNER, locale: 'en' | 'es' = 'en') => renderToStaticMarkup(
  <I18nProvider locale={locale} messages={locale === 'en' ? en : es}><AdminProvider me={who}>{node}</AdminProvider></I18nProvider>,
);
const info = (over: Partial<ProvidersInfo> = {}): ProvidersInfo => ({
  base_url: 'https://app.example.test', base_url_pinned: true,
  webhooks: [
    { id: 'twilio_sms', card: 'telephony', path: '/api/sms/inbound', url: 'https://app.example.test/api/sms/inbound', secret_key: 'twilio.auth_token', verifier_configured: true },
    { id: 'twilio_voice', card: 'telephony', path: '/api/voice/incoming', url: null, secret_key: 'twilio.auth_token', verifier_configured: true },
    { id: 'stripe_billing', card: 'payments', path: '/api/billing/webhook', url: 'https://app.example.test/api/billing/webhook', secret_key: 'stripe.billing_webhook_secret', verifier_configured: false },
  ],
  google_redirect: { url: 'https://app.example.test/api/integrations/google/callback', overridden: false },
  usage: { numbers: 7, agents: 5, stripe_customers: 3, messaging_service: false }, stripe_mode: 'live', follow_ups: [], ...over,
});
const card = (id: string) => CARDS.find((c) => c.id === id)!;

describe('secret states', () => {
  test('Not set: the Set button, a not-set badge, no fingerprint', () => {
    const html = page(<SecretField view={view('stripe.secret_key')} partners={[]} test="stripe" onChanged={() => undefined} />);
    expect(html).toContain('Not set');
    expect(html).toContain('>Set</button>');
    expect(html).not.toContain('Fingerprint');
    expect(html).not.toContain('Remove');
  });
  test('Set by the console: fingerprint, last 4, who and when, Replace and Remove; the dual-secret window shows until when', () => {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    const v = view('stripe.secret_key', { source: 'console' }, { set: true, source: 'console', fingerprint: 'ab12cd34', last4: '6789', updated_at: '2026-01-02T10:00:00.000Z', updated_by: 'ana@example.test', previous_accepted_until: until });
    const html = page(<SecretField view={v} partners={[]} test="stripe" onChanged={() => undefined} />);
    expect(html).toContain('Fingerprint ab12cd34');
    expect(html).toContain('ends in 6789');
    expect(html).toContain('by ana@example.test');
    expect(html).toContain('The previous secret is also accepted until');
    expect(html).toContain('Replace');
    expect(html).toContain('Remove');
    expect(html).not.toContain(SECRET_VALUE);
  });
  test('Locked by environment: no Replace, no Remove, the variable is named for screen readers and in the help text', () => {
    const v = view('stripe.secret_key', { source: 'env', locked: true, locked_reason: 'env' }, { set: true, source: 'env' });
    const html = page(<SecretField view={v} partners={[]} test="stripe" onChanged={() => undefined} />);
    expect(html).toContain('Locked by environment');
    expect(html).toContain('STRIPE_SECRET_KEY');
    expect(html).not.toContain('>Replace<');
    expect(html).not.toContain('>Remove<');
  });
  test('a role without the secrets permission and a frozen console get disabled buttons with the reason', () => {
    const v = view('stripe.secret_key', { source: 'console' }, { set: true, source: 'console', fingerprint: 'ab12cd34', last4: '6789' });
    const ro = page(<SecretField view={v} partners={[]} test="stripe" onChanged={() => undefined} />, READ_ONLY);
    expect(ro).toMatch(/<button[^>]*disabled[^>]*>Replace/);
    expect(ro).toContain('Only an owner can change secrets.');
    const frozen = page(<SecretField view={v} partners={[]} test="stripe" onChanged={() => undefined} />, me(PERMISSIONS, { frozen: true }));
    expect(frozen).toMatch(/<button[^>]*disabled[^>]*>Replace/);
  });
  test('a read-only role sees no fingerprint (the server hides it)', () => {
    const v = view('stripe.secret_key', { source: 'console' }, { set: true, source: 'console' });
    const html = page(<SecretField view={v} partners={[]} test="stripe" onChanged={() => undefined} />, READ_ONLY);
    expect(html).toContain('Details hidden for your role.');
  });
  test('a pair shows its plain partner next to the secret', () => {
    const sid = view('twilio.account_sid', { source: 'console', value: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
    const html = page(<SecretField view={view('twilio.auth_token', { source: 'console' }, { set: true, source: 'console', fingerprint: 'deadbeef', last4: 'abcd' })} partners={[sid]} test="twilio" onChanged={() => undefined} />);
    expect(html).toContain('Account SID');
    expect(html).toContain('ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });
});

describe('provider cards', () => {
  test('one card per provider with a region role, a title and a status', () => {
    for (const c of CARDS) {
      const html = page(<ProviderCard card={c} views={views()} info={info()} live={null} onChanged={() => undefined} />);
      expect(html).toContain('role="region"');
      expect(html).toContain(en[`ap.card.${c.id}.title` as keyof typeof en]);
      expect(html).toContain('Not set');
    }
  });
  test('telephony: status from the field sources, usage facts, webhook addresses with a Copy button; a missing base URL says so', () => {
    const v = views({
      'twilio.account_sid': view('twilio.account_sid', { source: 'env', locked: true, locked_reason: 'env', value: 'ACenv' }),
      'twilio.auth_token': view('twilio.auth_token', { source: 'env', locked: true, locked_reason: 'env' }, { set: true, source: 'env' }),
    });
    const html = page(<ProviderCard card={card('telephony')} views={v} info={info()} live={null} onChanged={() => undefined} />);
    expect(html).toContain('Locked by environment');
    expect(html).toContain('7 tenant numbers');
    expect(html).toContain('No Messaging Service');
    expect(html).toContain('https://app.example.test/api/sms/inbound');
    expect(html).toContain('aria-label="Copy: Incoming texts"');
    expect(html).toContain('Unavailable: no public address is configured.');
    expect(html).toContain('Verified with the Twilio auth token');
  });
  test('payments: a missing signature secret is called out, the mode and the customers on file are shown', () => {
    const html = page(<ProviderCard card={card('payments')} views={views()} info={info()} live={null} onChanged={() => undefined} />);
    expect(html).toContain('Signature secret missing');
    expect(html).toContain('Live mode');
    expect(html).toContain('3 Stripe customers on file');
  });
  test('the connection test: a result badge and a Test button for a role that may run it, not for one that may not', () => {
    const live = { provider: 'twilio', ready: false, missing: [], tested: true, test: { provider: 'twilio' as const, outcome: 'auth_failed' as const, tested_at: '2026-01-02T10:00:00.000Z', ms: 12, scope: 'remote' as const } };
    const owner = page(<ProviderCard card={card('telephony')} views={views({ 'twilio.account_sid': view('twilio.account_sid', { source: 'console', value: 'ACx' }), 'twilio.auth_token': view('twilio.auth_token', { source: 'console' }, { set: true, source: 'console' }) })} info={info()} live={live} onChanged={() => undefined} />);
    expect(owner).toContain('Credentials rejected');
    expect(owner).toContain('Test connection');
    const ro = page(<ProviderCard card={card('telephony')} views={views({ 'twilio.account_sid': view('twilio.account_sid', { source: 'console', value: 'ACx' }), 'twilio.auth_token': view('twilio.auth_token', { source: 'console' }, { set: true, source: 'console' }) })} info={info()} live={live} onChanged={() => undefined} />, READ_ONLY);
    expect(ro).toContain('Credentials rejected');
    expect(ro).not.toContain('Test connection');
  });
  test('ai card shows the fixed timeout; calendar shows the derived redirect read-only; email lists the SMTP SSRF note', () => {
    expect(page(<ProviderCard card={card('ai')} views={views()} info={info()} live={null} onChanged={() => undefined} />)).toContain('30 seconds (fixed in the code)');
    const cal = page(<ProviderCard card={card('calendar')} views={views()} info={info()} live={null} onChanged={() => undefined} />);
    expect(cal).toContain('Derived from the public address. Read-only.');
    expect(cal).toContain('https://app.example.test/api/integrations/google/callback');
    expect(page(<ProviderCard card={card('email')} views={views()} info={info()} live={null} onChanged={() => undefined} />)).toContain('Public hosts only');
  });
  test('Spanish copy for the same card, with the usted register of the catalog', () => {
    const html = page(<ProviderCard card={card('telephony')} views={views()} info={info()} live={null} onChanged={() => undefined} />, OWNER, 'es');
    expect(html).toContain('Telefonía (Twilio)');
    expect(html).toContain('Sin definir');
    expect(html).toContain('Direcciones de webhook');
    expect(html).not.toContain('Not set');
  });
  test('no secret value is ever rendered, whatever the metadata says', () => {
    const v = views({ 'stripe.secret_key': view('stripe.secret_key', { source: 'console', value: SECRET_VALUE as never }, { set: true, source: 'console', fingerprint: 'ab12cd34', last4: '6789' }) });
    // even a (buggy) listing that carried a value in `value` for a secret must not reach the markup: secrets only render their metadata
    const html = page(<ProviderCard card={card('payments')} views={v} info={info()} live={null} onChanged={() => undefined} />);
    expect(html).not.toContain(SECRET_VALUE);
  });
});

describe('follow-ups and rotation', () => {
  test('a pending follow-up shows a labelled region, the changed keys by label and a Review and run button', () => {
    const html = page(<FollowUpBanner state={{ action: 'resync_agents', pending: true, since: '2026-01-02T10:00:00.000Z', keys: ['elevenlabs.tool_secret'] }} total={5} onFinished={() => undefined} />);
    expect(html).toContain('role="region"');
    expect(html).toContain('Voice agents need a re-sync');
    expect(html).toContain('Tool secret');
    expect(html).toContain('Review and run');
    expect(html).not.toContain('Apply to all'); // the dry run comes first, the runner is closed
  });
  test('the rotation panel: key id, previous key, canary, what remains, and the steps in order', () => {
    const html = page(<KeyRotationPanel system={{ keys: { current_kid: 'kid12345', previous_kid: 'old67890' }, loader: { canary: 'ok' }, reencrypt: { settings: { remaining: 2 }, revisions: { remaining: 0 }, totp: { remaining: 1 }, calendar_tokens: { remaining: 0 }, done: false } }} onDone={() => undefined} />);
    expect(html).toContain('Key in use: kid12345');
    expect(html).toContain('Previous key present (old67890)');
    expect(html).toContain('The secret canary decrypts');
    expect(html).toContain('2 console secrets');
    expect(html).toContain('Re-encrypt all');
    expect(html).toMatch(/<ol[^>]*>[\s\S]*APP_SECRET_KEY_PREVIOUS[\s\S]*<\/ol>/);
    expect(page(<KeyRotationPanel system={null} onDone={() => undefined} />)).toContain('Key information is not available to your role.');
    expect(page(<KeyRotationPanel system={{ keys: { current_kid: 'k', previous_kid: null }, loader: {}, reencrypt: null }} onDone={() => undefined} />, READ_ONLY)).toContain('Only an owner can re-encrypt.');
  });
});
