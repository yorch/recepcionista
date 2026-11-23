import { describe, expect, test } from 'bun:test';
import { isSafeDbName } from '../scripts/_safe-db';
import { backoffSeconds } from '../src/lib/login-throttle';

describe('db-name guard (whole tokens, not substrings)', () => {
  test('disposable names pass', () => {
    for (const n of ['recepcionista_dev', 'recepcionista_test', 'scratch', 'dev', 'local-db', 'app.test', 'my_scratch_2']) {
      expect([n, isSafeDbName(n)]).toEqual([n, true]);
    }
  });
  test('names that merely CONTAIN those letters do not', () => {
    for (const n of ['recepcionista', 'recepcionista_prod_latest', 'contest_production', 'localhost_prod', 'developer_prod', 'attestation', 'recepcionista_prod']) {
      expect([n, isSafeDbName(n)]).toEqual([n, false]);
    }
  });
});

describe('login backoff schedule', () => {
  test('free failures, then 15s doubling to a 15 minute cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 40].map((n) => backoffSeconds(n))).toEqual([0, 0, 0, 15, 30, 60, 120, 240, 480, 900, 900]);
  });
  test('without a trusted proxy the shared key gets a big allowance and a one-minute cap', () => {
    expect(backoffSeconds(20, true)).toBe(0);
    expect(backoffSeconds(21, true)).toBe(15);
    expect(backoffSeconds(60, true)).toBe(60);
  });
});
