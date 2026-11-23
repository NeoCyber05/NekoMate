import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const SESSION_COOKIE_NAME = 'nekomate_session';
export const SESSION_TTL_SEC = 24 * 3600;
const RATE_LIMIT_MAX_FAILURES = 5;
const RATE_LIMIT_WINDOW_SEC = 60;

export interface SessionRecord {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !password) {
    return false;
  }
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const salt = parts[1];
  const expectedHex = parts[2];
  if (!salt || !expectedHex || expectedHex.length % 2 !== 0) {
    return false;
  }
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = crypto.scryptSync(password, salt, expectedBuf.length);
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

export class LoginRateLimiter {
  private readonly failuresByIp = new Map<string, number[]>();

  private prune(ip: string, nowSec: number): number[] {
    const cutoff = nowSec - RATE_LIMIT_WINDOW_SEC;
    const list = (this.failuresByIp.get(ip) ?? []).filter((ts) => ts > cutoff);
    if (list.length === 0) {
      this.failuresByIp.delete(ip);
    } else {
      this.failuresByIp.set(ip, list);
    }
    return list;
  }

  isBlocked(ip: string, nowSec: number): boolean {
    return this.prune(ip, nowSec).length >= RATE_LIMIT_MAX_FAILURES;
  }

  recordFailure(ip: string, nowSec: number): void {
    const list = this.prune(ip, nowSec);
    list.push(nowSec);
    this.failuresByIp.set(ip, list);
  }

  reset(ip: string): void {
    this.failuresByIp.delete(ip);
  }
}

export function createSession(
  db: DatabaseSync,
  nowSec: number,
): { token: string; tokenHash: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  const expiresAt = nowSec + SESSION_TTL_SEC;
  db.prepare(
    'INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
  ).run(tokenHash, nowSec, expiresAt);
  return { token, tokenHash, expiresAt };
}

export function validateSession(
  db: DatabaseSync,
  token: string,
  nowSec: number,
): SessionRecord | null {
  if (!token) {
    return null;
  }
  const tokenHash = sha256Hex(token);
  const row = db
    .prepare(
      'SELECT token_hash, created_at, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?',
    )
    .get(tokenHash, nowSec) as
    | { token_hash: string; created_at: number; expires_at: number }
    | undefined;
  if (!row) {
    return null;
  }
  return {
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function revokeSession(db: DatabaseSync, token: string): void {
  if (!token) {
    return;
  }
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
}

export function extractSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const name = part.slice(0, eqIdx).trim();
    if (name === SESSION_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eqIdx + 1).trim());
    }
  }
  return null;
}

export function isAllowedOrigin(
  originHeader: string | undefined,
  appBaseUrl: string,
): boolean {
  if (!originHeader) {
    return false;
  }
  try {
    const expectedOrigin = new URL(appBaseUrl).origin;
    return originHeader === expectedOrigin;
  } catch {
    return false;
  }
}

export function serializeSessionCookie(
  token: string,
  appBaseUrl: string,
  maxAgeSec: number,
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  try {
    if (new URL(appBaseUrl).protocol === 'https:') {
      parts.push('Secure');
    }
  } catch {
    // Keep non-Secure if URL invalid
  }
  return parts.join('; ');
}
