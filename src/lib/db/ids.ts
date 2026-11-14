import crypto from 'node:crypto';

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
