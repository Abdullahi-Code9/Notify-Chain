import * as sqlite3 from 'sqlite3';
import migration008, {
  DEFAULT_LEGACY_DESTINATION_OWNER_ID,
  applyDestinationOwnershipMigration,
} from './008-destination-ownership';

function openMemoryDb(): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function all<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
  });
}

function closeDb(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('migration 008 destination ownership', () => {
  let db: sqlite3.Database;

  beforeEach(async () => {
    db = await openMemoryDb();
    await run(db, 'PRAGMA foreign_keys = ON');
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it('creates destinations with non-empty owner_id constraint on fresh database', async () => {
    await migration008.up(db);

    const cols = await all<{ name: string; notnull: number }>(
      db,
      'PRAGMA table_info(destinations)',
    );
    const ownerCol = cols.find((c) => c.name === 'owner_id');
    expect(ownerCol).toBeDefined();
    expect(ownerCol?.notnull).toBe(1);

    await expect(
      run(
        db,
        `INSERT INTO destinations (id, owner_id, provider, display_name)
         VALUES ('d1', '   ', 'webhook', 'Test Hook')`,
      ),
    ).rejects.toThrow();

    await run(
      db,
      `INSERT INTO destinations (id, owner_id, provider, display_name)
       VALUES ('d1', 'user-1', 'webhook', 'Test Hook')`,
    );

    const rows = await all<{ id: string; owner_id: string }>(
      db,
      'SELECT id, owner_id FROM destinations',
    );
    expect(rows).toEqual([{ id: 'd1', owner_id: 'user-1' }]);
  });

  it('safely migrates legacy destinations table without owner_id and preserves all rows', async () => {
    await run(
      db,
      `CREATE TABLE destinations (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'connected',
        settings_json TEXT NOT NULL DEFAULT '{}',
        secrets_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        last_tested_at INTEGER,
        created_at DATETIME NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
        updated_at DATETIME NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
      )`,
    );

    await run(
      db,
      `INSERT INTO destinations (id, provider, display_name, settings_json, secrets_json)
       VALUES ('legacy-hook-1', 'webhook', 'Legacy Hook', '{"url":"https://example.com/hook"}', '{"signingSecret":"secret1234"}')`,
    );

    const result = await applyDestinationOwnershipMigration(db);
    expect(result.migratedLegacyRows).toBe(1);

    const rows = await all<{
      id: string;
      owner_id: string;
      settings_json: string;
      secrets_json: string;
    }>(db, 'SELECT id, owner_id, settings_json, secrets_json FROM destinations');

    expect(rows).toEqual([
      {
        id: 'legacy-hook-1',
        owner_id: DEFAULT_LEGACY_DESTINATION_OWNER_ID,
        settings_json: '{"url":"https://example.com/hook"}',
        secrets_json: '{"signingSecret":"secret1234"}',
      },
    ]);

    // Idempotent re-run leaves existing rows untouched
    const rerun = await applyDestinationOwnershipMigration(db, 'different-fallback');
    expect(rerun.migratedLegacyRows).toBe(0);
    const afterRerun = await all<{ owner_id: string }>(db, 'SELECT owner_id FROM destinations');
    expect(afterRerun).toEqual([{ owner_id: DEFAULT_LEGACY_DESTINATION_OWNER_ID }]);
  });

  it('preserves user_id from legacy tables when mapping to owner_id', async () => {
    await run(
      db,
      `CREATE TABLE destinations (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        provider TEXT NOT NULL,
        display_name TEXT NOT NULL
      )`,
    );

    await run(
      db,
      `INSERT INTO destinations (id, user_id, provider, display_name)
       VALUES ('d-alice', 'alice', 'webhook', 'Alice Hook'),
              ('d-orphan', NULL, 'discord', 'Orphan Discord')`,
    );

    await applyDestinationOwnershipMigration(db, 'legacy:quarantined');

    const rows = await all<{ id: string; owner_id: string }>(
      db,
      'SELECT id, owner_id FROM destinations ORDER BY id',
    );
    expect(rows).toEqual([
      { id: 'd-alice', owner_id: 'alice' },
      { id: 'd-orphan', owner_id: 'legacy:quarantined' },
    ]);
  });

  it('supports clean rollback via down()', async () => {
    await migration008.up(db);
    await migration008.down(db);

    const tables = await all<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'destinations'",
    );
    expect(tables).toHaveLength(0);
  });
});
