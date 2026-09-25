import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, migrateDatabase } from '../src/database.mjs';
import { test } from 'node:test';

const migrationsDirectory = fileURLToPath(new URL('../src/migrations/', import.meta.url));

test('schema v5 database upgrades additively to v11 with audit, notification outbox, worker telemetry, equity snapshots, trade integrity, and loss quarantine intact', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'nexora-migration-v5-v6-'));
  const legacyDirectory = join(temporaryDirectory, 'migrations-v5');
  const databasePath = join(temporaryDirectory, 'candidate.sqlite');
  mkdirSync(legacyDirectory);
  let db;
  try {
    for (const name of readdirSync(migrationsDirectory).filter((file) => /^000[1-5]_.*\.sql$/.test(file))) {
      writeFileSync(join(legacyDirectory, name), readFileSync(join(migrationsDirectory, name)));
    }

    db = openDatabase(databasePath, legacyDirectory);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 5);
    db.prepare(`INSERT INTO audit_events (
      id, actor, event_type, correlation_id, reason, config_version, created_at, metadata_json
    ) VALUES ('migration-test-audit', 'test', 'TEST_EVENT', 'migration-test-correlation', 'preserved', 'v5', ?, '{}')`)
      .run('2026-09-21T00:00:00.000Z');

    migrateDatabase(db, migrationsDirectory);

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 11);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_notification_outbox'").get().name,
      'telegram_notification_outbox');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_cycle_metrics'").get().name,
      'worker_cycle_metrics');
    assert.equal(db.prepare("SELECT name FROM pragma_table_info('trades') WHERE name = 'accounting_status'").get().name,
      'accounting_status');
    assert.equal(db.prepare("SELECT name FROM pragma_table_info('equity_snapshots') WHERE name = 'accounting_status'").get().name,
      'accounting_status');
    assert.equal(db.prepare("SELECT reason FROM audit_events WHERE id = 'migration-test-audit'").get().reason, 'preserved');
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
