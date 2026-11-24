/** One catalog area: both languages side by side. The generic ties the key sets together at compile time. */
export function defineArea<const K extends string>(area: { en: Record<K, string>; es: Record<K, string> }): { en: Record<K, string>; es: Record<K, string> } {
  return area;
}
