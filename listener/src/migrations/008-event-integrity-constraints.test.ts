import * as sqlite3 from 'sqlite3';
import { MigrationRunner } from '../database/migration-system';
import migration from './008-event-integrity-constraints';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function openDatabase(): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (error) => (error ? reject(error) : resolve(db)));
  });
}

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

function all<T>(db: sqlite3.Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (error, rows) => (error ? reject(error) : resolve(rows as T[])));
  });
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => db.close((error) => (error ? reject(error) : resolve())));
}

async function createLegacyProcessedEvents(db: sqlite3.Database): Promise<void> {
  await run(
    db,
    `CREATE TABLE processed_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      ledger_number INTEGER NOT NULL,
      event_type VARCHAR(50) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PROCESSED'
    )`,
  );
}

async function insertEvent(db: sqlite3.Database, eventId: string, contract = 'CA'): Promise<void> {
  await run(
    db,
    `INSERT INTO processed_events (event_id, contract_address, fingerprint, ledger_number, event_type)
     VALUES (?, ?, ?, 1, 'contract')`,
    [eventId, contract, `${contract}:${eventId}:${Math.random()}`],
  );
}

describe('migration 008: event integrity constraints (#1121)', () => {
  let db: sqlite3.Database;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await openDatabase();
    runner = new MigrationRunner(db, __dirname);
    await runner.initializeMigrationTable();
    await createLegacyProcessedEvents(db);
  });

  afterEach(async () => {
    await close(db);
  });

  it('preserves existing valid rows and adds the unique constraint', async () => {
    await insertEvent(db, 'e1');
    await insertEvent(db, 'e2');
    await insertEvent(db, 'e1', 'CB');

    await runner.applyMigration(migration);

    expect(await all(db, 'SELECT id FROM processed_events')).toHaveLength(3);
    await expect(insertEvent(db, 'e1')).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('aborts without changing data when duplicates already exist', async () => {
    await insertEvent(db, 'dup');
    await insertEvent(db, 'dup');

    await expect(runner.applyMigration(migration)).rejects.toThrow(/duplicate/);

    expect(await all(db, 'SELECT id FROM processed_events')).toHaveLength(2);
    expect(
      await all(db, "SELECT name FROM sqlite_master WHERE name = 'event_processing_timings'"),
    ).toHaveLength(0);
    expect(await all(db, "SELECT id FROM migrations WHERE id = '008'")).toHaveLength(0);
  });

  it('enforces the timings foreign key and one timing row per event', async () => {
    await insertEvent(db, 'e1');
    await runner.applyMigration(migration);

    await run(db, "INSERT INTO event_processing_timings (processed_event_id, outcome) VALUES (1, 'processed')");
    await expect(
      run(db, "INSERT INTO event_processing_timings (processed_event_id, outcome) VALUES (1, 'processed')"),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(
      run(db, "INSERT INTO event_processing_timings (processed_event_id, outcome) VALUES (999, 'processed')"),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(
      run(
        db,
        "INSERT INTO event_processing_timings (processed_event_id, outcome, retrieval_ms) VALUES (1, 'processed', -1)",
      ),
    ).rejects.toThrow(/CHECK constraint failed/);

    await run(db, 'DELETE FROM processed_events WHERE id = 1');
    expect(await all(db, 'SELECT id FROM event_processing_timings')).toHaveLength(0);
  });

  it('enforces idempotency key uniqueness per scope', async () => {
    await runner.applyMigration(migration);
    const insert = (scope: string) =>
      run(
        db,
        `INSERT INTO api_idempotency_keys (scope, idempotency_key, request_fingerprint, status, expires_at)
         VALUES (?, 'k1', 'fp', 'IN_PROGRESS', '2999-01-01T00:00:00.000Z')`,
        [scope],
      );
    await insert('client-a');
    await insert('client-b');
    await expect(insert('client-a')).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(
      run(
        db,
        `INSERT INTO api_idempotency_keys (scope, idempotency_key, request_fingerprint, status, expires_at)
         VALUES ('client-c', 'k1', 'fp', 'COMPLETED', '2999-01-01T00:00:00.000Z')`,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('is idempotent and reversible', async () => {
    await runner.applyMigration(migration);
    await migration.up(db);
    await migration.down(db);
    await migration.down(db);
    expect(
      await all(db, "SELECT name FROM sqlite_master WHERE name LIKE '%event_processing_timings%'"),
    ).toHaveLength(0);
  });
});
