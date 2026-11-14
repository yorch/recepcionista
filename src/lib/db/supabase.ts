/**
 * Supabase is optional in the MVP. The local JSON store (./index.ts) is the
 * default and the demo source of truth. This file is a stub that documents the
 * swap point so nothing in the app depends on Supabase being configured.
 */
export const supabaseConfigured = () =>
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
