/**
 * Validate a post-login `next` target. Parses against a dummy origin and
 * requires the result to stay on that origin, so `/\evil.com`, `//evil.com`,
 * tab/newline tricks and encoded variants all fall back to the default.
 * Pure (no node imports): used from a client component.
 */
const DUMMY_ORIGIN = 'https://app.invalid';

export function safeNextPath(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next || typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//')) return fallback;
  // Control chars and backslashes are stripped/normalised by URL parsers: reject outright.
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  let decoded = next;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return fallback;
  }
  if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) return fallback;
  try {
    const u = new URL(next, DUMMY_ORIGIN);
    if (u.origin !== DUMMY_ORIGIN) return fallback;
    if (!u.pathname.startsWith('/') || u.pathname.startsWith('//')) return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
