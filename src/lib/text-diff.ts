/**
 * Line diff (pure, no dependencies) for the legal page versions and the settings history. Common prefix and suffix are trimmed first; the middle is
 * an LCS table, capped so a pathological pair of 200 000 character documents cannot allocate gigabytes (beyond the cap the middle is shown as one
 * removed block followed by one added block, which is still correct, only less fine grained).
 */
export type DiffOp = { type: 'same' | 'add' | 'del'; text: string };

const MAX_CELLS = 4_000_000;

export function diffLines(a: string, b: string): DiffOp[] {
  const x = a === '' ? [] : a.split('\n');
  const y = b === '' ? [] : b.split('\n');
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX--; endY--; }
  const out: DiffOp[] = x.slice(0, start).map((text) => ({ type: 'same', text }));
  const mx = x.slice(start, endX);
  const my = y.slice(start, endY);
  if (mx.length * my.length > MAX_CELLS) {
    for (const text of mx) out.push({ type: 'del', text });
    for (const text of my) out.push({ type: 'add', text });
  } else {
    const n = mx.length;
    const m = my.length;
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = mx[i] === my[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (mx[i] === my[j]) { out.push({ type: 'same', text: mx[i] }); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) out.push({ type: 'del', text: mx[i++] });
      else out.push({ type: 'add', text: my[j++] });
    }
    while (i < n) out.push({ type: 'del', text: mx[i++] });
    while (j < m) out.push({ type: 'add', text: my[j++] });
  }
  for (const text of x.slice(endX)) out.push({ type: 'same', text });
  return out;
}

export const diffStats = (ops: readonly DiffOp[]): { added: number; removed: number } => ({ added: ops.filter((o) => o.type === 'add').length, removed: ops.filter((o) => o.type === 'del').length });
