/**
 * An LLM is REQUIRED in production (owner decision): website import, call summaries and the briefing writer depend on it, and the
 * template fallbacks are only a degraded, labelled safety net for a provider outage. Pure (reads the given env).
 */
export function llmRequiredProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if (env.NEXT_PHASE === 'phase-production-build') return null; // `next build` has no runtime secrets
  const has = (v?: string) => Boolean(v && v.trim());
  if (has(env.OPENAI_API_KEY) || has(env.ANTHROPIC_API_KEY)) return null;
  return 'No LLM key: set OPENAI_API_KEY or ANTHROPIC_API_KEY. An LLM is required in production (website import, call summaries and briefings); without one the app reports unhealthy.';
}
