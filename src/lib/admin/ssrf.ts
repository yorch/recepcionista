/**
 * SSRF guard for admin-set hosts (24e T3). Provider API base URLs are NEVER settings; the only admin-set host that the server connects to is the SMTP relay.
 * Checked at save (the store) and again at connect (email/index.ts), because DNS can change in between (rebinding). Node runtime only.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

export const SMTP_PORTS: readonly number[] = [25, 465, 587, 2525];

export class SsrfError extends Error {
  constructor(message: string, readonly code: 'private_address' | 'bad_port' | 'unresolvable' | 'bad_host') {
    super(message);
    this.name = 'SsrfError';
  }
}

/** The eight 16-bit groups of an IPv6 address in ANY textual form (compressed, zero-padded, upper case, embedded dotted quad, zone id); null when it is not one. */
export function ipv6Groups(ip: string): number[] | null {
  let l = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zone = l.indexOf('%');
  if (zone >= 0) l = l.slice(0, zone);
  if (net.isIP(l) !== 6) return null;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(l);
  if (dotted) {
    const o = dotted.slice(1).map(Number);
    l = `${l.slice(0, dotted.index)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = l.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isPrivateV4(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/**
 * True for every address a server must not connect to on an admin's say-so: loopback, unspecified, private, link-local, site-local, CGNAT, unique local, multicast, documentation, reserved and
 * cloud-metadata ranges. IPv6 is judged on its PARSED groups, never on its spelling (`::ffff:7f00:1`, `0:0:0:0:0:0:0:1`, `::127.0.0.1`, `fec0::1` and `2002:7f00:1::` are all private): v4-mapped,
 * v4-compatible and SIIT forms are judged by the IPv4 they carry, 6to4 by its embedded IPv4, NAT64 64:ff9b::/96 by the IPv4 it translates to, Teredo is refused, and only global unicast (2000::/3) is ever allowed.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  if (v === 0) return true; // not an address: refuse
  if (v === 4) { const [a, b] = ip.trim().split('.').map(Number); return isPrivateV4(a, b); }
  const g = ipv6Groups(ip);
  if (!g) return true;
  const v4 = (hi: number): boolean => isPrivateV4(hi >> 8, hi & 255);
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && g[6] === 0 && g[7] <= 1 ? true : v4(g[6]); // ::, ::1, v4-mapped, v4-compatible
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return v4(g[6]); // SIIT ::ffff:0:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6]); // NAT64 64:ff9b::/96 (RFC 6052): judged by the IPv4 it translates to, like 6to4 (the local-use 64:ff9b:1::/48 stays refused below)
  if ((g[0] & 0xe000) !== 0x2000) return true; // everything outside global unicast 2000::/3: ULA, link-local, site-local fec0::/10, multicast, loopback, local-use NAT64, discard
  if (g[0] === 0x2002) return v4(g[1]); // 6to4: the IPv4 it tunnels to
  if (g[0] === 0x2001 && g[1] < 0x200) return true; // 2001::/23 IETF protocol assignments, incl. Teredo 2001::/32
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // documentation 3fff::/20
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;
export const defaultResolver: Resolver = async (host) => (await dns.lookup(host, { all: true })).map((r) => r.address);

/**
 * Validate `host:port` as a public SMTP endpoint and return the ONE address to connect to (every answer of the lookup must be public). Connecting to this address (with the original
 * name as TLS servername) leaves no second lookup for a rebinding DNS server to answer differently. `resolve` is injectable for tests.
 */
export async function resolvePublicSmtpTarget(host: string, port: number | null | undefined, resolve: Resolver = defaultResolver): Promise<string> {
  const h = String(host ?? '').trim().replace(/^\[|\]$/g, '');
  if (!h || h.length > 253 || /[\s/@?#]/.test(h)) throw new SsrfError('invalid SMTP host', 'bad_host');
  if (port != null && !SMTP_PORTS.includes(port)) throw new SsrfError(`SMTP port must be one of ${SMTP_PORTS.join(', ')}`, 'bad_port');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(h)) throw new SsrfError('SMTP host must be a public address', 'private_address');
  let addrs: string[];
  if (net.isIP(h)) addrs = [h];
  else {
    try { addrs = await resolve(h); } catch { throw new SsrfError('SMTP host did not resolve', 'unresolvable'); }
    if (addrs.length === 0) throw new SsrfError('SMTP host did not resolve', 'unresolvable');
  }
  if (addrs.some(isPrivateAddress)) throw new SsrfError('SMTP host must be a public address', 'private_address');
  return addrs[0];
}

/** Throws SsrfError unless `host:port` is a public SMTP endpoint on an allowed port. */
export async function assertPublicSmtpTarget(host: string, port: number | null | undefined, resolve: Resolver = defaultResolver): Promise<void> {
  await resolvePublicSmtpTarget(host, port, resolve);
}

/** host and port of an `smtp://user:pass@host:port` / `smtps://` URL (null when unparseable). The credentials are never returned. */
export function smtpTargetOfUrl(raw: string): { host: string; port: number | null } | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') return null;
    return { host: u.hostname, port: u.port ? Number(u.port) : u.protocol === 'smtps:' ? 465 : 587 };
  } catch {
    return null;
  }
}
