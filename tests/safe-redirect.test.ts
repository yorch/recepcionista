import { describe, expect, test } from 'bun:test';
import { safeNextPath } from '../src/lib/safe-redirect';

describe('safeNextPath', () => {
  test('allows same-origin paths', () => {
    expect(safeNextPath('/dashboard/bookings')).toBe('/dashboard/bookings');
    expect(safeNextPath('/dashboard?tab=1#x')).toBe('/dashboard?tab=1#x');
  });
  test('rejects open-redirect variants', () => {
    for (const n of ['//evil.com', '/\\evil.com', '/%5Cevil.com', '/\t/evil.com', '/%09/evil.com', 'https://evil.com', 'javascript:alert(1)', 'evil.com', '/%2F/evil.com', '', '/\n/evil.com', '/%']) {
      expect(safeNextPath(n)).toBe('/dashboard');
    }
    expect(safeNextPath(null)).toBe('/dashboard');
  });
});
