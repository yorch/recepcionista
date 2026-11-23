// Minimal typings for `bun:test` so `tsc --noEmit` passes without installing bun-types.
declare module 'bun:test' {
  type Fn = () => void | Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: Fn): void;
  export function it(name: string, fn: Fn): void;
  export function beforeEach(fn: Fn): void;
  export function afterEach(fn: Fn): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function expect(value: unknown): any;
}
