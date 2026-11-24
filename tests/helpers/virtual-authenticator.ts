/**
 * A software WebAuthn authenticator for tests (ES256, "none" attestation), built on node:crypto only.
 * It produces the JSON a browser's @simplewebauthn/browser would send, so the REAL @simplewebauthn/server verification runs in the routes.
 * Knobs let a test forge the cases a verifier must reject: wrong origin, wrong rpID, user verification off, counter regression, tampering.
 */
import crypto from 'node:crypto';

const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');

// ── minimal CBOR (maps with int/text keys, ints, bytes, text) ──
function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  throw new Error('cbor: too large');
}
type Cbor = number | string | Buffer | Map<Cbor, Cbor>;
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') { const t = Buffer.from(v); return Buffer.concat([cborHead(3, t.length), t]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  return Buffer.concat([cborHead(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

export interface Flags { up?: boolean; uv?: boolean; be?: boolean; bs?: boolean }
const flagByte = (f: Flags, at = false) => (f.up === false ? 0 : 1) | (f.uv === false ? 0 : 4) | (at ? 0x40 : 0) | (f.be ? 0x08 : 0) | (f.bs ? 0x10 : 0);
const rpIdHash = (rpId: string) => crypto.createHash('sha256').update(rpId).digest();

export class VirtualAuthenticator {
  readonly credentialId = crypto.randomBytes(32);
  readonly userHandle: Buffer | null = null;
  counter = 0;
  private readonly key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  constructor(public readonly opts: { counterAlwaysZero?: boolean } = {}) {}

  get id(): string { return b64u(this.credentialId); }

  private cosePublicKey(): Buffer {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  }

  /** navigator.credentials.create() answer for options from /register/options. */
  create(options: { challenge: string }, o: { origin: string; rpId: string; flags?: Flags; challenge?: string; type?: string } ): Record<string, unknown> {
    const cd = JSON.stringify({ type: o.type ?? 'webauthn.create', challenge: o.challenge ?? options.challenge, origin: o.origin, crossOrigin: false });
    const counter = Buffer.alloc(4);
    const credLen = Buffer.alloc(2); credLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([rpIdHash(o.rpId), Buffer.from([flagByte(o.flags ?? { uv: true, be: true, bs: true }, true)]), counter, Buffer.alloc(16), credLen, this.credentialId, this.cosePublicKey()]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64u(Buffer.from(cd)), attestationObject: b64u(attestationObject), transports: ['internal'] },
    };
  }

  /** navigator.credentials.get() answer. `counter` forces the reported counter; otherwise it increments. */
  get(options: { challenge: string }, o: {
    origin: string; rpId: string; flags?: Flags; counter?: number; challenge?: string; type?: string; userHandle?: string | null; tamper?: boolean;
  }): Record<string, unknown> {
    if (o.counter !== undefined) this.counter = o.counter; else if (!this.opts.counterAlwaysZero) this.counter += 1;
    const cd = Buffer.from(JSON.stringify({ type: o.type ?? 'webauthn.get', challenge: o.challenge ?? options.challenge, origin: o.origin, crossOrigin: false }));
    const c = Buffer.alloc(4); c.writeUInt32BE(this.counter);
    const authData = Buffer.concat([rpIdHash(o.rpId), Buffer.from([flagByte(o.flags ?? { uv: true })]), c]);
    const signed = Buffer.concat([authData, crypto.createHash('sha256').update(cd).digest()]);
    let signature = crypto.sign('sha256', signed, this.key.privateKey);
    if (o.tamper) signature = Buffer.concat([signature.subarray(0, signature.length - 1), Buffer.from([signature[signature.length - 1] ^ 1])]);
    return {
      id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature),
        ...(o.userHandle ? { userHandle: o.userHandle } : {}),
      },
    };
  }
}
