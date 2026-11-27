/**
 * The settings registry (src/lib/config): structure, bounds, per-entry schema tests GENERATED from the registry, documentation of every
 * environment alias, and the guarantee that a registry default is what the code applies today (so the console cannot disagree with the
 * readers). See docs/design/admin-console-architecture.md.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENV_ONLY, RETIRED_ENV, BUILD_TIME_ENV, allSettings, registryStats, settingDef, settingByEnv, s, ratchetAllows,
} from '../src/lib/config';
import { defaultContext, defaultOf } from '../src/lib/config/define';
import type { SettingDef } from '../src/lib/config';
import { VERTICALS, LOCALES, REFUND_POLICIES } from '../src/lib/types';
import { CALL_MODES } from '../src/lib/voice/call-mode';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const ALL = allSettings() as readonly SettingDef[];
const CTXS = ['production', 'development', 'test'].map((e) => defaultContext(e));

describe('registry structure', () => {
  test('size and classes (a regression guard: shrinking the registry must be deliberate)', () => {
    const st = registryStats();
    expect(st.total).toBe(ALL.length);
    expect(st.byClass.SECRET).toBe(15);
    expect(st.byClass.PROVIDER_ID).toBeGreaterThanOrEqual(12);
    expect(st.byClass.SETTING_IN_ADMIN).toBeGreaterThanOrEqual(120);
    expect(st.withEnvAlias).toBeGreaterThanOrEqual(95);
  });

  test('keys are unique, dotted, lower case; env aliases unique and upper case', () => {
    const keys = new Set<string>();
    const envs = new Set<string>();
    for (const d of ALL) {
      expect(d.key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(keys.has(d.key)).toBe(false);
      keys.add(d.key);
      if (d.env) {
        expect(d.env).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(envs.has(d.env)).toBe(false);
        envs.add(d.env);
      }
    }
  });

  test('every entry has a label, help, group, valid tier/applies and derived i18n keys', () => {
    for (const d of ALL) {
      expect(d.label.length).toBeGreaterThan(2);
      expect(d.help.length).toBeGreaterThan(10);
      expect(['normal', 'sensitive', 'critical']).toContain(d.tier);
      expect(['live', 'new_records_only', 'restart_required', 'needs_resync']).toContain(d.applies);
      expect(d.labelKey).toBe(`admin.setting.${d.key}.label`);
      expect(d.helpKey).toBe(`admin.setting.${d.key}.help`);
      if (d.followUp) expect(['resync_agents', 'repair_numbers', 'reregister_webhooks', 'restart']).toContain(d.followUp);
    }
  });

  test('secrets: write-only class, unset by default, critical tier, platform scope, never an env-only name', () => {
    const envOnly = new Set(ENV_ONLY.map((e) => e.name));
    for (const d of ALL.filter((x) => x.kind === 'secret')) {
      expect(d.class).toBe('SECRET');
      expect(d.default).toBeNull();
      expect(d.tier).toBe('critical');
      expect(d.scope).toBe('platform');
      if (d.env) expect(envOnly.has(d.env)).toBe(false);
    }
    for (const d of ALL.filter((x) => x.kind === 'provider_id')) expect(d.class).toBe('PROVIDER_ID');
  });

  test('critical tier covers 24e: money, toll fraud, irreversible deletion, the email channel and credentials', () => {
    const critical = (k: string) => expect(settingDef(k)?.tier).toBe('critical');
    for (const k of ['billing.enforced', 'messaging.allow_unverified_booking_sms', 'messaging.sms_allowed_countries', 'forward.allowed_countries', 'forward.deny_area_codes',
      'jobs.retention_enabled', 'jobs.tenant_release_mode', 'email.provider', 'email.from', 'email.smtp_host', 'twilio.account_sid', 'twilio.phone_number']) critical(k);
  });

  test('registry env aliases never collide with the env-only list or the retired list', () => {
    const forbidden = new Set([...ENV_ONLY.map((e) => e.name), ...RETIRED_ENV.map((r) => r.name)]);
    for (const d of ALL) if (d.env) expect(forbidden.has(d.env)).toBe(false);
  });

  test('the owner-decided env-only security toggles, public origin and the retired names are where D1-D11 put them', () => {
    const only = (n: string) => ENV_ONLY.find((e) => e.name === n);
    for (const n of ['SIGNUP_ALLOW_WITHOUT_CAPTCHA', 'REQUIRE_2FA_FOR_ADMINS', 'LOG_PII']) expect(only(n)?.reason).toBe('security_ratchet');
    for (const n of ['APP_URL', 'PUBLIC_BASE_URL']) expect(only(n)?.reason).toBe('public_origin');
    for (const n of ['APP_SECRET_KEY', 'ADMIN_TOKEN', 'DATABASE_URL']) expect(only(n)?.secret).toBe(true);
    expect(RETIRED_ENV.map((r) => r.name).sort()).toEqual(['ELEVENLABS_AGENT_ID', 'NEXT_PUBLIC_APP_URL', 'OWNER_PHONE_GRANDFATHER', 'OWNER_PHONE_GRANDFATHER_ACK', 'OWNER_PHONE_GRANDFATHER_BEFORE', 'OWNER_PHONE_GRANDFATHER_UNTIL']);
    expect(ENV_ONLY.length).toBe(new Set(ENV_ONLY.map((e) => e.name)).size);
  });

  test('pairedWith points at real keys and is reciprocal', () => {
    for (const d of ALL) for (const p of d.pairedWith ?? []) {
      const other = settingDef(p);
      expect(other).toBeDefined();
      expect(other?.pairedWith ?? []).toContain(d.key);
    }
  });

  test('platform+tenant entries declare tenant rules inside the schema bounds; owners get comfort knobs only (D12)', () => {
    const OWNER_OK = new Set(['messaging.quiet_start_hour', 'messaging.quiet_end_hour', 'jobs.briefing_hour', 'jobs.briefing_enabled', 'jobs.gratitude_enabled', 'forward.ring_seconds']);
    for (const d of ALL.filter((x) => x.scope === 'platform+tenant')) {
      expect(d.tenant).toBeDefined();
      if (d.tenant?.editableBy === 'owner') expect(OWNER_OK.has(d.key)).toBe(true);
      if (d.kind === 'int') {
        const info = d.schema.info as { min?: number; max?: number };
        if (d.tenant?.min !== undefined && info.min !== undefined) expect(d.tenant.min).toBeGreaterThanOrEqual(info.min);
        if (d.tenant?.max !== undefined && info.max !== undefined) expect(d.tenant.max).toBeLessThanOrEqual(info.max);
      }
    }
    for (const k of OWNER_OK) expect(settingDef(k)?.tenant?.editableBy).toBe('owner');
  });

  test('ratchets declare a direction, and the console may only move that way', () => {
    const ratcheted = ALL.filter((d) => d.ratchet);
    expect(ratcheted.length).toBeGreaterThanOrEqual(6);
    for (const d of ratcheted) expect(d.tightenIs).toBeDefined();
    const pw = settingDef('security.password_min_chars') as SettingDef;
    expect(ratchetAllows(pw, 12, 14)).toBe(true);
    expect(ratchetAllows(pw, 14, 12)).toBe(false);
    const sess = settingDef('security.admin_session_ttl_hours') as SettingDef;
    expect(ratchetAllows(sess, 12, 4)).toBe(true);
    expect(ratchetAllows(sess, 4, 12)).toBe(false);
    expect(ratchetAllows({ ratchet: 'env_only_loosen' }, 1, 2)).toBe(false);
    expect(ratchetAllows({}, 1, 2)).toBe(true);
  });
});

describe('every entry: defaults and bounds are valid (all NODE_ENV values)', () => {
  for (const d of ALL) {
    test(d.key, () => {
      for (const ctx of CTXS) {
        const def = defaultOf(d, ctx);
        if (def === null) continue;
        const r = d.schema.check(def);
        if (!r.ok) throw new Error(`${d.key} default ${JSON.stringify(def)} (${ctx.nodeEnv}): ${r.error}`);
        // The text form round-trips (this is what the env-shaped view feeds to the legacy readers).
        const back = d.schema.fromText(d.schema.toText(def as never));
        expect(back.ok).toBe(true);
        if (back.ok) expect(back.value).toEqual(r.value);
      }
      if (d.kind === 'int') {
        const info = d.schema.info as { min?: number; max?: number };
        if (info.min !== undefined && info.max !== undefined) expect(info.min).toBeLessThanOrEqual(info.max);
      }
    });
  }
});

describe('per-entry schema tests generated from the registry', () => {
  for (const d of ALL) {
    test(`${d.key} (${d.kind}): accepts its bounds and rejects junk`, () => {
      const sc = d.schema;
      const info = sc.info as Record<string, unknown>;
      if (sc.type === 'int') {
        const { min, max } = info as { min?: number; max?: number };
        if (min !== undefined) { expect(sc.check(min).ok).toBe(true); expect(sc.check(min - 1).ok).toBe(false); expect(sc.fromText(String(min)).ok).toBe(true); }
        if (max !== undefined) { expect(sc.check(max).ok).toBe(true); expect(sc.check(max + 1).ok).toBe(false); }
        expect(sc.check(1.5).ok).toBe(false);
        expect(sc.check('7').ok).toBe(false);
        expect(sc.fromText('abc').ok).toBe(false);
        expect(sc.fromText('').ok).toBe(false);
      } else if (sc.type === 'bool') {
        expect(sc.fromText('true').ok && sc.fromText('off').ok && sc.fromText('1').ok).toBe(true);
        expect(sc.fromText('maybe').ok).toBe(false);
        expect(sc.check('true').ok).toBe(false);
        expect(sc.check(true).ok).toBe(true);
      } else if (sc.type === 'enum') {
        for (const v of info.values as string[]) expect(sc.check(v).ok).toBe(true);
        expect(sc.check('zzz-not-a-value').ok).toBe(false);
        expect(sc.check(3).ok).toBe(false);
      } else if (sc.type === 'list') {
        expect(sc.check('1,2').ok).toBe(false);
        expect(sc.check([{}]).ok).toBe(false);
        const max = info.max as number;
        if (info.itemInfo && (info.item === 'string')) {
          const tooMany = Array.from({ length: max + 1 }, (_, i) => `x${i}`);
          // the item schema may reject "x#" first; either way a list over the maximum is never accepted
          expect(sc.check(tooMany).ok).toBe(false);
        }
        expect(sc.fromText('').ok).toBe(info.minItems ? false : true);
      } else if (sc.type === 'string') {
        expect(sc.check(42).ok).toBe(false);
        const max = info.max as number;
        expect(sc.check('a'.repeat(max + 1)).ok).toBe(false);
        if (info.format === 'url') {
          expect(sc.check('not a url').ok).toBe(false);
          expect(sc.check('ftp://x.test/').ok).toBe(false);
          expect(sc.check('https://user:pw@x.test/').ok).toBe(false);
          expect(sc.check('https://example.test/path').ok).toBe(true);
        }
        if (info.secret) expect(sc.check('has a space 12345').ok).toBe(false);
      }
    });
  }
});

describe('formats of specific entries', () => {
  const ok = (k: string, v: unknown) => (settingDef(k) as SettingDef).schema.check(v).ok;
  const text = (k: string, v: string) => (settingDef(k) as SettingDef).schema.fromText(v);
  test('provider ids', () => {
    expect(ok('twilio.account_sid', 'AC' + 'a'.repeat(32))).toBe(true);
    expect(ok('twilio.account_sid', 'SK' + 'a'.repeat(32))).toBe(false);
    expect(ok('twilio.phone_number', '+13055550100')).toBe(true);
    expect(ok('twilio.phone_number', '3055550100')).toBe(false);
    expect(ok('twilio.messaging_service_sid', 'MG' + '0'.repeat(32))).toBe(true);
    expect(ok('elevenlabs.phone_number_id', 'phnum_abc')).toBe(true);
    expect(ok('elevenlabs.phone_number_id', 'abc')).toBe(false);
    expect(ok('stripe.price_id', 'price_123')).toBe(true);
    expect(ok('stripe.price_id', 'prod_123')).toBe(false);
  });
  test('lists and countries', () => {
    expect(text('messaging.sms_allowed_countries', '1, 44').ok).toBe(true);
    expect(text('messaging.sms_allowed_countries', '1,+44').ok).toBe(false); // the console stores plain calling codes
    expect(text('messaging.sms_allowed_countries', '').ok).toBe(false);
    expect(ok('forward.deny_area_codes', ['900', '976'])).toBe(true);
    expect(ok('forward.deny_area_codes', ['123'])).toBe(false);
    expect(ok('messaging.default_phone_country', 'us')).toBe(false);
  });
  test('secrets never echo their value in an error', () => {
    const r = (settingDef('stripe.secret_key') as SettingDef).schema.check('has space');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('has space');
  });
});

describe('documentation', () => {
  const doc = read('docs/env-vars.md');
  test('every registry env alias, every env-only name and every retired name is documented in docs/env-vars.md', () => {
    const names = [...ALL.filter((d) => d.env).map((d) => d.env as string), ...ENV_ONLY.map((e) => e.name), ...RETIRED_ENV.map((r) => r.name)];
    const missing = names.filter((n) => !doc.includes(`\`${n}`));
    expect(missing).toEqual([]);
  });
  test('build-time names listed by the registry are exactly the NEXT_PUBLIC aliases', () => {
    const nextPublic = ALL.filter((d) => d.env?.startsWith('NEXT_PUBLIC_')).map((d) => d.env).sort();
    expect([...BUILD_TIME_ENV].sort()).toEqual(nextPublic as string[]);
    for (const d of ALL.filter((x) => x.env?.startsWith('NEXT_PUBLIC_'))) expect(d.applies).toBe('restart_required');
  });
  test('the architecture doc exists and names every tier and the precedence', () => {
    const arch = read('docs/design/admin-console-architecture.md');
    for (const w of ['critical', 'sensitive', 'normal', 'env pin', 'locked by environment', 'rc.config']) expect(arch.toLowerCase()).toContain(w.toLowerCase());
  });
  test('every deprecated name warns in the docs table too', () => {
    for (const r of RETIRED_ENV) expect(doc).toContain(r.name);
  });
});

describe('enums mirror the code they stand for', () => {
  const enumValues = (k: string) => ((settingDef(k) as SettingDef).schema.info.values as string[]).slice().sort();
  test('verticals, locales, refund policies, call modes', () => {
    expect(enumValues('defaults.vertical')).toEqual([...VERTICALS].sort());
    expect(enumValues('defaults.locale')).toEqual([...LOCALES].sort());
    expect(enumValues('platform.default_locale')).toEqual([...LOCALES].sort());
    expect(enumValues('defaults.refund_policy')).toEqual([...REFUND_POLICIES].sort());
    expect(enumValues('defaults.call_mode')).toEqual([...CALL_MODES].sort());
  });
  test('the default time zone is a real IANA zone', () => {
    const tz = (settingDef('defaults.timezone') as SettingDef).default as string;
    expect(() => new Intl.DateTimeFormat('en', { timeZone: tz })).not.toThrow();
  });
});

describe('registry defaults equal what the readers apply today (empty environment)', () => {
  test('env-backed numeric and flag defaults', async () => {
    const usage = await import('../src/lib/db/usage');
    const { trialDays, planName } = await import('../src/lib/providers/stripe-billing');
    const { tickSeconds, jobsSetting } = await import('../src/lib/jobs/schedule');
    const { ownerCallMaxSeconds, ownerCallinEnabled } = await import('../src/lib/voice/owner/config');
    const rc = await import('../src/lib/voice/owner/reply-config');
    const { ownerAlertHourlyLimit } = await import('../src/lib/voice/owner-alert');
    const { inboxForwardHourlyLimit } = await import('../src/lib/messaging/inbox');
    const fm = await import('../src/lib/voice/forward-metering');
    const cl = await import('../src/lib/voice/caller-limits');
    const { forwardRingSeconds } = await import('../src/lib/voice/twiml');
    const { configuredAreaCode } = await import('../src/lib/phone');
    const { signupMaxPerHour } = await import('../src/lib/signup');
    const { reconcileAfterMinutes, reconcileMaxAttempts } = await import('../src/lib/voice/reconcile');
    const { briefingAudioKeepDays } = await import('../src/lib/db/briefing-audio');
    const { refundReconcileAfterMs } = await import('../src/lib/refund-service');
    const { liveLimits } = await import('../src/lib/voice/live-stream');
    const { DEFAULT_MAX_POLLS } = await import('../src/lib/voice/live-transcript');
    const { nativeTransferEnabled } = await import('../src/lib/voice/transfer');
    const { languageDetectionEnabled, DEFAULT_VOICE_ID } = await import('../src/lib/voice/elevenlabs');
    const { allowedCountryCodes } = await import('../src/lib/messaging/recipient');
    const E = {} as NodeJS.ProcessEnv;
    const def = (k: string, nodeEnv = 'test') => defaultOf(settingDef(k) as SettingDef, defaultContext(nodeEnv));
    const want: [string, unknown][] = [
      ['billing.trial_days', trialDays(E)], ['billing.plan_name', planName(E)],
      ['billing.past_due_grace_days', usage.pastDueGraceDays(E)],
      ['billing.plan_sms_cap', usage.DEFAULT_SMS_CAP], ['billing.plan_call_minutes_cap', usage.DEFAULT_CALL_MINUTES_CAP],
      ['billing.trial_sms_cap', usage.DEFAULT_TRIAL_SMS_CAP], ['billing.trial_call_minutes_cap', usage.DEFAULT_TRIAL_CALL_MINUTES_CAP],
      ['forward.minutes_cap', usage.DEFAULT_FORWARD_MINUTES_CAP], ['forward.trial_minutes_cap', usage.DEFAULT_TRIAL_FORWARD_MINUTES_CAP],
      ['voicemail.minutes_cap', usage.voicemailMinutesCap(E)],
      ['jobs.tick_seconds', tickSeconds(E)],
      ['owner.call_max_seconds', ownerCallMaxSeconds(E)], ['owner.callin_enabled', ownerCallinEnabled(E)],
      ['owner.reply_daily_limit', rc.ownerReplyDailyLimit(E)], ['owner.reply_require_attestation', rc.ownerReplyRequiresAttestation(E)],
      ['owner.alert_hourly_limit', ownerAlertHourlyLimit(E)], ['messaging.inbox_forward_hourly_limit', inboxForwardHourlyLimit(E)],
      ['forward.max_call_seconds', fm.forwardMaxCallSeconds(E)], ['forward.max_concurrent', fm.forwardMaxConcurrent(E)],
      ['forward.min_answered_seconds', fm.forwardMinAnsweredSeconds(E)], ['forward.calls_per_hour', fm.forwardCallsPerHour(E)],
      ['voicemail.calls_per_hour', fm.voicemailsPerHour(E)], ['forward.ring_seconds', forwardRingSeconds(E)],
      ['forward.per_caller_per_hour', cl.perCallerPerHour('forward', E)], ['voicemail.per_caller_per_hour', cl.perCallerPerHour('voicemail', E)],
      ['forward.withheld_per_hour', cl.withheldPerHour('forward', E)], ['voicemail.withheld_per_hour', cl.withheldPerHour('voicemail', E)],
      ['callers.unknown_share_pct', cl.unknownSharePct(E)], ['voice.stir_trust', cl.stirTrustEnabled(E)],
      ['twilio.area_code', configuredAreaCode(E)], ['signup.max_per_hour', signupMaxPerHour(E)],
      ['reconcile.after_minutes', reconcileAfterMinutes(E)], ['reconcile.max_attempts', reconcileMaxAttempts(E)],
      ['data.briefing_audio_keep_days', briefingAudioKeepDays(E)], ['billing.refund_reconcile_after_hours', refundReconcileAfterMs(E) / 3_600_000],
      ['live.max_per_user', liveLimits(E).perUser], ['live.max_per_business', liveLimits(E).perBusiness], ['live.max_polls_per_call', DEFAULT_MAX_POLLS],
      ['voice.native_transfer', nativeTransferEnabled(E)], ['elevenlabs.language_detection', languageDetectionEnabled(E)],
      ['elevenlabs.voice_id', DEFAULT_VOICE_ID], ['messaging.sms_allowed_countries', allowedCountryCodes(undefined)],
    ];
    for (const [k, v] of want) expect([k, def(k)]).toEqual([k, v]);
    // NODE_ENV dependent defaults
    for (const [nodeEnv, jobsOn] of [['production', true], ['development', false], ['test', false]] as const) {
      expect(def('jobs.enabled', nodeEnv)).toBe(jobsOn);
      expect(jobsSetting({ NODE_ENV: nodeEnv } as unknown as NodeJS.ProcessEnv).enabled).toBe(jobsOn);
      expect(def('billing.enforced', nodeEnv)).toBe(nodeEnv === 'production');
      expect(usage.billingEnforced({ NODE_ENV: nodeEnv } as unknown as NodeJS.ProcessEnv)).toBe(nodeEnv === 'production');
    }
    expect(def('email.provider', 'production')).toBeNull();
    expect(def('email.provider', 'development')).toBe('log');
    expect(want.length).toBeGreaterThanOrEqual(40);
  });

  test('promoted constants: the registry default IS the constant named in codeRef', () => {
    const UNIT_S: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400, ms: 0.001 };
    let verified = 0;
    for (const d of ALL.filter((x) => x.source === 'promoted_const' && x.codeRef && /^src\/.*\.ts:/.test(x.codeRef))) {
      const [file, ref] = (d.codeRef as string).split(':');
      const src = read(file);
      const [name, prop] = ref.split('.');
      let actual: unknown;
      if (prop) {
        const obj = src.match(new RegExp(`${name}[^=]*=[^{]*\\{([^}]*)\\}`))?.[1] ?? '';
        const m = obj.match(new RegExp(`\\b${prop}:\\s*(\\d+)`));
        expect(m).not.toBeNull();
        actual = Number(m?.[1]);
      } else {
        const m = src.match(new RegExp(`const ${name}(?:\\s*:[^=]+)?\\s*=\\s*([^;]+);`));
        expect(m).not.toBeNull();
        const expr = (m?.[1] ?? '').split('//')[0].trim();
        if (/^'[^']*'$/.test(expr)) actual = expr.slice(1, -1);
        else if (/^\[.*\]$/.test(expr)) actual = JSON.parse(expr.replace(/'/g, '"'));
        else if (/^[0-9_ *+()]+$/.test(expr)) {
          const raw = Number(new Function(`return (${expr.replace(/_/g, '')})`)());
          const srcUnit = /_MS$/.test(name) ? 0.001 : /_(S|SECONDS)$/.test(name) ? 1 : undefined;
          const wantUnit = d.unit ? UNIT_S[d.unit] : undefined;
          actual = srcUnit !== undefined && wantUnit !== undefined ? (raw * srcUnit) / wantUnit : raw;
        } else throw new Error(`cannot evaluate ${d.codeRef}: ${expr}`);
      }
      expect([d.key, defaultOf(d, defaultContext('test'))]).toEqual([d.key, actual]);
      verified++;
    }
    expect(verified).toBeGreaterThanOrEqual(38);
  });

  test('DEFAULT_SCHEDULING and KB limits are mirrored as new-tenant defaults and limits', () => {
    const bc = read('src/lib/business-config.ts');
    const line = bc.match(/DEFAULT_SCHEDULING[^=]*=\s*Object\.freeze\(\{([^}]*)\}/)?.[1] ?? '';
    for (const k of ['slot_minutes', 'min_lead_minutes', 'horizon_days', 'buffer_minutes', 'crews']) {
      expect(defaultOf(settingDef(`defaults.${k}`) as SettingDef, defaultContext('test'))).toBe(Number(line.match(new RegExp(`${k}:\\s*(\\d+)`))?.[1]));
    }
  });

  test('settingByEnv resolves an alias to its entry', () => {
    expect(settingByEnv('BILLING_TRIAL_DAYS')?.key).toBe('billing.trial_days');
    expect(settingByEnv('NOT_A_VAR')).toBeUndefined();
    expect(s.int({ min: 1 }).check(0).ok).toBe(false);
  });
});
