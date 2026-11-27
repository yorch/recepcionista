/**
 * Safe markdown for the legal pages (D14). The body of a legal page is editable by an admin, so it is UNTRUSTED: this parser produces a small typed tree and the
 * renderer (src/components/legal/markdown-view.tsx) builds React elements from it. There is no `dangerouslySetInnerHTML` anywhere: raw HTML in the source is
 * just text (React escapes it), images are not supported, and a link survives only when `safeHref` accepts its target (http, https, mailto, a site path
 * or a #fragment; never javascript:, data:, vbscript:, protocol-relative or backslash tricks). Pure: no imports, no I/O, safe on server and client.
 *
 * Supported: # headings (1-6), paragraphs, **bold**, *italic*, `code`, [text](url), <https://autolink>, - / * / + bullets, 1. numbered lists, > quotes, --- rules,
 * fenced code blocks. Nesting depth and input size are capped.
 */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; external: boolean; c: Inline[] };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'pre'; v: string }
  | { t: 'hr' };

export const MAX_MARKDOWN_CHARS = 200_000;
const MAX_INLINE_DEPTH = 4;
const MAX_QUOTE_DEPTH = 4;

/** The href to use for `raw`, or null when it is not safe. Anything with whitespace, control characters or a backslash is refused outright. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!url || url.length > 2000) return null;
  if (/[\u0000-\u001f\u007f-\u009f\s\\\u2028\u2029]/.test(url)) return null;
  if (/&#?[a-z0-9]+;/i.test(url)) return null; // an HTML entity in a target is never legitimate here (and a classic filter bypass)
  if (url.startsWith('#')) return url;
  if (url.startsWith('//')) return null;
  if (url.startsWith('/')) return url;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === 'mailto') return /^mailto:[^\s<>]+$/i.test(url) ? url : null;
    if (s !== 'http' && s !== 'https') return null;
    try {
      const u = new URL(url);
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !u.hostname) return null;
    } catch { return null; }
    return url;
  }
  // relative reference ("privacy", "../terms?x=1"): a colon before the first / ? # would read as a scheme
  const firstSep = url.search(/[/?#]/);
  const colon = url.indexOf(':');
  if (colon !== -1 && (firstSep === -1 || colon < firstSep)) return null;
  return url;
}

const isExternal = (href: string): boolean => /^https?:/i.test(href);
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!<>|~]/;

/**
 * For every `open` character of `src` the index of the `close` that balances it (-1 when none), by ONE stack pass (a backslash escapes the next character). This is what a
 * per-bracket forward scan computes, in O(n) for the whole string instead of O(n) per bracket (`'['.repeat(40000)` was quadratic).
 */
function matchPairs(src: string, open: string, close: string): Int32Array {
  const match = new Int32Array(src.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === open) stack.push(i);
    else if (ch === close && stack.length > 0) match[stack.pop()!] = i;
  }
  return match;
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  let i = 0;
  const n = src.length;
  // Linear time on adversarial input: bracket / parenthesis partners are computed once per call, and an emphasis mark that found no closer once cannot find one later
  // (a later opener has fewer candidate closers), so the failed scan is never repeated.
  let squares: Int32Array | null = null;
  let parens: Int32Array | null = null;
  const noCloser = new Set<string>();
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j > i + 1) { flush(); out.push({ t: 'code', v: src.slice(i + 1, j) }); i = j + 1; continue; }
    }
    if (c === '[' && depth < MAX_INLINE_DEPTH) {
      squares ??= matchPairs(src, '[', ']');
      const close = squares[i];
      if (close !== -1 && src[close + 1] === '(') {
        parens ??= matchPairs(src, '(', ')');
        const end = parens[close + 1];
        if (end !== -1) {
          const target = src.slice(close + 2, end).trim().split(/\s+/)[0] ?? '';
          const label = parseInline(src.slice(i + 1, close), depth + 1);
          const href = safeHref(target);
          flush();
          if (href) out.push({ t: 'link', href, external: isExternal(href), c: label.length ? label : [{ t: 'text', v: href }] });
          else out.push(...label);
          i = end + 1;
          continue;
        }
      }
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i, i + 2100));
      const href = m ? safeHref(m[1]) : null;
      if (m && href) { flush(); out.push({ t: 'link', href, external: isExternal(href), c: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue; }
    }
    if ((c === '*' || c === '_') && depth < MAX_INLINE_DEPTH) {
      const prev = i > 0 ? src[i - 1] : ' ';
      const intraword = c === '_' && /[A-Za-z0-9]/.test(prev);
      const dbl = !intraword && src.startsWith(c + c, i);
      const mark = dbl ? c + c : c;
      if (!intraword && !/\s/.test(src[i + mark.length] ?? ' ') && !noCloser.has(mark)) { // an opener is never followed by whitespace
        let j = src.indexOf(mark, i + mark.length);
        // a closer must not be preceded by whitespace and (for _) not followed by a word character
        while (j !== -1 && (/\s/.test(src[j - 1] ?? ' ') || (c === '_' && /[A-Za-z0-9]/.test(src[j + mark.length] ?? ' ')))) j = src.indexOf(mark, j + 1);
        if (j === -1) noCloser.add(mark);
        if (j > i + mark.length) {
          flush();
          out.push({ t: dbl ? 'strong' : 'em', c: parseInline(src.slice(i + mark.length, j), depth + 1) });
          i = j + mark.length;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** ATX heading by a single forward scan (the regex form, `(.*?)[ \t]*#*[ \t]*$`, backtracks quadratically on a long run of spaces). */
const HEADING = {
  exec(line: string): [string, string, string] | null {
    let i = 0;
    while (i < 3 && line[i] === ' ') i++;
    let h = 0;
    while (line[i + h] === '#') h++;
    if (h < 1 || h > 6 || (line[i + h] !== ' ' && line[i + h] !== '\t')) return null;
    let from = i + h;
    while (line[from] === ' ' || line[from] === '\t') from++;
    let end = line.length;
    while (end > from && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
    while (end > from && line[end - 1] === '#') end--;
    while (end > from && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
    return [line, '#'.repeat(h), line.slice(from, end)];
  },
  test(line: string): boolean { return HEADING.exec(line) !== null; },
};
/** Thematic break: three or more of one of - * _ with only spaces or tabs between (a forward scan, no backtracking). */
const HR = {
  test(line: string): boolean {
    let i = 0;
    while (i < 3 && line[i] === ' ') i++;
    const m = line[i];
    if (m !== '-' && m !== '*' && m !== '_') return false;
    let count = 0;
    for (; i < line.length; i++) {
      if (line[i] === m) count++;
      else if (line[i] !== ' ' && line[i] !== '\t') return false;
    }
    return count >= 3;
  },
};
const BULLET = /^ {0,3}[-*+][ \t]+(.*)$/;
const ORDERED = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;

export function parseMarkdown(source: string, depth = 0): Block[] {
  const src = source.length > MAX_MARKDOWN_CHARS ? source.slice(0, MAX_MARKDOWN_CHARS) : source;
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (l: string): boolean => HEADING.test(l) || HR.test(l) || BULLET.test(l) || ORDERED.test(l) || FENCE.test(l) || QUOTE.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++; // closing fence (or the end of the document)
      blocks.push({ t: 'pre', v: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) { blocks.push({ t: 'h', level: h[1].length as 1, c: parseInline(h[2]) }); i++; continue; }
    if (HR.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({ t: 'quote', c: depth < MAX_QUOTE_DEPTH ? parseMarkdown(inner.join('\n'), depth + 1) : [{ t: 'p', c: [{ t: 'text', v: inner.join(' ') }] }] });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const items: Inline[][] = [];
      const start = ordered ? Number(ordered[1]) : 1;
      const re = bullet ? BULLET : ORDERED;
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (!m) break;
        const parts = [m[bullet ? 1 : 2]];
        i++;
        // continuation lines: indented, not a new block
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) parts.push(lines[i++].trim());
        items.push(parseInline(parts.join(' ')));
      }
      blocks.push(bullet ? { t: 'ul', items } : { t: 'ol', start, items });
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++].trim());
    blocks.push({ t: 'p', c: parseInline(para.join(' ')) });
  }
  return blocks;
}

/** Plain text of a tree (the table of contents, tests, the "first words" of a preview). */
export function inlineText(c: readonly Inline[]): string {
  return c.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : inlineText(x.c))).join('');
}
