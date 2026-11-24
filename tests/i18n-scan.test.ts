/**
 * Source scan: no hard-coded user-facing English in dashboard / onboarding / auth / public JSX. Text must come from the message catalog
 * (src/lib/i18n). It looks at JSX text nodes and at the string value of user-visible attributes in src/app (pages) and src/components.
 * A new hard-coded string fails this test: add a catalog key (en + es) and use t('...'). Brand names, units and technical tokens go in ALLOWED.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SCAN_DIRS = ['app', 'components'];
/** Attributes whose string value a person reads or a screen reader announces. */
const ATTRS = new Set(['aria-label', 'aria-description', 'title', 'placeholder', 'alt', 'label', 'hint', 'subtitle', 'body', 'srLabel', 'idleLabel']);

/** Strings that are not translatable prose: brand and provider names, units, symbols, sample data, technical tokens. */
/** Files that are deliberately not locale-driven (they render when the provider itself is gone). */
const EXEMPT_FILES = new Set(['app/global-error.tsx']);

const ALLOWED = new Set([
  'Recepcionista', 'AT&T', 'T-Mobile / Metro', 'Verizon', 'ElevenLabs', 'Twilio', 'Stripe', 'LLM', 'Google', 'EN/ES', 'ES', 'EN',
  'Passkeys', '1Password', 'Authy', 'Español', 'English',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'api') continue; // route handlers: their strings are machine error codes, mapped client-side (src/lib/i18n/api-errors.ts)
      walk(p, out);
    } else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Looks like English prose (>= 2 letters in a row, not just punctuation, digits or a single technical token). */
function looksLikeText(s: string): boolean {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t || ALLOWED.has(t)) return false;
  if (!/[A-Za-z]{2}/.test(t)) return false;
  // class names, ids, urls, paths, css values, identifiers
  if (/^[\w./:#?&=%@{}()[\]$-]+$/.test(t) && !/[A-Z][a-z]+ [A-Za-z]/.test(t) && !/\s/.test(t)) return false;
  return true;
}

function scan(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const textOf = (e: ts.Expression): string[] => {
    if (ts.isStringLiteralLike(e)) return [e.text];
    if (ts.isConditionalExpression(e)) return [...textOf(e.whenTrue), ...textOf(e.whenFalse)];
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) return [...textOf(e.left), ...textOf(e.right)];
    if (ts.isParenthesizedExpression(e)) return textOf(e.expression);
    if (ts.isTemplateExpression(e)) return [e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)];
    return [];
  };
  const SINKS = /^(toast(\.\w+)?|setError|setNotice|setMsg|setMessage|setFormError|setUrlError|setNameError|setPhoneError|setCodeError|confirm)$/;
  const visit = (n: ts.Node) => {
    if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      for (const t of textOf(n.expression)) if (looksLikeText(t) && !/^[\s·,.:;|/()[\]–—-]+$/.test(t)) found.push(`${relative(ROOT, file)}:${line(n)} expr ${JSON.stringify(t.trim().slice(0, 60))}`);
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf).replace(/^window\./, '');
      if (SINKS.test(callee)) for (const a of n.arguments.slice(0, 1)) for (const t of textOf(a)) if (looksLikeText(t)) found.push(`${relative(ROOT, file)}:${line(n)} ${callee}() ${JSON.stringify(t.slice(0, 60))}`);
    }
    if (ts.isJsxText(n)) {
      if (looksLikeText(n.getText(sf))) found.push(`${relative(ROOT, file)}:${line(n)} text ${JSON.stringify(n.getText(sf).trim().slice(0, 60))}`);
    } else if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && ATTRS.has(n.name.getText(sf))) {
      if (looksLikeText(n.initializer.text)) found.push(`${relative(ROOT, file)}:${line(n)} ${n.name.getText(sf)}=${JSON.stringify(n.initializer.text.slice(0, 60))}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe('no hard-coded English in UI components', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) => !EXEMPT_FILES.has(relative(ROOT, f)));
  test('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(50);
  });
  test('every user-facing string goes through the message catalog', () => {
    const all = files.flatMap(scan);
    expect(all).toEqual([]);
  });
});
