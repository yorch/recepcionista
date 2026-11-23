/**
 * Client-safe URL helpers (no node:* imports). The authoritative SSRF checks
 * (DNS resolution, redirects) run server-side in src/lib/net/safe-fetch.ts.
 */
import { assertSafeUrlShape } from '@/lib/net/ip-shape';

/** Normalize a user-supplied URL. Returns null when unusable. */
export function normalizeUrl(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.startsWith('//')) return null;
  const scheme = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    // Structural SSRF checks (scheme, credentials, port, single-label/internal
    // hosts, non-public IP literals). DNS is re-checked at connect time.
    return assertSafeUrlShape(new URL(s)).toString();
  } catch {
    return null;
  }
}
