import { describe, expect, test } from 'bun:test';
import { smsCapFor, callMinutesCapFor, DEFAULT_TRIAL_SMS_CAP, DEFAULT_TRIAL_CALL_MINUTES_CAP } from '../src/lib/db/usage';
import { isGsm7, smsSegments, STOP_FOOTER, withStopFooter } from '../src/lib/messaging/policy';

const env = (o: Record<string, string> = {}) => o as unknown as NodeJS.ProcessEnv;

describe('smsSegments: real carrier segments, not sends', () => {
  test('GSM-7: 160 single, 153 per concatenated segment', () => {
    expect(smsSegments('')).toBe(0);
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('a'.repeat(306))).toBe(2);
    expect(smsSegments('a'.repeat(307))).toBe(3);
    expect(smsSegments('a'.repeat(459))).toBe(3);
    expect(smsSegments('a'.repeat(460))).toBe(4);
  });

  test('GSM-7 extension characters cost two septets', () => {
    expect(smsSegments('{'.repeat(80))).toBe(1); // 160 septets
    expect(smsSegments('{'.repeat(81))).toBe(2); // 162 septets
    expect(smsSegments('€'.repeat(80))).toBe(1);
  });

  test('UCS-2 (any emoji / non-GSM character): 70 single, 67 per segment', () => {
    expect(isGsm7('hola 😀')).toBe(false);
    expect(smsSegments('á'.repeat(70))).toBe(1);
    expect(smsSegments('á'.repeat(71))).toBe(2);
    expect(smsSegments('á'.repeat(134))).toBe(2);
    expect(smsSegments('á'.repeat(135))).toBe(3);
  });

  test('an emoji is two UTF-16 units: it can push a short text into a second segment', () => {
    expect(smsSegments(`${'a'.repeat(68)}😀`)).toBe(1); // 68 + 2 = 70 units
    expect(smsSegments(`${'a'.repeat(69)}😀`)).toBe(2); // 71 units
  });

  test('one accented letter switches the WHOLE message to UCS-2 (Spanish text costs more segments)', () => {
    const plain = 'Hola, su cita es manana a las 9 con Jorge para revisar el aire acondicionado'; // GSM-7
    expect(smsSegments(plain)).toBe(1);
    const accented = 'Hola, su cita es mañana a las 9 con Jorge para revisar el aire acondicionado'; // ñ is GSM
    expect(smsSegments(accented)).toBe(1);
    const acute = 'Hola, su cita es mañana a las 9:00 con Jorge para revisar el aire acondicionado, está confirmada'; // á is NOT GSM
    expect(isGsm7(acute)).toBe(false);
    expect(smsSegments(acute)).toBe(Math.ceil(acute.length / 67));
  });
});

describe('footer budget keeps a customer text within its segment budget', () => {
  test('the STOP footer is always present and the body is trimmed, never the footer', () => {
    for (const body of ['a'.repeat(700), 'á'.repeat(700), '😀'.repeat(300), `Hola ${'ñ'.repeat(400)} 😀`]) {
      const out = withStopFooter(body);
      expect(out.endsWith(STOP_FOOTER)).toBe(true);
      expect(smsSegments(out)).toBeLessThanOrEqual(5);
      expect([...out].length).toBeLessThanOrEqual(300);
    }
  });

  test('a short text gets the footer and stays one or two segments; GSM text stays GSM when trimmed', () => {
    const out = withStopFooter('Your appointment is tomorrow at 9am.');
    expect(out).toBe(`Your appointment is tomorrow at 9am. ${STOP_FOOTER}`);
    expect(smsSegments(out)).toBe(1);
    const trimmed = withStopFooter('x'.repeat(1000));
    expect(isGsm7(trimmed)).toBe(true);
    expect(trimmed).toContain('...');
  });

  test('the metered unit count is the segment count of the text that actually goes out (footer included)', () => {
    const body = 'a'.repeat(150); // 1 segment alone, 2 once the footer is added
    expect(smsSegments(body)).toBe(1);
    expect(smsSegments(withStopFooter(body))).toBe(2);
  });
});

describe('plan and trial caps', () => {
  test('paid plans: PLAN_SMS_CAP (default 500) and PLAN_CALL_MINUTES_CAP (default 300)', () => {
    expect(smsCapFor({ billing_status: 'active' }, env())).toBe(500);
    expect(smsCapFor({ billing_status: 'active' }, env({ PLAN_SMS_CAP: '900' }))).toBe(900);
    expect(callMinutesCapFor({ billing_status: 'active' }, env())).toBe(300);
    expect(smsCapFor({}, env())).toBe(500);
  });

  test('trialing: lower defaults (50 texts / 30 minutes), configurable', () => {
    expect(DEFAULT_TRIAL_SMS_CAP).toBe(50);
    expect(DEFAULT_TRIAL_CALL_MINUTES_CAP).toBe(30);
    expect(smsCapFor({ billing_status: 'trialing' }, env())).toBe(50);
    expect(callMinutesCapFor({ billing_status: 'trialing' }, env())).toBe(30);
    expect(smsCapFor({ billing_status: 'trialing' }, env({ TRIAL_SMS_CAP: '20' }))).toBe(20);
    expect(callMinutesCapFor({ billing_status: 'trialing' }, env({ TRIAL_CALL_MINUTES_CAP: '10' }))).toBe(10);
    expect(smsCapFor({ billing_status: 'trialing' }, env({ TRIAL_SMS_CAP: 'junk' }))).toBe(50);
  });

  test('a trial never gets MORE than the paid plan', () => {
    expect(smsCapFor({ billing_status: 'trialing' }, env({ PLAN_SMS_CAP: '30', TRIAL_SMS_CAP: '80' }))).toBe(30);
    expect(callMinutesCapFor({ billing_status: 'trialing' }, env({ PLAN_CALL_MINUTES_CAP: '5' }))).toBe(5);
  });

  test('admin overrides win over both the trial and the plan cap', () => {
    expect(smsCapFor({ billing_status: 'trialing', sms_cap_override: 1000 }, env())).toBe(1000);
    expect(smsCapFor({ billing_status: 'trialing', sms_cap_override: 0 }, env())).toBe(0);
    expect(callMinutesCapFor({ billing_status: 'trialing', call_minutes_cap_override: 120 }, env())).toBe(120);
    expect(smsCapFor({ billing_status: 'active', sms_cap_override: 7 }, env({ PLAN_SMS_CAP: '900' }))).toBe(7);
  });

  test('other statuses use the plan cap', () => {
    for (const s of ['none', 'past_due', 'canceled', 'unpaid'] as const) expect(smsCapFor({ billing_status: s }, env())).toBe(500);
  });
});
