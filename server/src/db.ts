import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS alarm_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pending_config_id TEXT NOT NULL,
      pending_revision INTEGER NOT NULL,
      pending_hour INTEGER NOT NULL,
      pending_minute INTEGER NOT NULL,
      pending_days_json TEXT NOT NULL,
      pending_enabled INTEGER NOT NULL,
      confirmed_config_id TEXT,
      confirmed_revision INTEGER,
      confirmed_hour INTEGER,
      confirmed_minute INTEGER,
      confirmed_days_json TEXT,
      confirmed_enabled INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_state (
      device_id TEXT PRIMARY KEY,
      online INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sources (
      source_id TEXT PRIMARY KEY,
      connected_account_id TEXT,
      scope_id TEXT,
      scope_label TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      last_sync_at INTEGER,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_items (
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      date_only TEXT,
      notify_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS notification_queue (
      notification_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT,
      external_id TEXT,
      title TEXT NOT NULL,
      notify_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at INTEGER,
      shown_at INTEGER,
      dismissed_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notification_queue_status_due
      ON notification_queue (status, notify_at, expires_at);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_attempts (
      nonce_hash TEXT PRIMARY KEY,
      session_token_hash TEXT NOT NULL,
      source_id TEXT NOT NULL,
      toolkit TEXT NOT NULL,
      connection_request_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
  `);

  return db;
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback error if transaction already closed
    }
    throw err;
  }
}
