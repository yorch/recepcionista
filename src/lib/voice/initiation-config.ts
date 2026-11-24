/**
 * Agent-level platform settings that let the conversation-initiation webhook (/api/voice/initiation) run and override
 * the first message. Shared by every PATCH that writes `platform_settings.overrides`, so one write cannot silently
 * undo the other if the platform replaces (rather than merges) that object.
 * UNVERIFIED field names (see the note in elevenlabs.ts); docs/runbook.md has the manual UI equivalent.
 */
export const initiationAutoConfig = (): boolean => (process.env.ELEVENLABS_INITIATION_WEBHOOK || 'auto').toLowerCase() !== 'off';

export function initiationAgentOverrides(): Record<string, unknown> {
  return initiationAutoConfig()
    ? {
      enable_conversation_initiation_client_data_from_webhook: true,
      // `conversation.max_duration_seconds` lets an out-of-service call be cut short (voice/capacity.ts) instead of running the full 15 minutes.
      conversation_config_override: {
        agent: { first_message: true, ...(process.env.ELEVENLABS_PAUSED_PROMPT_OVERRIDE === 'true' ? { prompt: { prompt: true } } : {}) },
        conversation: { max_duration_seconds: true },
      },
    }
    : {};
}
