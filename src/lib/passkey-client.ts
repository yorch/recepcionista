'use client';
/** Browser side of the passkey ceremonies (talks to /api/auth/passkeys/**). Only import from client components. */
import { useSyncExternalStore } from 'react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { apiRequest } from '@/hooks/use-api';

export { browserSupportsWebAuthn };

const noSubscribe = () => () => undefined;

/** Does this browser have WebAuthn? `null` while rendering on the server / hydrating (render nothing passkey-specific then). */
export function useWebAuthnSupport(): boolean | null {
  return useSyncExternalStore(noSubscribe, () => browserSupportsWebAuthn(), () => null);
}

/** A person-readable message for a failed or cancelled browser ceremony (the browser's own errors are cryptic). */
export function passkeyErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  const code = (err as { code?: string } | null)?.code;
  if (name === 'NotAllowedError' || name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED') return 'The passkey prompt was closed or timed out. Try again.';
  if (name === 'InvalidStateError' || code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'This device already has a passkey for your account.';
  if (name === 'SecurityError') return 'Passkeys cannot be used on this address.';
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong with the passkey. Try again.';
}

/** Step-up with a passkey: stamps the session as freshly re-authenticated (valid for 5 minutes). Throws ApiError / browser errors. */
export async function reauthWithPasskey(): Promise<void> {
  const { options } = await apiRequest<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/passkeys/reauth/options', { method: 'POST', body: {} });
  const response = await startAuthentication({ optionsJSON: options });
  await apiRequest('/api/auth/passkeys/reauth/verify', { method: 'POST', body: { response } });
}

/** Register a new passkey for the signed-in account. Throws ApiError (e.g. 403 reauth_required) / browser errors. */
export async function registerPasskey(name: string): Promise<{ id: string; name: string }> {
  const { options } = await apiRequest<{ options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/passkeys/register/options', { method: 'POST', body: {} });
  const response = await startRegistration({ optionsJSON: options });
  const { passkey } = await apiRequest<{ passkey: { id: string; name: string } }>('/api/auth/passkeys/register/verify', { method: 'POST', body: { response, name } });
  return passkey;
}
