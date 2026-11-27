/**
 * Provisioning stores the ElevenLabs post-call webhook secret straight into the encrypted console store (critical tier, audited, every admin mailed) instead of
 * showing it once (24e 5.6). When the console store cannot take it (no console role for this principal, the key is pinned by the environment, the console is frozen, no
 * master key, a database error) the caller keeps the old behaviour: the one-time display. Node runtime only. Never logs the secret.
 */
import { pinnedByEnv } from '@/lib/config';
import { logger } from '@/lib/log';
import { actorFromPrincipal, setSecret } from './settings-store';
import type { AdminLike } from './permissions';

const log = logger('admin/provider-provision');
export const WEBHOOK_SECRET_KEY = 'elevenlabs.webhook_secret';

export async function storeProvisionedWebhookSecret(principal: AdminLike & { user?: { id: string; platform_role?: string | null } | null }, secret: string, ip?: string | null): Promise<boolean> {
  try {
    if (!secret || pinnedByEnv('ELEVENLABS_WEBHOOK_SECRET')) return false;
    await setSecret({
      key: WEBHOOK_SECRET_KEY, value: secret, reason: 'ElevenLabs post-call webhook created while provisioning an agent', confirm: WEBHOOK_SECRET_KEY,
      actor: { ...actorFromPrincipal(principal, ip), via: 'api' },
    });
    return true;
  } catch (err) {
    log.warn('webhook_secret.not_stored', { error: (err as Error).name, code: (err as { code?: string }).code ?? null });
    return false;
  }
}
