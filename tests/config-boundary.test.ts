/**
 * CI boundary rule (24e 5.1 / 7 phase 1): NOTHING under src/ reads the process environment except src/lib/config/**, with these explicit,
 * reviewed exceptions:
 *   - `NODE_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE`: framework flags, inlined or set by Next (read as literal property reads);
 *   - `NEXT_PUBLIC_*`: none since Phase 6 (BUILD_TIME_ENV is empty): the Turnstile site key and the price copy are runtime settings;
 *   - boot code that runs before the config module can have loaded anything: the database URL / Prisma flags in src/lib/db/client.ts and
 *     the database target printed by src/instrumentation.ts.
 * Everything else (helper defaults, route handlers, jobs, providers) goes through `configEnv()` / `setting()`, so a console value reaches it.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_TIME_ENV, ENV_ONLY } from '../src/lib/config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js)$/.test(n) ? [p] : [];
  });
}

/** Source without comments (the rule is about code, and docs legitimately mention process.env). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const FRAMEWORK = new Set(['NODE_ENV', 'NEXT_RUNTIME', 'NEXT_PHASE']);
/** file (relative to the repo) -> env-only names it may read directly because it runs before the config can load. */
const BOOT_FILES: Record<string, string[]> = {
  'src/lib/db/client.ts': ['DATABASE_URL', 'PRISMA_LOG', 'PRISMA_QUERY_EVENTS'],
  'src/instrumentation.ts': ['DATABASE_URL'],
};

describe('no direct process.env outside src/lib/config', () => {
  const files = walk(SRC).filter((f) => !relative(SRC, f).startsWith(join('lib', 'config')));
  test('scan covers the whole tree', () => { expect(files.length).toBeGreaterThan(300); });

  test('every read is a framework flag, a build-time NEXT_PUBLIC name, or an allowlisted boot read', () => {
    const offenders: string[] = [];
    const envOnly = new Set(ENV_ONLY.map((e) => e.name));
    const buildTime = new Set<string>(BUILD_TIME_ENV);
    for (const f of files) {
      const rel = relative(ROOT, f);
      const text = code(readFileSync(f, 'utf8'));
      // Any way of reaching the environment other than the named literal property read is out.
      for (const m of text.matchAll(/process\s*(?:\.\s*env\b(?!\s*\.\s*[A-Za-z_])|\[\s*['"`]env['"`]\s*\])|Bun\.env|import\.meta\.env|\bdeno\.env/gi)) {
        offenders.push(`${rel}: bare environment access "${m[0]}"`);
      }
      for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = m[1];
        if (FRAMEWORK.has(name)) continue;
        if (name.startsWith('NEXT_PUBLIC_')) { if (!buildTime.has(name)) offenders.push(`${rel}: ${name} is not in BUILD_TIME_ENV`); continue; }
        if ((BOOT_FILES[rel] ?? []).includes(name)) { if (!envOnly.has(name)) offenders.push(`${rel}: ${name} must be in ENV_ONLY`); continue; }
        offenders.push(`${rel}: process.env.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('NEXT_PUBLIC_APP_URL is never read (retired in Phase 0, D11)', () => {
    for (const f of files) expect(code(readFileSync(f, 'utf8'))).not.toMatch(/process\.env\.NEXT_PUBLIC_APP_URL/);
  });

  test('the config module itself imports nothing node-only and nothing from the app (it ships in the proxy / instrumentation bundles)', () => {
    for (const f of walk(join(SRC, 'lib', 'config'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)) {
        expect(m[1].startsWith('./')).toBe(true);
      }
      expect(readFileSync(f, 'utf8')).not.toMatch(/\brequire\(|node:|from\s+'(fs|path|crypto|os|net)'/);
    }
  });

  test('no module-level const captures the config (call configEnv() / setting() per use)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const [i, line] of code(readFileSync(f, 'utf8')).split('\n').entries()) {
        if (/^(?:export\s+)?(?:const|let)\s+\w+\s*(?::[^=]+)?=\s*(?:configEnv\(\)|runtimeConfig\(\)|setting\()/.test(line)) offenders.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
