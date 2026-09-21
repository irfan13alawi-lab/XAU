import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import { appendAudit } from './database.mjs';
import { config } from './config.mjs';

function uniqueSqlitePath(directory, prefix, now) {
  mkdirSync(directory, { recursive: true });
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '');
  const path = resolve(directory, `${prefix}-${stamp}-${randomUUID()}.sqlite`);
  if (existsSync(path)) throw new Error('Refusing to overwrite an existing database file.');
  return path;
}

export function validateDatabaseFile(path) {
  const target = resolve(path);
  if (!existsSync(target)) throw new Error('Database file does not exist.');
  const db = new DatabaseSync(target);
  try {
    const integrity = db.prepare('PRAGMA quick_check').all();
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') throw new Error('SQLite quick_check failed.');
    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length) throw new Error('SQLite foreign_key_check failed.');
    const migrationTable = db.prepare(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
    `).get();
    if (!migrationTable) throw new Error('Database is missing its schema migration history.');
    const migrations = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count;
    if (migrations < 1) throw new Error('Database has no applied schema migrations.');
    return { integrity: 'ok', foreignKeyErrors: 0, appliedMigrations: migrations };
  } finally {
    db.close();
  }
}

export async function createDatabaseBackup({
  sourcePath = config.dbPath,
  outputDirectory = resolve('backups'),
  now = new Date(),
} = {}) {
  const source = resolve(sourcePath);
  if (source === resolve(outputDirectory)) throw new Error('Backup destination must be a directory, not the source database.');
  if (!existsSync(source)) throw new Error('Source database does not exist; start the service before requesting a backup.');
  const destination = uniqueSqlitePath(outputDirectory, 'nexora-backup', now);
  const db = new DatabaseSync(source);
  let pages;
  try {
    appendAudit(db, {
      eventType: 'DATABASE_BACKUP_REQUESTED',
      reason: 'A local consistent SQLite backup was requested.',
      metadata: { destinationName: basename(destination) },
    }, now.toISOString());
    pages = await backup(db, destination);
  } finally {
    db.close();
  }
  const validation = validateDatabaseFile(destination);
  const auditDb = new DatabaseSync(source);
  try {
    appendAudit(auditDb, {
      eventType: 'DATABASE_BACKUP_COMPLETED',
      reason: 'Backup completed and passed SQLite integrity checks.',
      metadata: { destinationName: basename(destination), pages, validation },
    }, new Date().toISOString());
  } finally {
    auditDb.close();
  }
  return { path: destination, pages, validation };
}

export async function restoreDatabaseCopy({
  backupPath,
  outputDirectory = resolve('data', 'restore-candidates'),
  now = new Date(),
} = {}) {
  if (typeof backupPath !== 'string' || !backupPath.trim()) throw new TypeError('A backup file path is required.');
  const source = resolve(backupPath);
  const sourceValidation = validateDatabaseFile(source);
  const destination = uniqueSqlitePath(outputDirectory, 'nexora-restore-candidate', now);
  const db = new DatabaseSync(source);
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
  const validation = validateDatabaseFile(destination);
  return { path: destination, sourceValidation, validation };
}

async function main(args) {
  const [operation, sourcePath] = args;
  if (operation === 'backup' && !sourcePath) {
    const result = await createDatabaseBackup();
    console.log(JSON.stringify({ operation, ...result }));
    return;
  }
  if (operation === 'restore' && sourcePath) {
    const result = await restoreDatabaseCopy({ backupPath: sourcePath });
    console.log(JSON.stringify({ operation, ...result }));
    return;
  }
  throw new Error('Usage: node src/maintenance.mjs backup | node src/maintenance.mjs restore <backup-file>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
