/**
 * Local JSON store. Survives dev-server restarts, zero setup, and is the
 * default backend. If SUPABASE_SERVICE_ROLE_KEY is set, ./supabase.ts takes over
 * (same function signatures) — callers import from '@/lib/db' only.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  Business, KnowledgeBase, Call, Booking, Briefing, SmsLog, ID,
} from '@/lib/types';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'db.json');

export interface DbShape {
  businesses: Business[];
  knowledge_bases: KnowledgeBase[];
  calls: Call[];
  bookings: Booking[];
  briefings: Briefing[];
  sms_log: SmsLog[];
}

const EMPTY: DbShape = {
  businesses: [], knowledge_bases: [], calls: [],
  bookings: [], briefings: [], sms_log: [],
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readDb(): DbShape {
  ensureDir();
  if (!fs.existsSync(FILE)) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function writeDb(db: DbShape): void {
  ensureDir();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

export function mutate<T>(fn: (db: DbShape) => T): T {
  const db = readDb();
  const out = fn(db);
  writeDb(db);
  return out;
}

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
