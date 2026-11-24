/** Input rules for creating users. Pure (shared by POST /api/admin/users and scripts/create-user.ts). */
export const MIN_PASSWORD_CHARS = 12;
export const MAX_PASSWORD_CHARS = 256;

export function validateEmail(email: unknown): string | null {
  if (typeof email !== 'string') return 'email is required';
  const e = email.trim();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'email is not valid';
  return null;
}

export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== 'string' || !password) return 'password is required';
  if (password.length < MIN_PASSWORD_CHARS) return `password must be at least ${MIN_PASSWORD_CHARS} characters`;
  if (password.length > MAX_PASSWORD_CHARS) return `password must be at most ${MAX_PASSWORD_CHARS} characters`;
  return null;
}

export const MAX_BUSINESS_NAME_CHARS = 120;

/** A small blocklist of the passwords every credential-stuffing list starts with (>= 12 chars, so the length rule alone lets them through). */
const COMMON_PASSWORDS = new Set([
  'password1234', 'password12345', 'passwordpassword', '123456789012', '1234567890123', 'qwertyuiop12', 'qwertyuiopas',
  'iloveyou1234', 'letmein12345', 'welcome12345', 'administrator', 'changeme1234', 'abcdefghijkl', 'recepcionista', 'recepcionista1',
  '111111111111', '000000000000', 'aaaaaaaaaaaa',
]);

/**
 * Strict password rules for self-service (signup, reset, accept-invite): the length rules, plus no
 * single repeated character, no well-known password, and not the email address or its local part.
 */
export function validateStrongPassword(password: unknown, email?: string | null): string | null {
  const bad = validateNewPassword(password);
  if (bad) return bad;
  const pw = password as string;
  if (/^([\s\S])\1+$/.test(pw)) return 'password is too easy to guess';
  const lower = pw.toLowerCase().replace(/\s+/g, '');
  if (COMMON_PASSWORDS.has(lower)) return 'password is too easy to guess';
  if (email) {
    const e = email.trim().toLowerCase();
    const local = e.split('@')[0] ?? '';
    if (lower === e || (local.length >= 6 && lower === local)) return 'password must not be your email address';
  }
  return null;
}

/** Business name for self-signup: trimmed, 2-120 chars, no control characters or angle brackets. Returns the clean name or an error. */
export function validateBusinessName(name: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof name !== 'string') return { ok: false, error: 'business name is required' };
  const v = name.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (v.length < 2) return { ok: false, error: 'business name is required' };
  if (v.length > MAX_BUSINESS_NAME_CHARS) return { ok: false, error: `business name must be at most ${MAX_BUSINESS_NAME_CHARS} characters` };
  if (/[\u0000-\u001f\u007f<>]/.test(v)) return { ok: false, error: 'business name contains characters that are not allowed' };
  return { ok: true, value: v };
}

/** Strict shape check for an email typed by a stranger: no whitespace/quotes/commas, one @, a dotted domain, no dot edges. */
export function validatePublicEmail(email: unknown): string | null {
  const bad = validateEmail(email);
  if (bad) return bad;
  const e = (email as string).trim();
  const [local, domain, ...rest] = e.split('@');
  if (rest.length || !local || !domain) return 'email is not valid';
  if (local.length > 64 || /[<>()[\]\\,;:"']/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return 'email is not valid';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain) || domain.length > 253) return 'email is not valid';
  return null;
}
