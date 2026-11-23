// Minimal typings for `bun:test` so `tsc --noEmit` passes without installing bun-types.
declare module 'bun:test' {
  type Fn = () => void | Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export namespace describe { function skip(name: string, fn: () => void): void; }
  export function beforeAll(fn: Fn): void;
  export function afterAll(fn: Fn): void;
  export function test(name: string, fn: Fn, timeoutMs?: number): void;
  export function it(name: string, fn: Fn): void;
  export function beforeEach(fn: Fn): void;
  export function afterEach(fn: Fn): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function expect(value: unknown): any;
  export namespace expect { function stringContaining(s: string): unknown; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function spyOn(obj: any, method: string): { mockImplementation: (fn: (...args: any[]) => any) => { mockRestore: () => void }; mockRestore: () => void };
}
