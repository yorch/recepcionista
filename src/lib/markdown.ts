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

function findClose(s: string, from: number, open: string, close: string): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i;
  }
  return -1;
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j > i + 1) { flush(); out.push({ t: 'code', v: src.slice(i + 1, j) }); i = j + 1; continue; }
    }
    if (c === '[' && depth < MAX_INLINE_DEPTH) {
      const close = findClose(src, i + 1, '[', ']');
      if (close !== -1 && src[close + 1] === '(') {
        const end = findClose(src, close + 2, '(', ')');
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
      if (!intraword) {
        const dbl = src.startsWith(c + c, i);
        const mark = dbl ? c + c : c;
        let j = src.indexOf(mark, i + mark.length);
        // a closer must not be preceded by whitespace and (for _) not followed by a word character
        while (j !== -1 && (/\s/.test(src[j - 1] ?? ' ') || (c === '_' && /[A-Za-z0-9]/.test(src[j + mark.length] ?? ' ')))) j = src.indexOf(mark, j + 1);
        if (j > i + mark.length && !/\s/.test(src[i + mark.length] ?? ' ')) {
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

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
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
