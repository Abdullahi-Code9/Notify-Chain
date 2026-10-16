import * as sqlite3 from 'sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MigrationRunner } from '../database/migration-system';
import migration from './005-notification-expiration';

function openDatabase(): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (error) => {
      if (error) reject(error);
      else resolve(db);
    });
  });
}

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

function exec(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => (error ? reject(error) : resolve()));
  });
}

function all<T>(db: sqlite3.Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (error, rows) => (error ? reject(error) : resolve(rows as T[])));
  });
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createLegacySchema(db: sqlite3.Database): Promise<void> {
  await exec(
    db,
    `
      CREATE TABLE scheduled_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, payload_hash TEXT,
        notification_type VARCHAR(50) NOT NULL, target_recipient TEXT NOT NULL,
        execute_at DATETIME NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        retry_count INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3,
        processing_started_at DATETIME, processing_completed_at DATETIME, processor_id VARCHAR(100),
        lock_expires_at DATETIME, last_error TEXT, error_details TEXT, event_id TEXT,
        contract_address TEXT, priority INTEGER NOT NULL DEFAULT 5, metadata TEXT, next_retry_at DATETIME,
        deduplication_key TEXT
      );
      CREATE TABLE notification_execution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scheduled_notification_id INTEGER NOT NULL,
        execution_attempt INTEGER NOT NULL, execution_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(20) NOT NULL, error_message TEXT, response_data TEXT, duration_ms INTEGER,
        FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
      );
      CREATE TABLE dead_letter_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scheduled_notification_id INTEGER NOT NULL UNIQUE,
        notification_type VARCHAR(50) NOT NULL, target_recipient TEXT NOT NULL, payload TEXT NOT NULL,
        failure_reason TEXT NOT NULL, error_details TEXT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_retried_at DATETIME, retry_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
      );
      CREATE TABLE idempotency_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        response_notification_id INTEGER NOT NULL, response_data TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED',
        FOREIGN KEY (response_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
      );
      CREATE TABLE notification_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT, original_id INTEGER NOT NULL, payload TEXT NOT NULL,
        notification_type VARCHAR(50) NOT NULL, target_recipient TEXT NOT NULL,
        execute_at DATETIME NOT NULL, created_at DATETIME NOT NULL, processing_completed_at DATETIME,
        status VARCHAR(20) NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        event_id TEXT, contract_address TEXT, metadata TEXT,
        archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  );
}

async function seedValidRows(db: sqlite3.Database): Promise<void> {
  await run(
    db,
    `INSERT INTO scheduled_notifications
      (id, payload, payload_hash, notification_type, target_recipient, execute_at, created_at,
       updated_at, status, retry_count, max_retries, processing_started_at, processing_completed_at,
       processor_id, lock_expires_at, last_error, error_details, event_id, contract_address, priority,
       metadata, next_retry_at, deduplication_key)
     VALUES (1, '{"n":1}', 'hash', 'discord', 'user-1', '2026-01-01', 'created', 'updated',
       'FAILED', 1, 3, NULL, 'completed', 'worker-1', NULL, 'error', NULL, 'event-1', 'contract-1',
       5, '{"meta":true}', NULL, 'dedupe-key-1')`,
  );
  await run(
    db,
    `INSERT INTO notification_execution_log VALUES
      (1, 1, 1, 'attempt-time', 'FAILED', 'failed', NULL, 3)`,
  );
  await run(
    db,
    `INSERT INTO dead_letter_queue VALUES
      (1, 1, 'discord', 'user-1', '{"n":1}', 'failed', NULL, 'dlq-time', NULL, 1)`,
  );
  await run(
    db,
    `INSERT INTO idempotency_keys VALUES
      (1, 'key-1', 'hash-1', 1, '{"id":1}', 'key-time', 'expiry-time', 'EXPIRED')`,
  );
  await run(
    db,
    `INSERT INTO notification_archive VALUES
      (1, 1, '{"n":1}', 'discord', 'user-1', 'execute-time', 'created', 'completed',
       'COMPLETED', 1, 'done', 'event-1', 'contract-1', '{}', 'archive-time')`,
  );
}

const preservedRows = async (db: sqlite3.Database) => ({
  scheduled_notifications: await all(
    db,
    `SELECT id, payload, payload_hash, notification_type, target_recipient, execute_at, created_at,
      updated_at, status, retry_count, max_retries, processing_started_at, processing_completed_at,
      processor_id, lock_expires_at, last_error, error_details, event_id, contract_address, priority,
      metadata, next_retry_at, deduplication_key FROM scheduled_notifications ORDER BY id`,
  ),
  notification_execution_log: await all(db, 'SELECT * FROM notification_execution_log ORDER BY id'),
  dead_letter_queue: await all(db, 'SELECT * FROM dead_letter_queue ORDER BY id'),
  idempotency_keys: await all(db, 'SELECT * FROM idempotency_keys ORDER BY id'),
  notification_archive: await all(
    db,
    `SELECT id, original_id, payload, notification_type, target_recipient, execute_at, created_at,
      processing_completed_at, status, retry_count, last_error, event_id, contract_address, metadata,
      archived_at FROM notification_archive ORDER BY id`,
  ),
});

async function applyMigration(db: sqlite3.Database, id = migration.id): Promise<void> {
  const runner = new MigrationRunner(db, '');
  await runner.initializeMigrationTable();
  await runner.applyMigration({ ...migration, id });
}

async function expectNoRebuildTables(db: sqlite3.Database): Promise<void> {
  const tables = await all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_v005'",
  );
  expect(tables).toHaveLength(0);
}

function bootstrapScheduledNotificationColumns(): string[] {
  const schema = readFileSync(join(__dirname, '../database/schema.sql'), 'utf8');
  const tableDefinition = schema.match(
    /CREATE TABLE IF NOT EXISTS scheduled_notifications \(([\s\S]*?)\n\);/i,
  );
  if (!tableDefinition) throw new Error('scheduled_notifications missing from bootstrap schema');

  return Array.from(
    tableDefinition[1].matchAll(/^\s{2}([a-z][a-z0-9_]*)\s+/gim),
    (match) => match[1],
  );
}

describe('migration 005 notification expiration', () => {
  let db: sqlite3.Database;

  beforeEach(async () => {
    db = await openDatabase();
    await run(db, 'PRAGMA foreign_keys = ON');
    await createLegacySchema(db);
    await seedValidRows(db);
  });

  afterEach(async () => {
    await close(db);
  });

  it('preserves legacy rows, enforces the extended checks, and is idempotent', async () => {
    const before = await preservedRows(db);

    await applyMigration(db);

    expect(await preservedRows(db)).toEqual(before);
    expect(
      (await all<{ name: string }>(db, 'PRAGMA table_info(scheduled_notifications)')).map(
        ({ name }) => name,
      ),
    ).toEqual(bootstrapScheduledNotificationColumns());
    expect(
      await all<{ deduplication_key: string }>(
        db,
        'SELECT deduplication_key FROM scheduled_notifications WHERE id = 1',
      ),
    ).toEqual([{ deduplication_key: 'dedupe-key-1' }]);
    expect(
      await all<{ expires_at: string | null }>(
        db,
        'SELECT expires_at FROM scheduled_notifications',
      ),
    ).toEqual([{ expires_at: null }]);
    expect(
      await all<{ expires_at: string | null }>(db, 'SELECT expires_at FROM notification_archive'),
    ).toEqual([{ expires_at: null }]);

    await run(
      db,
      `INSERT INTO scheduled_notifications (payload, notification_type, target_recipient, execute_at, status)
       VALUES ('{}', 'discord', 'user-2', '2026-01-01', 'EXPIRED')`,
    );
    await run(
      db,
      `INSERT INTO scheduled_notifications (payload, notification_type, target_recipient, execute_at, status)
       VALUES ('{}', 'discord', 'user-dead-lettered', '2026-01-01', 'DEAD_LETTERED')`,
    );
    await run(
      db,
      `INSERT INTO notification_archive
       (original_id, payload, notification_type, target_recipient, execute_at, created_at, status)
       VALUES (2, '{}', 'discord', 'user-archive-dead-lettered', '2026-01-01', '2026-01-01', 'DEAD_LETTERED')`,
    );
    await expect(
      run(
        db,
        `INSERT INTO scheduled_notifications (payload, notification_type, target_recipient, execute_at, status)
         VALUES ('{}', 'discord', 'user-3', '2026-01-01', 'UNKNOWN')`,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);

    await expect(
      run(
        db,
        `INSERT INTO notification_execution_log
         (scheduled_notification_id, execution_attempt, status) VALUES (999, 1, 'SUCCESS')`,
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(
      run(
        db,
        `INSERT INTO notification_execution_log
         (scheduled_notification_id, execution_attempt, status) VALUES (1, 1, 'UNKNOWN')`,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      run(
        db,
        `INSERT INTO dead_letter_queue
         (scheduled_notification_id, notification_type, target_recipient, payload, failure_reason)
         VALUES (999, 'discord', 'user-9', '{}', 'failed')`,
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(
      run(
        db,
        `INSERT INTO dead_letter_queue
         (scheduled_notification_id, notification_type, target_recipient, payload, failure_reason)
         VALUES (1, 'unknown', 'user-9', '{}', 'failed')`,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      run(
        db,
        `INSERT INTO idempotency_keys
         (idempotency_key, request_hash, response_notification_id, response_data, expires_at)
         VALUES ('orphan-key', 'hash', 999, '{}', 'expiry')`,
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(
      run(
        db,
        `INSERT INTO idempotency_keys
         (idempotency_key, request_hash, response_notification_id, response_data, expires_at, status)
         VALUES ('unknown-status-key', 'hash', 1, '{}', 'expiry', 'UNKNOWN')`,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      run(
        db,
        `INSERT INTO notification_archive
         (original_id, payload, notification_type, target_recipient, execute_at, created_at, status)
         VALUES (2, '{}', 'discord', 'user-2', 'execute', 'created', 'UNKNOWN')`,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);

    const afterFirstApply = await preservedRows(db);
    await applyMigration(db, '005-repeat');
    expect(await preservedRows(db)).toEqual(afterFirstApply);
  });

  it('aborts before rebuilding when legacy statuses are invalid', async () => {
    await run(db, `UPDATE scheduled_notifications SET status = 'UNKNOWN' WHERE id = 1`);

    await expect(applyMigration(db)).rejects.toThrow(
      /Migration 005 aborted before rebuilding tables.*scheduled_notifications: 1 row\(s\)/,
    );
    await expectNoRebuildTables(db);
    expect(await all(db, 'SELECT status FROM scheduled_notifications WHERE id = 1')).toEqual([
      { status: 'UNKNOWN' },
    ]);
  });

  it('aborts before rebuilding when a legacy expiration timestamp is unparseable', async () => {
    await run(db, 'ALTER TABLE scheduled_notifications ADD COLUMN expires_at DATETIME');
    await run(db, 'ALTER TABLE notification_archive ADD COLUMN expires_at DATETIME');
    await run(db, `UPDATE scheduled_notifications SET expires_at = 'not-a-date' WHERE id = 1`);

    await expect(applyMigration(db)).rejects.toThrow(
      /Migration 005 aborted before rebuilding tables.*scheduled_notifications: 1 row\(s\)/,
    );
    await expectNoRebuildTables(db);
    expect(await all(db, 'SELECT expires_at FROM scheduled_notifications WHERE id = 1')).toEqual([
      { expires_at: 'not-a-date' },
    ]);
  });
});
