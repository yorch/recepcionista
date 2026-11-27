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

/** True for loopback, private, link-local, CGNAT, ULA, multicast, reserved and cloud-metadata addresses (IPv4 and IPv6, incl. v4-mapped). */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 0) return true; // not an address: refuse
  if (v === 6) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (l === '::' || l === '::1') return true;
    if (/^f[cd]/.test(l)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(l)) return true; // fe80::/10 link local
    if (/^ff/.test(l)) return true; // multicast
    if (l.startsWith('64:ff9b:') || l.startsWith('2001:db8')) return true; // NAT64 / documentation
    return false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export type Resolver = (host: string) => Promise<string[]>;
export const defaultResolver: Resolver = async (host) => (await dns.lookup(host, { all: true })).map((r) => r.address);

/** Throws SsrfError unless `host:port` is a public SMTP endpoint on an allowed port. `resolve` is injectable for tests. */
export async function assertPublicSmtpTarget(host: string, port: number | null | undefined, resolve: Resolver = defaultResolver): Promise<void> {
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
