/**
 * Stripe webhook signature verification (`Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`).
 * Pure + Web Crypto, so it also runs on the Edge runtime. Several v1 values are tolerated (secret rotation):
 * the signature is valid when ANY of them matches. The signed payload is `<t>.<raw body>`.
 */
export type SignatureVerdict = { ok: true } | { ok: false; error: string };

/** Stripe's own default replay window. */
export const SIGNATURE_TOLERANCE_S = 300;

export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  opts: { now?: number; toleranceS?: number } = {},
): Promise<SignatureVerdict> {
  if (!header) return { ok: false, error: 'missing stripe-signature header' };
  if (!secret) return { ok: false, error: 'no secret' };

  let timestamp = '';
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1' && v) candidates.push(v.toLowerCase());
  }
  if (!/^\d{1,12}$/.test(timestamp) || candidates.length === 0) return { ok: false, error: 'malformed stripe-signature header' };

  const nowS = (opts.now ?? Date.now()) / 1000;
  const age = Math.abs(nowS - Number(timestamp));
  if (!Number.isFinite(age) || age > (opts.toleranceS ?? SIGNATURE_TOLERANCE_S)) return { ok: false, error: 'timestamp outside tolerance' };

  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
    const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
    // Check every candidate (no early exit) so timing does not reveal which one matched.
    let matched = false;
    for (const c of candidates) if (constantTimeEqual(expected, c)) matched = true;
    return matched ? { ok: true } : { ok: false, error: 'mismatch' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
