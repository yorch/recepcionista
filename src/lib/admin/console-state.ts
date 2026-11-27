/**
 * Process-wide console flags that PURE modules read (admin-2fa.ts, the health route). Lives on globalThis so the proxy and route bundles agree.
 * Pure: no I/O, no node imports.
 */
interface ConsoleFlags {
  /** The settings loader was started in this process: DB-held settings can be written, so the admin 2FA invariant is forced ON. */
  active: boolean;
}
const KEY = Symbol.for('rc.admin.console-flags');
const flags = (): ConsoleFlags => {
  const g = globalThis as unknown as Record<symbol, ConsoleFlags | undefined>;
  return (g[KEY] ??= { active: false });
};
export const setConsoleActive = (active: boolean): void => { flags().active = active; };
export const isConsoleActive = (): boolean => flags().active;
