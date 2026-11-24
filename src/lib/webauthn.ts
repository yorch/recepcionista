/**
 * WebAuthn (passkeys) ceremonies on top of @simplewebauthn/server. Node runtime only.
 *
 *  - rpID / origins come from configuration, never from the request in production: the relying party is the host of PUBLIC_BASE_URL
 *    (else APP_URL); WEBAUTHN_RP_ID overrides it (a registrable parent domain) and WEBAUTHN_ORIGINS adds exact extra origins (staging).
 *    The browser-reported origin must equal one of them EXACTLY (scheme, host, port), and its host must be the rpID or a subdomain.
 *  - challenges are single use, short lived (5 min) and bound to their purpose (and to the user for register/reauth): stored through
 *    createWebauthnChallenge and consumed atomically INSIDE verification, before the signature is checked.
 *  - user verification is REQUIRED everywhere (registration, login, step-up): a passkey login therefore counts as a second factor.
 *  - the signature counter is NOT checked by the library (we hand it 0): recordPasskeyUse does it atomically in the database, so two
 *    concurrent assertions of one credential cannot both pass, and a regression is reported to the caller as `clone_suspected`.
 */
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  consumeWebauthnChallenge, createWebauthnChallenge, getPasskeyByCredentialId, listPasskeys, recordPasskeyUse,
} from '@/lib/db/passkeys';
import type { PasskeySummary, WebauthnPurpose } from '@/lib/types';

export const RP_NAME = 'Recepcionista';

export interface WebauthnConfig { rpID: string; origins: string[] }

const isLocalHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');

function parseOrigin(v: string): URL | null {
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname))) return null; // WebAuthn needs a secure context
    return u;
  } catch {
    return null;
  }
}

/**
 * The relying party. `null` when passkeys are not configured: production needs PUBLIC_BASE_URL/APP_URL (https). Outside production, with
 * neither set, the request's own origin is used (`devOrigin`), so `next dev` and tests work without configuration.
 */
export function webauthnConfig(env: NodeJS.ProcessEnv = process.env, devOrigin?: string | null): WebauthnConfig | null {
  const baseRaw = (env.PUBLIC_BASE_URL || env.APP_URL || '').trim();
  let base = baseRaw ? parseOrigin(baseRaw) : null;
  if (!base && !baseRaw && env.NODE_ENV !== 'production' && devOrigin) base = parseOrigin(devOrigin);
  const extra = (env.WEBAUTHN_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(parseOrigin).filter((u): u is URL => u !== null);
  const rpOverride = (env.WEBAUTHN_RP_ID ?? '').trim().toLowerCase();
  const first = base ?? extra[0];
  if (!first) return null;
  const rpID = rpOverride || first.hostname.toLowerCase();
  const origins = [...new Set([...(base ? [base] : []), ...extra].map((u) => u.origin))]
    // An origin outside the rpID's domain can never complete a ceremony: drop it rather than accept it.
    .filter((o) => { const h = new URL(o).hostname.toLowerCase(); return h === rpID || h.endsWith(`.${rpID}`); });
  return origins.length > 0 ? { rpID, origins } : null;
}

/** Config for a request (dev fallback to the request origin outside production). */
export function webauthnConfigFor(req: Request): WebauthnConfig | null {
  let dev: string | null = null;
  try { dev = new URL(req.url).origin; } catch { /* ignore */ }
  return webauthnConfig(process.env, dev);
}

const challengeUser = (purpose: WebauthnPurpose, userId?: string) => (purpose === 'login' ? undefined : userId);

async function remember(purpose: WebauthnPurpose, challenge: string, userId?: string) {
  await createWebauthnChallenge({ purpose, challenge, user_id: challengeUser(purpose, userId) });
}

/** Options to register a passkey for `user`. Existing credentials are excluded so one authenticator is not registered twice. */
export async function beginRegistration(cfg: WebauthnConfig, user: { id: string; email: string }): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await listPasskeys(user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: cfg.rpID, userName: user.email, userDisplayName: user.email,
    userID: new TextEncoder().encode(user.id), attestationType: 'none', timeout: 5 * 60_000,
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  await remember('register', options.challenge, user.id);
  return options;
}

export type RegistrationOutcome =
  | { ok: true; credential_id: string; public_key: Uint8Array; counter: number; transports: string[]; device_type: 'singleDevice' | 'multiDevice'; backed_up: boolean }
  | { ok: false; reason: 'invalid' };

export async function finishRegistration(cfg: WebauthnConfig, userId: string, response: RegistrationResponseJSON): Promise<RegistrationOutcome> {
  try {
    const v = await verifyRegistrationResponse({
      response, expectedOrigin: cfg.origins, expectedRPID: cfg.rpID, requireUserVerification: true, requireUserPresence: true,
      expectedChallenge: (c) => consumeWebauthnChallenge('register', c, { userId }),
    });
    if (!v.verified || !v.registrationInfo.userVerified) return { ok: false, reason: 'invalid' };
    const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
    return {
      ok: true, credential_id: credential.id, public_key: credential.publicKey, counter: credential.counter,
      transports: (credential.transports ?? response.response.transports ?? []) as string[], device_type: credentialDeviceType, backed_up: credentialBackedUp,
    };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * Options for an assertion. `userId` set (step-up): the account's own credentials are allowed and the challenge belongs to it.
 * Without it (login): no allowCredentials, so the browser offers any discoverable passkey for this site and the response says nothing
 * about which accounts exist.
 */
export async function beginAuthentication(cfg: WebauthnConfig, purpose: 'login' | 'reauth', userId?: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const allow = purpose === 'reauth' && userId ? (await listPasskeys(userId)).map((p) => ({ id: p.credential_id, transports: p.transports })) : undefined;
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpID, userVerification: 'required', timeout: 5 * 60_000, ...(allow && allow.length > 0 ? { allowCredentials: allow } : {}),
  });
  await remember(purpose, options.challenge, userId);
  return options;
}

export type AssertionOutcome =
  | { ok: true; passkey: PasskeySummary }
  /** `clone_suspected`: the signature counter did not advance. The credential's account must be locked out of its sessions. */
  | { ok: false; reason: 'invalid' | 'unknown_credential' | 'wrong_user' | 'clone_suspected'; passkey?: PasskeySummary };

/**
 * Verify an assertion for `purpose`. For 'reauth' the credential must belong to `expectUserId`. Returns the matched passkey (without
 * its key) so the caller can load the account. Never throws on bad input.
 */
export async function finishAuthentication(
  cfg: WebauthnConfig, purpose: 'login' | 'reauth', response: AuthenticationResponseJSON, opts: { expectUserId?: string } = {},
): Promise<AssertionOutcome> {
  if (!response || typeof response.id !== 'string') return { ok: false, reason: 'invalid' };
  const stored = await getPasskeyByCredentialId(response.id);
  if (!stored) return { ok: false, reason: 'unknown_credential' };
  const { public_key, counter: _storedCounter, ...passkey } = stored;
  void _storedCounter;
  if (opts.expectUserId && stored.user_id !== opts.expectUserId) return { ok: false, reason: 'wrong_user', passkey };
  // The user handle of a discoverable credential, when present, must be the owner of the credential found by id.
  const handle = response.response?.userHandle;
  if (typeof handle === 'string' && handle && handle !== Buffer.from(stored.user_id).toString('base64url')) return { ok: false, reason: 'invalid', passkey };
  try {
    const v = await verifyAuthenticationResponse({
      response, expectedOrigin: cfg.origins, expectedRPID: cfg.rpID, requireUserVerification: true,
      credential: { id: stored.credential_id, publicKey: public_key as Uint8Array<ArrayBuffer>, counter: 0, transports: stored.transports as never },
      expectedChallenge: (c) => consumeWebauthnChallenge(purpose, c, { userId: purpose === 'login' ? null : opts.expectUserId ?? null }),
    });
    if (!v.verified || !v.authenticationInfo.userVerified) return { ok: false, reason: 'invalid', passkey };
    if (!(await recordPasskeyUse(stored.credential_id, v.authenticationInfo.newCounter))) return { ok: false, reason: 'clone_suspected', passkey };
    return { ok: true, passkey };
  } catch {
    return { ok: false, reason: 'invalid', passkey };
  }
}
