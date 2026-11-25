/**
 * The receptionist's spoken name (businesses.assistant_name, 1..40 chars; NULL = the platform default). Used in the agent's prompt,
 * first message, greeting scripts, the owner-line prompt and customer-facing templates instead of a hard-coded name.
 * Pure. The value is owner-typed text that ends up inside a prompt, so it is normalised (no control characters, no line breaks,
 * no quotes/braces that could break the template or smuggle an instruction) before use.
 */
export const DEFAULT_ASSISTANT_NAME = 'Maria';

export function cleanAssistantName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.replace(/[\u0000-\u001f\u007f<>{}"`\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return v.length > 0 ? v : null;
}

export function assistantNameOf(business: { assistant_name?: string | null } | null | undefined): string {
  return cleanAssistantName(business?.assistant_name) ?? DEFAULT_ASSISTANT_NAME;
}
