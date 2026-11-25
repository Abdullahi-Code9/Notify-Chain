import * as sqlite3 from 'sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MigrationRunner } from '../database/migration-system';
import migration006 from './006-database-data-integrity';
import migration007 from './007-notification-expiration';

function openDatabase(): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (error) => {
      if (error) reject(error);
      else resolve(db);
    });
  });
}

function run(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (error) => (error ? reject(error) : resolve()));
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

async function loadFixture(db: sqlite3.Database, name: string): Promise<void> {
  await exec(db, readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
}

async function seedNotificationHistory(db: sqlite3.Database): Promise<void> {
  await run(
    db,
    `INSERT INTO scheduled_notifications
      (id, payload, payload_hash, notification_type, target_recipient, execute_at, created_at,
       updated_at, status, retry_count, max_retries, priority, event_id, contract_address,
       metadata, next_retry_at, deduplication_key)
     VALUES (1, '{"message":"keep"}', 'payload-hash', 'discord', 'recipient-1', 'execute-time',
       'created-time', 'updated-time', 'FAILED', 2, 4, 7, 'event-1', 'contract-1',
       '{"trace":"keep"}', 'retry-time', 'dedupe-1')`,
  );
  await run(
    db,
    `INSERT INTO notification_execution_log
      (id, scheduled_notification_id, execution_attempt, execution_time, status, error_message, duration_ms)
     VALUES (1, 1, 2, 'attempt-time', 'FAILED', 'provider timeout', 42)`,
  );
  await run(
    db,
    `INSERT INTO dead_letter_queue
      (id, scheduled_notification_id, notification_type, target_recipient, payload, failure_reason, retry_count)
     VALUES (1, 1, 'discord', 'recipient-1', '{"message":"keep"}', 'exhausted', 2)`,
  );
  await run(
    db,
    `INSERT INTO idempotency_keys
      (id, idempotency_key, request_hash, response_notification_id, response_data, created_at, expires_at, status)
     VALUES (1, 'key-1', 'request-hash', 1, '{"notificationId":1}', 'key-created', 'key-expires', 'EXPIRED')`,
  );
  await run(
    db,
    `INSERT INTO notification_archive
      (id, original_id, payload, notification_type, target_recipient, execute_at, created_at,
       processing_completed_at, status, retry_count, last_error, event_id, contract_address, metadata, archived_at)
     VALUES (1, 1, '{"message":"archive"}', 'discord', 'recipient-1', 'execute-time',
       'created-time', 'completed-time', 'COMPLETED', 1, NULL, 'event-1', 'contract-1',
       '{"archived":true}', 'archive-time')`,
  );
}

async function notificationData(db: sqlite3.Database) {
  return {
    scheduled: await all(db, `SELECT * FROM scheduled_notifications ORDER BY id`),
    execution: await all(db, `SELECT * FROM notification_execution_log ORDER BY id`),
    deadLetter: await all(db, `SELECT * FROM dead_letter_queue ORDER BY id`),
    idempotency: await all(db, `SELECT * FROM idempotency_keys ORDER BY id`),
    archive: await all(db, `SELECT * FROM notification_archive ORDER BY id`),
  };
}

describe('supported database upgrade paths', () => {
  let db: sqlite3.Database;

  beforeEach(async () => {
    db = await openDatabase();
    await run(db, 'PRAGMA foreign_keys = ON');
  });

  afterEach(async () => {
    await close(db);
  });

  it('upgrades the pre-004 fixture through migrations 004 and 005 without losing notification history', async () => {
    await loadFixture(db, 'pre-004.sql');
    await seedNotificationHistory(db);
    const runner = new MigrationRunner(db, '');
    await runner.initializeMigrationTable();

    await runner.applyMigration(migration006);
    await runner.applyMigration(migration007);

    const data = await notificationData(db);
    expect(data.scheduled).toEqual([
      expect.objectContaining({
        id: 1,
        payload: '{"message":"keep"}',
        payload_hash: 'payload-hash',
        notification_type: 'discord',
        target_recipient: 'recipient-1',
        status: 'FAILED',
        retry_count: 2,
        max_retries: 4,
        priority: 7,
        event_id: 'event-1',
        contract_address: 'contract-1',
        metadata: '{"trace":"keep"}',
        next_retry_at: 'retry-time',
        deduplication_key: 'dedupe-1',
        expires_at: null,
      }),
    ]);
    expect(data.execution).toEqual([
      expect.objectContaining({
        id: 1,
        scheduled_notification_id: 1,
        execution_attempt: 2,
        error_message: 'provider timeout',
        duration_ms: 42,
      }),
    ]);
    expect(data.deadLetter).toEqual([
      expect.objectContaining({ id: 1, scheduled_notification_id: 1, failure_reason: 'exhausted' }),
    ]);
    expect(data.idempotency).toEqual([
      expect.objectContaining({ id: 1, idempotency_key: 'key-1', status: 'EXPIRED' }),
    ]);
    expect(data.archive).toEqual([
      expect.objectContaining({
        id: 1,
        original_id: 1,
        status: 'COMPLETED',
        metadata: '{"archived":true}',
        expires_at: null,
      }),
    ]);
    expect(await all(db, 'PRAGMA foreign_key_check')).toHaveLength(0);
  });

  it('upgrades the pre-005 fixture and preserves existing notification expiration data', async () => {
    await loadFixture(db, 'pre-005.sql');
    await seedNotificationHistory(db);
    await run(db, `ALTER TABLE scheduled_notifications ADD COLUMN expires_at DATETIME`);
    await run(db, `ALTER TABLE notification_archive ADD COLUMN expires_at DATETIME`);
    await run(db, `UPDATE scheduled_notifications SET expires_at = '2026-12-31 23:59:59'`);
    await run(db, `UPDATE notification_archive SET expires_at = '2027-01-01 00:00:00'`);
    const runner = new MigrationRunner(db, '');
    await runner.initializeMigrationTable();

    await runner.applyMigration(migration007);

    const data = await notificationData(db);
    expect(data.scheduled).toEqual([
      expect.objectContaining({
        id: 1,
        payload: '{"message":"keep"}',
        expires_at: '2026-12-31 23:59:59',
        deduplication_key: 'dedupe-1',
      }),
    ]);
    expect(data.archive).toEqual([
      expect.objectContaining({
        id: 1,
        original_id: 1,
        expires_at: '2027-01-01 00:00:00',
        metadata: '{"archived":true}',
      }),
    ]);
    expect(await all(db, 'PRAGMA foreign_key_check')).toHaveLength(0);
  });

  it('rolls back all schema and data changes if migration 005 fails after rebuilding tables', async () => {
    await loadFixture(db, 'pre-005.sql');
    await seedNotificationHistory(db);
    const beforeData = await notificationData(db);
    const runner = new MigrationRunner(db, '');
    await runner.initializeMigrationTable();
    const beforeSchema = await all(
      db,
      `SELECT type, name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    );
    const failure = new Error('simulated post-upgrade verification failure');

    await expect(
      runner.applyMigration({
        ...migration007,
        id: '005-failed-upgrade',
        up: async (migrationDb) => {
          await migration007.up(migrationDb);
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(await notificationData(db)).toEqual(beforeData);
    expect(
      await all(
        db,
        `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      ),
    ).toEqual(beforeSchema);
    expect(await all(db, "SELECT id FROM migrations WHERE id = '005-failed-upgrade'")).toHaveLength(
      0,
    );
  });
});
