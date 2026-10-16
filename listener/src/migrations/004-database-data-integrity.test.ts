import * as sqlite3 from 'sqlite3';
import { Database } from '../database/database';
import { MigrationRunner } from '../database/migration-system';
import migration from './004-database-data-integrity';

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
    CREATE TABLE processed_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, contract_address TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE, ledger_number INTEGER NOT NULL, tx_hash TEXT,
      event_type VARCHAR(50) NOT NULL, processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_reorg_duplicate BOOLEAN NOT NULL DEFAULT 0, reorg_detection_count INTEGER NOT NULL DEFAULT 0,
      last_redetected_at DATETIME, status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED',
      notification_sent BOOLEAN NOT NULL DEFAULT 0, error_reason TEXT
    );
    CREATE TABLE polling_cursors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contract_address TEXT NOT NULL UNIQUE,
      cursor TEXT NOT NULL, ledger_number INTEGER NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reorg_detected BOOLEAN NOT NULL DEFAULT 0, reorg_detection_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE idempotency_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      response_notification_id INTEGER NOT NULL, response_data TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED',
      FOREIGN KEY (response_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE
    );
    CREATE TABLE rate_limit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, client_type VARCHAR(20) NOT NULL,
      endpoint TEXT NOT NULL, method VARCHAR(10) NOT NULL, timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      limit_threshold INTEGER NOT NULL, window_ms INTEGER NOT NULL
    );
    CREATE TABLE notification_templates (id TEXT PRIMARY KEY);
    CREATE TABLE notification_template_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, template_id TEXT NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'UPDATE', changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      previous_snapshot TEXT NOT NULL, new_snapshot TEXT NOT NULL,
      FOREIGN KEY (template_id) REFERENCES notification_templates(id) ON DELETE RESTRICT
    );
    CREATE TABLE backpressure_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type VARCHAR(20) NOT NULL, queue_size INTEGER NOT NULL,
      target_throughput_per_sec INTEGER NOT NULL, duration_ms INTEGER, reason TEXT,
      timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE notification_metrics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, total_recorded INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL
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
    `INSERT INTO notification_execution_log VALUES (1, 1, 1, 'attempt-time', 'FAILED', 'failed', NULL, 3)`,
  );
  await run(
    db,
    `INSERT INTO dead_letter_queue VALUES (1, 1, 'discord', 'user-1', '{"n":1}', 'failed', NULL, 'dlq-time', NULL, 1)`,
  );
  await run(
    db,
    `INSERT INTO processed_events VALUES (1, 'event-1', 'contract-1', 'fingerprint-1', 42, 'tx-1', 'contract', 'processed-time', 1, 2, 'redetected-time', 'ERROR', 0, 'failed')`,
  );
  await run(
    db,
    `INSERT INTO polling_cursors VALUES (1, 'contract-1', 'cursor-42', 42, 'cursor-time', 1, 2)`,
  );
  await run(
    db,
    `INSERT INTO idempotency_keys VALUES (1, 'key-1', 'hash-1', 1, '{"id":1}', 'key-time', 'expiry-time', 'EXPIRED')`,
  );
  await run(
    db,
    `INSERT INTO rate_limit_events VALUES (1, 'client-1', 'API_KEY', '/api', 'POST', 'rate-time', 10, 1000)`,
  );
  await run(db, `INSERT INTO notification_templates VALUES ('template-1')`);
  await run(
    db,
    `INSERT INTO notification_template_audit_log VALUES (1, 'template-1', 'operator', 'UPDATE', 'audit-time', '{}', '{}')`,
  );
  await run(
    db,
    `INSERT INTO backpressure_events VALUES (1, 'ACTIVATED', 12, 100, NULL, 'load', 'pressure-time')`,
  );
  await run(
    db,
    `INSERT INTO notification_metrics_snapshots VALUES (1, 'capture-time', 10, 20, 5, '{}')`,
  );
  await run(
    db,
    `INSERT INTO notification_archive VALUES (1, 1, '{"n":1}', 'discord', 'user-1', 'execute-time', 'created', 'completed', 'COMPLETED', 1, 'done', 'event-1', 'contract-1', '{}', 'archive-time')`,
  );
}

const PRESERVED_TABLES = [
  'scheduled_notifications',
  'notification_execution_log',
  'dead_letter_queue',
  'processed_events',
  'polling_cursors',
  'idempotency_keys',
  'rate_limit_events',
  'notification_template_audit_log',
  'backpressure_events',
  'notification_metrics_snapshots',
  'notification_archive',
];

describe('migration 004 database data integrity', () => {
  let db: sqlite3.Database;

  beforeEach(async () => {
    db = await openDatabase();
    await run(db, 'PRAGMA foreign_keys = ON');
    const pragma = await all<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys');
    expect(pragma[0].foreign_keys).toBe(1);
    await createLegacySchema(db);
    await seedValidRows(db);
  });

  afterEach(async () => {
    await close(db);
  });

  it('preserves valid legacy rows and enforces FK, status, and existing unique-key constraints', async () => {
    const before: Record<string, unknown[]> = {};
    for (const table of PRESERVED_TABLES) {
      before[table] = await all(db, `SELECT * FROM ${table} ORDER BY id`);
    }
    const sourceColumns = (
      await all<{ name: string }>(db, 'PRAGMA table_info(scheduled_notifications)')
    ).map(({ name }) => name);

    await run(db, 'PRAGMA foreign_keys = OFF');
    const runner = new MigrationRunner(db, '');
    await runner.initializeMigrationTable();
    const runnerPragma = await all<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys');
    expect(runnerPragma[0].foreign_keys).toBe(1);
    await runner.applyMigration(migration);
    await runner.applyMigration({ ...migration, id: '004-repeat' });

    for (const table of PRESERVED_TABLES) {
      expect(await all(db, `SELECT * FROM ${table} ORDER BY id`)).toEqual(before[table]);
    }
    const rebuiltColumns = (
      await all<{ name: string }>(db, 'PRAGMA table_info(scheduled_notifications)')
    ).map(({ name }) => name);
    // Compare to pre-004 columns; later migration 005 owns expires_at.
    expect(rebuiltColumns.sort()).toEqual(sourceColumns.sort());
    expect(
      await all<{ deduplication_key: string }>(
        db,
        'SELECT deduplication_key FROM scheduled_notifications WHERE id = 1',
      ),
    ).toEqual([{ deduplication_key: 'dedupe-key-1' }]);

    const foreignKeyViolations = await all(db, 'PRAGMA foreign_key_check');
    expect(foreignKeyViolations).toHaveLength(0);

    await expect(
      run(
        db,
        `INSERT INTO notification_execution_log (scheduled_notification_id, execution_attempt, status)
        VALUES (999, 1, 'SUCCESS')`,
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(
      run(
        db,
        `INSERT INTO scheduled_notifications (payload, notification_type, target_recipient, execute_at, status)
        VALUES ('{}', 'discord', 'user-2', '2026-01-01', 'UNKNOWN')`,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
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
        `INSERT INTO processed_events
        (event_id, contract_address, fingerprint, ledger_number, event_type)
        VALUES ('event-duplicate', 'contract-1', 'fingerprint-1', 43, 'contract')`,
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('fails closed with a table and row count when legacy state is invalid', async () => {
    await run(db, `UPDATE processed_events SET status = 'UNKNOWN' WHERE id = 1`);
    const runner = new MigrationRunner(db, '');
    await runner.initializeMigrationTable();

    await expect(runner.applyMigration(migration)).rejects.toThrow(
      /Migration 004 aborted.*processed_events: 1 row\(s\)/,
    );
    const rows = await all<{ status: string }>(
      db,
      'SELECT status FROM processed_events WHERE id = 1',
    );
    expect(rows[0].status).toBe('UNKNOWN');
    const temporaryTable = await all(db, `SELECT name FROM sqlite_master WHERE name LIKE '%_v004'`);
    expect(temporaryTable).toHaveLength(0);
  });

  it('enables foreign keys and installs matching constraints on fresh bootstrap databases', async () => {
    const freshDb = new Database(':memory:');
    await freshDb.initialize();
    try {
      const pragma = await freshDb.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
      expect(pragma?.foreign_keys).toBe(1);
      await freshDb.run(`INSERT INTO scheduled_notifications
        (payload, notification_type, target_recipient, execute_at, status)
        VALUES ('{}', 'discord', 'user-dead-lettered', '2026-01-01', 'DEAD_LETTERED')`);
      await freshDb.run(`INSERT INTO notification_archive
        (original_id, payload, notification_type, target_recipient, execute_at, created_at, status)
        VALUES (1, '{}', 'discord', 'user-archive-dead-lettered', '2026-01-01', '2026-01-01', 'DEAD_LETTERED')`);
      await expect(
        freshDb.run(`INSERT INTO scheduled_notifications
          (payload, notification_type, target_recipient, execute_at, status)
          VALUES ('{}', 'discord', 'user-1', '2026-01-01', 'UNKNOWN')`),
      ).rejects.toThrow(/CHECK constraint failed/);
    } finally {
      await freshDb.close();
    }
  });
});
