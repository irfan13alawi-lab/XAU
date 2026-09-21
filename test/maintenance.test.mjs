import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase, readState, writeState } from '../src/database.mjs';
import { createDatabaseBackup, restoreDatabaseCopy } from '../src/maintenance.mjs';
import { initializeDatabase } from '../src/server.mjs';

test('backup and restore create validated copies without replacing the source database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nexora-backup-'));
  const sourcePath = join(directory, 'source.sqlite');
  const migrations = fileURLToPath(new URL('../src/migrations/', import.meta.url));
  const now = new Date('2026-09-21T01:00:00.000Z');

  let activeDb;
  try {
    activeDb = openDatabase(sourcePath, migrations);
    initializeDatabase(activeDb, now);
    writeState(activeDb, 'entryPaused', false, now.toISOString());

    const created = await createDatabaseBackup({
      sourcePath,
      outputDirectory: join(directory, 'backups'),
      now,
    });
    assert.equal(created.validation.integrity, 'ok');
    assert.notEqual(created.path, sourcePath);
    activeDb.close();
    activeDb = null;

    const restored = await restoreDatabaseCopy({
      backupPath: created.path,
      outputDirectory: join(directory, 'restored'),
      now,
    });
    assert.equal(restored.validation.integrity, 'ok');
    assert.notEqual(restored.path, sourcePath);

    const recovered = openDatabase(restored.path, migrations);
    assert.equal(readState(recovered, 'entryPaused'), false);
    recovered.close();

    const original = openDatabase(sourcePath, migrations);
    assert.equal(readState(original, 'entryPaused'), false);
    original.close();
  } finally {
    activeDb?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
