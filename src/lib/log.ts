/**
 * One structured logger for the whole app. No dependencies, works in both the
 * Node and Edge runtimes, and answers "what happened, to which business, and how
 * long did it take?" from `journalctl` without grepping for ad-hoc strings.
 *
 * Output is one line per event so journald, `docker logs` and a pipe to `jq`
 * all behave:
 *
 *   2026-11-15T09:40:12.345Z  info   provision   business.provisioned  business=… ms=5031 phone=+13055557879 agent=agent_94…
 *
 * Levels: LOG_LEVEL=debug|info|warn|error. Default is `debug` in development
 * (this is a demo app — you want the trail) and `info` in production.
 */
import { configEnv, redactSecrets } from '@/lib/config';
export type Level = 'debug' | 'info' | 'warn' | 'error';

export type Fields = Record<string, unknown>;

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Anything whose key matches this is never printed, at any depth. */
const SECRET_KEY = /(api[-_]?key|token|secret|password|authorization|signature|cookie)/i;

/**
 * Value-based scrubbing, on top of the key-name redaction above: personal data and credentials that end up INSIDE a string
 * (an error message that quotes a phone number, a provider body that echoes an email or a token) are masked whatever the field
 * is called. Phone numbers keep their last four digits, emails their first letter and domain. LOG_PII=true turns the
 * phone/email masking off for debugging (credential patterns are always masked).
 */
const PHONE_VALUE = /(\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?(\d{4})\b|\+\d{7,15}\b/g;
const EMAIL_VALUE = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const CREDENTIAL_VALUE = /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\bxi-api-key[:=]\s*\S+|\bAC[0-9a-f]{32}\b/g;

export function scrub(text: string, env: Record<string, string | undefined> = configEnv()): string {
  // Value-based redaction of every configured secret (environment or console-held), then the credential patterns.
  let out = redactSecrets(text).replace(CREDENTIAL_VALUE, '«redacted»');
  if (env.LOG_PII === 'true') return out;
  out = out.replace(EMAIL_VALUE, '$1•••@$2');
  out = out.replace(PHONE_VALUE, (m: string) => {
    const digits = m.replace(/\D/g, '');
    return digits.length < 7 ? m : `${m.startsWith('+') ? '+' : ''}•••${digits.slice(-4)}`;
  });
  return out;
}

const MAX_STRING = 240;
const MAX_DEPTH = 2;
const MAX_ITEMS = 12;

function level(): Level {
  const raw = (configEnv().LOG_LEVEL || '').toLowerCase();
  if (raw in ORDER) return raw as Level;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

function enabled(at: Level): boolean {
  return ORDER[at] >= ORDER[level()];
}

function clip(text: string, max = MAX_STRING): string {
  const flat = scrub(text.replace(/\s+/g, ' ').trim());
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/** Message + first stack frame — enough to locate the throw, cheap to store. */
export function serializeError(err: unknown): Fields {
  if (!isError(err)) return { error: clip(String(err)) };
  const frame = (err.stack ?? '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.startsWith('at '));
  return {
    error: clip(`${err.name}: ${err.message}`),
    ...(frame ? { at: clip(frame.replace(/^at\s+/, ''), 120) } : {}),
  };
}

function format(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return String(value);
  if (isError(value)) return clip(`${value.name}: ${value.message}`);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'string') {
    const flat = clip(value);
    return /[\s"=]/.test(flat) ? JSON.stringify(flat) : flat;
  }
  if (depth >= MAX_DEPTH) return '«nested»';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => format(v, depth + 1));
    return `[${items.join(',')}${value.length > MAX_ITEMS ? ',…' : ''}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Fields).slice(0, MAX_ITEMS);
    const body = entries
      .map(([k, v]) => `${k}=${SECRET_KEY.test(k) ? '«redacted»' : format(v, depth + 1)}`)
      .join(' ');
    return `{${body}}`;
  }
  return String(value);
}

function render(at: Level, scope: string, event: string, fields?: Fields): string {
  const head = `${new Date().toISOString()}  ${at.padEnd(5)}  ${scope.padEnd(12)}  ${event}`;
  if (!fields) return head;
  const pairs = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${SECRET_KEY.test(k) ? '«redacted»' : format(v)}`);
  return pairs.length ? `${head}  ${pairs.join(' ')}` : head;
}

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  /** Same logger with a narrower scope and fields merged into every line. */
  child(scope: string, context?: Fields): Logger;
  /**
   * Runs `fn`, logging `<event>` with `ms` (and `<event>.failed` with the error
   * when it throws — then rethrows, so callers keep their own error policy).
   */
  time<T>(event: string, fn: () => Promise<T>, fields?: Fields): Promise<T>;
}

export function logger(scope: string, context: Fields = {}): Logger {
  const emit = (at: Level, event: string, fields?: Fields) => {
    if (!enabled(at)) return;
    const line = render(at, scope, event, fields ? { ...context, ...fields } : context);
    // One call, one line: journald keeps stdout and stderr separate, and mixing
    // them would reorder warnings behind later info lines.
    if (at === 'error') console.error(line);
    else if (at === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (childScope, childContext = {}) => logger(childScope, { ...context, ...childContext }),
    async time(event, fn, fields) {
      const started = Date.now();
      try {
        const out = await fn();
        emit('debug', event, { ...fields, ms: Date.now() - started });
        return out;
      } catch (err) {
        emit('error', `${event}.failed`, {
          ...fields,
          ms: Date.now() - started,
          ...serializeError(err),
        });
        throw err;
      }
    },
  };
}

/** Scope for a Next.js route handler: `api/businesses/[id]/provision`. */
export function routeLogger(routePath: string): Logger {
  return logger(routePath);
}
