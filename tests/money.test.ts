import { describe, expect, test } from 'bun:test';
import { centsToDollars, dollarsToCents, formatCents } from '../src/lib/money';

describe('money (integer cents)', () => {
  test('dollarsToCents rounds and tolerates formatting', () => {
    expect(dollarsToCents(189)).toBe(18900);
    expect(dollarsToCents(150.5)).toBe(15050);
    expect(dollarsToCents('$1,234.50')).toBe(123450);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30); // float noise
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents(null)).toBeNull();
    expect(dollarsToCents(NaN)).toBeNull();
  });
  test('centsToDollars', () => {
    expect(centsToDollars(18900)).toBe(189);
    expect(centsToDollars(1)).toBe(0.01);
  });
  test('formatCents', () => {
    expect(formatCents(18900)).toBe('$189');
    expect(formatCents(15050)).toBe('$150.50');
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(0)).toBe('$0');
    expect(formatCents(-250)).toBe('-$2.50');
    expect(formatCents(18900, { fractionalAlways: true })).toBe('$189.00');
    expect(formatCents(null)).toBe('—');
  });
});
