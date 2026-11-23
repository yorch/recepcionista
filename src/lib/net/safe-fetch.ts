// SERVER ONLY: uses node:dns/http/https. Never import from client components (client-safe checks live in ip-shape.ts).
// The `server-only` package is not installed, so this is enforced by `next build` in CI.
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

import { isIP, isPublicIp, assertSafeUrlShape, UnsafeUrlError } from './ip-shape';

export { isPublicIp, assertSafeUrlShape, UnsafeUrlError };


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


/** Resolve a hostname and require every address to be public. Exported for reuse/tests. */
export async function resolvePublic(hostname: string): Promise<string[]> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
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
      const family = isIP(first);
      if (options && options.all) cb(null, addrs.map((address) => ({ address, family: isIP(address) })));
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
