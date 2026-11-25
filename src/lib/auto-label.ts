/**
 * Honest labelling of text the platform wrote WITHOUT an AI writer (no LLM key, a provider failure). The marker travels with the stored text
 * (call summaries have no spare column), the UI strips it and shows "Auto excerpt", and everything else that prints a summary (SMS alerts,
 * exports) shows the marker as is. Pure; safe in the browser.
 */
export const AUTO_MARK = '[auto] ';

export function markAuto(text: string): string {
  return text.startsWith(AUTO_MARK) ? text : `${AUTO_MARK}${text}`;
}

export function splitAuto(text: string | null | undefined): { auto: boolean; text: string } {
  const s = text ?? '';
  return s.startsWith(AUTO_MARK) ? { auto: true, text: s.slice(AUTO_MARK.length) } : { auto: false, text: s };
}
