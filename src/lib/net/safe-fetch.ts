/**
 * SSRF-safe fetch for user-supplied URLs.
 *
 * - http/https only, ports 80/443 only, no credentials in the URL
 * - single-label hosts and *.local/*.internal/localhost rejected
 * - every resolved address must be public (loopback, private, link-local,
 *   CGNAT, metadata, ULA, IPv4-mapped/NAT64/6to4 of those are all blocked)
 * - validation happens inside the socket `lookup`, so the address that was
 *   checked is the address that is connected to (no DNS-rebinding window)
 * - redirects are followed manually (max 3) and every hop is re-validated
 * - response is streamed with a byte cap and an overall timeout
 * - only text/html-ish content types are returned
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export interface SafeFetchOptions {
  /** Max body bytes kept (default 1.5MB). Extra bytes are discarded; the fetch is aborted. */
  maxBytes?: number;
  /** Overall timeout across all hops (default 12s). */
  timeoutMs?: number;
  /** Max redirects followed (default 3). */
  maxRedirects?: number;
  /** Allowed content-type prefixes. Default text/html, application/xhtml+xml, text/plain. */
  allowedContentTypes?: string[];
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

const DEFAULT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp', '.localdomain', '.home.arpa'];

// ---------------------------------------------------------------- IP checks

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
  if (allZeroUpTo(6)) return false; // deprecated IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPublicV4(v4FromGroups(g[6], g[7])); // NAT64
  }
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
  const kind = net.isIP(ip);
  if (kind === 4) return isPublicV4(ip);
  if (kind === 6) return isPublicV6(ip);
  return false;
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
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new UnsafeUrlError('address is not publicly routable');
    return u;
  }
  if (!host.includes('.')) throw new UnsafeUrlError('single-label hosts are not allowed');
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError('internal hostnames are not allowed');
  }
  return u;
}

/** Resolve a hostname and require every address to be public. Exported for reuse/tests. */
export async function resolvePublic(hostname: string): Promise<string[]> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new UnsafeUrlError('address is not publicly routable');
    return [host];
  }
  const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0) throw new UnsafeUrlError('host did not resolve');
  for (const a of addrs) {
    if (!isPublicIp(a.address)) throw new UnsafeUrlError('host resolves to a non-public address');
  }
  return addrs.map((a) => a.address);
}

/** `lookup` hook for http(s).request: validates and pins the address that is actually connected to. */
function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  cb: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void,
): void {
  resolvePublic(hostname).then(
    (addrs) => {
      const first = addrs[0];
      const family = net.isIP(first);
      if (options && options.all) cb(null, addrs.map((address) => ({ address, family: net.isIP(address) })));
      else cb(null, first, family);
    },
    (err) => cb(err as NodeJS.ErrnoException),
  );
}

// -------------------------------------------------------------------- fetch

interface Hop {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: Readable;
  abort: () => void;
}

function requestOnce(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: { ...headers, 'accept-encoding': 'gzip, deflate, br' },
        lookup: safeLookup as unknown as net.LookupFunction,
        signal,
        agent: false,
      },
      (res) => {
        let stream: Readable = res;
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc && enc !== 'identity') {
          res.destroy();
          reject(new Error('unsupported content-encoding'));
          return;
        }
        stream.on('error', () => { /* surfaced by the reader */ });
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          stream,
          abort: () => { stream.destroy(); res.destroy(); req.destroy(); },
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function readCapped(stream: Readable, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** Fetch a user-supplied URL with SSRF protection. Throws UnsafeUrlError or Error. */
export async function safeFetchText(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const allowed = opts.allowedContentTypes ?? DEFAULT_TYPES;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 12_000);

  let current = assertSafeUrlShape(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(current, opts.headers ?? {}, signal);
    try {
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        res.abort();
        if (hop === maxRedirects) throw new Error('too many redirects');
        // Re-validate the next hop; resolution is re-checked again at connect time.
        current = assertSafeUrlShape(new URL(String(res.headers.location), current));
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
      if (!allowed.some((t) => contentType.startsWith(t))) throw new Error('unsupported content type');
      const { text, truncated } = await readCapped(res.stream, maxBytes);
      return { url: current.toString(), status: res.status, contentType, body: text, truncated };
    } finally {
      res.abort();
    }
  }
  throw new Error('too many redirects');
}
