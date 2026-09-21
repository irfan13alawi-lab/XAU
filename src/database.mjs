import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function migrateDatabase(db, migrationsDirectory) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const names = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();

  for (const name of names) {
    const sql = readFileSync(join(migrationsDirectory, name), 'utf8');
    const version = name.slice(0, 4);
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(version);
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(`Applied migration ${version} checksum changed; add a new migration instead.`);
      }
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
        .run(version, checksum, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  db.exec('PRAGMA optimize');
}

export function openDatabase(path, migrationsDirectory) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    migrateDatabase(db, migrationsDirectory);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function readState(db, key, fallback = null) {
  const row = db.prepare('SELECT value_json FROM app_state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

export function writeState(db, key, value, now = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO app_state (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now);
}

export function appendAudit(db, event, now = new Date().toISOString()) {
  const id = event.id ?? randomUUID();
  db.prepare(`
    INSERT INTO audit_events
      (id, actor, event_type, correlation_id, entity_type, entity_id, reason, config_version, created_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    event.actor ?? 'local-service',
    event.eventType,
    event.correlationId ?? randomUUID(),
    event.entityType ?? null,
    event.entityId ?? null,
    event.reason ?? '',
    event.configVersion ?? 'mtf-paper-v1',
    now,
    JSON.stringify(event.metadata ?? {}),
  );
  return id;
}

export function runIdempotent(db, scope, key, now, operation) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw new TypeError('A valid Idempotency-Key header is required.');
  }
  const existing = db.prepare(`
    SELECT response_status, response_json FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?
  `).get(scope, key);
  if (existing) return { status: existing.response_status, body: JSON.parse(existing.response_json), replayed: true };

  db.exec('BEGIN IMMEDIATE');
  try {
    const raced = db.prepare(`
      SELECT response_status, response_json FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?
    `).get(scope, key);
    if (raced) {
      db.exec('COMMIT');
      return { status: raced.response_status, body: JSON.parse(raced.response_json), replayed: true };
    }
    const result = operation();
    db.prepare(`
      INSERT INTO idempotency_keys (scope, idempotency_key, response_status, response_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(scope, key, result.status, JSON.stringify(result.body), now);
    db.exec('COMMIT');
    return { ...result, replayed: false };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
