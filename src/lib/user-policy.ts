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
