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

describe('smsSegments: a two-unit character never straddles a segment boundary (GSM 03.38; docs/review/08 F7)', () => {
  test('GSM extension characters (2 septets) move whole into the next segment', () => {
    // 152 + euro (septets 153-154) + 152: the euro does not fit in the first segment's 153, so it starts the second
    expect(smsSegments(`${'a'.repeat(152)}€${'a'.repeat(152)}`)).toBe(3);
    expect(smsSegments(`${'a'.repeat(151)}€${'a'.repeat(100)}`)).toBe(2); // fits exactly (151 + 2 = 153)
    expect(smsSegments(`${'a'.repeat(152)}\u20ac`)).toBe(1); // 154 septets: still a single (<= 160) segment
    expect(smsSegments(`${'a'.repeat(158)}€`)).toBe(1); // exactly 160 septets stays single
    expect(smsSegments(`${'a'.repeat(159)}€`)).toBe(2); // 161 septets
    // brute force: greedy packing never yields fewer segments than ceil(septets/153) and at most one more per segment boundary
    for (let n = 150; n <= 160; n++) {
      const t = `${'a'.repeat(n)}[${'b'.repeat(300 - n)}`;
      const septets = n + 2 + (300 - n);
      expect(smsSegments(t)).toBeGreaterThanOrEqual(Math.ceil(septets / 153));
      expect(smsSegments(t)).toBeLessThanOrEqual(Math.ceil(septets / 153) + 1);
    }
  });
  test('UCS-2 surrogate pairs (2 code units) are never split across segments', () => {
    expect(smsSegments(`${'a'.repeat(66)}\u{1F600}${'a'.repeat(66)}`)).toBe(3);
    expect(smsSegments(`${'á'.repeat(65)}\u{1F600}${'á'.repeat(40)}`)).toBe(2); // pair ends exactly at unit 67
    expect(smsSegments('\u{1F600}'.repeat(35))).toBe(1); // exactly 70 units stays single
    expect(smsSegments('\u{1F600}'.repeat(36))).toBe(2); // 72 units: 33 pairs per 67-unit segment
  });
  test('unchanged for plain text', () => {
    expect(smsSegments('a'.repeat(306))).toBe(2);
    expect(smsSegments('a'.repeat(307))).toBe(3);
    expect(smsSegments('á'.repeat(134))).toBe(2);
    expect(smsSegments('á'.repeat(135))).toBe(3);
  });
});
