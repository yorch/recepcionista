/**
 * Post-call recorder infrastructure.
 *
 * ElevenLabs delivers call artifacts (transcript, recording URL, etc.)
 * via a workspace-level webhook that is attached to an agent through
 * platform_settings.overrides.webhooks.
 *
 * The API key needs `webhooks_write` to create the workspace webhook.
 * Without it everything degrades to mock mode and calls are still answered,
 * but post-call data has to be captured another way.
 */

import { appUrl } from '@/lib/providers/stripe';

const API = 'https://api.elevenlabs.io/v1';

function apiKey(): string {
  return process.env.ELEVENLABS_API_KEY as string;
}

function headers(): Record<string, string> {
  return { 'content-type': 'application/json', 'xi-api-key': apiKey() };
}

function hasKey(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

function postCallWebhookUrl(): string {
  return `${appUrl()}/api/voice/post-call`;
}

interface WebhookItem {
  webhook_id?: string;
  webhook_url?: string;
  settings?: { webhook_url?: string };
}

/**
 * Ensure a workspace-level post-call webhook exists for this app.
 * Returns mock=true when the key lacks `webhooks_write`.
 */
export async function ensurePostCallWebhook(): Promise<{
  webhook_id: string | null;
  mock: boolean;
  error?: string;
}> {
  if (!hasKey()) {
    return { webhook_id: null, mock: true, error: 'no API key' };
  }

  const expectedUrl = postCallWebhookUrl();

  try {
    // 1. List existing webhooks
    const listRes = await fetch(`${API}/workspace/webhooks`, {
      headers: { 'xi-api-key': apiKey() },
      signal: AbortSignal.timeout(10_000),
    });
    if (listRes.ok) {
      const json = (await listRes.json()) as { webhooks?: WebhookItem[] };
      const hit = (json.webhooks ?? []).find(
        (w) =>
          (w.webhook_url && w.webhook_url === expectedUrl) ||
          (w.settings?.webhook_url && w.settings.webhook_url === expectedUrl),
      );
      if (hit?.webhook_id) {
        return { webhook_id: hit.webhook_id, mock: false };
      }
    }

    // 2. Create a new one
    const createRes = await fetch(`${API}/workspace/webhooks`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        settings: {
          auth_type: 'hmac',
          name: 'Recepcionista Post-Call',
          webhook_url: expectedUrl,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!createRes.ok) {
      const detail = await createRes.text().catch(() => '');
      console.warn(
        `[postcall] create webhook -> ${createRes.status} ${detail.slice(0, 200)}`,
      );
      return {
        webhook_id: null,
        mock: true,
        error: `create ${createRes.status}: ${detail.slice(0, 160)}`,
      };
    }
    const json = (await createRes.json()) as { webhook_id?: string };
    return { webhook_id: json.webhook_id ?? null, mock: !json.webhook_id };
  } catch (err) {
    const msg = (err as Error).message;
    console.warn('[postcall] ensurePostCallWebhook error:', msg);
    return { webhook_id: null, mock: true, error: msg };
  }
}

/**
 * Register the webhook on an agent so calls to that agent get recorded.
 *
 * Uses platform_settings.overrides.webhooks — the agent-level `post_call`
 * field returns 200 but silently ignores the value.
 */
export async function registerPostCallWebhookOnAgent(
  agentId: string,
  webhookId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasKey() || !agentId) {
    return { ok: false, error: 'missing API key or agent id' };
  }
  try {
    const res = await fetch(`${API}/convai/agents/${agentId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        platform_settings: {
          overrides: {
            webhooks: {
              post_call_webhook_id: webhookId,
              events: ['transcript'],
            },
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(
        `[postcall] register on agent ${agentId} -> ${res.status} ${detail.slice(0, 200)}`,
      );
      return { ok: false, error: `PATCH ${res.status}: ${detail.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message;
    console.warn('[postcall] registerPostCallWebhookOnAgent error:', msg);
    return { ok: false, error: msg };
  }
}
