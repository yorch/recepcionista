/**
 * Pure (no node:* imports) IP and URL-shape checks, safe to bundle for the
 * browser. Network I/O and DNS live in safe-fetch.ts (server only).
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp', '.localdomain', '.home.arpa'];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function isPublicV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const [base, bits] of V4_BLOCKS) {
    const b = ipv4ToInt(base) as number;
    const size = 2 ** (32 - bits);
    if (n >= b && n < b + size) return false;
  }
  return true;
}

/** Expand an IPv6 literal to 8 16-bit groups, or null if malformed. */
function expandV6(ip: string): number[] | null {
  let s = ip.split('%')[0].toLowerCase();
  // Embedded dotted IPv4 tail.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isPublicV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return false;
  const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUpTo(7) && (g[7] === 0 || g[7] === 1)) return false; // :: and ::1
  if (allZeroUpTo(5) && g[5] === 0xffff) return isPublicV4(v4FromGroups(g[6], g[7])); // ::ffff:a.b.c.d
  if (allZeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return false; // ::ffff:0:a.b.c.d (SIIT)
  if (allZeroUpTo(6)) return false; // deprecated IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPublicV4(v4FromGroups(g[6], g[7])); // NAT64
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false; // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x2002) return isPublicV4(v4FromGroups(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return false; // discard-only
  if ((g[0] & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return false; // site-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return true;
}

/** True only for globally routable unicast addresses. */
export function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPublicV4(ip);
  if (kind === 6) return isPublicV6(ip);
  return false;
}

/** Pure replacement for node:net isIP: 4, 6 or 0. */
export function isIP(s: string): 0 | 4 | 6 {
  if (/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(s)) return ipv4ToInt(s) === null ? 0 : 4;
  if (s.includes(':') && /^[0-9a-fA-F:.%\w]+$/.test(s) && expandV6(s) !== null) return 6;
  return 0;
}

// ----------------------------------------------------------- URL validation

/** Throws UnsafeUrlError unless the URL is structurally safe to resolve. DNS is checked at connect time. */
export function assertSafeUrlShape(raw: string | URL): URL {
  let u: URL;
  try {
    u = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    throw new UnsafeUrlError('invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeUrlError('only http/https URLs are allowed');
  if (u.username || u.password) throw new UnsafeUrlError('credentials in URL are not allowed');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (port !== 80 && port !== 443) throw new UnsafeUrlError('only ports 80 and 443 are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new UnsafeUrlError('missing host');
  if (isIP(host)) {
    if (!isPublicIp(host)) throw new UnsafeUrlError('address is not publicly routable');
    return u;
  }
  if (!host.includes('.')) throw new UnsafeUrlError('single-label hosts are not allowed');
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError('internal hostnames are not allowed');
  }
  return u;
}
