/**
 * Verifies migration 003 (event & notification query indexes):
 * - fresh databases get the indexes from schema.sql
 * - the migration is idempotent and reversible on an existing database
 * - the hot queries it targets actually use the new indexes
 * - existing query results are unchanged (compatibility)
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sqlite3 from 'sqlite3';
import { Database } from './database';
import migration003 from '../migrations/003-event-notification-query-indexes';

const NEW_INDEXES = migration003.indexNames;

async function indexNames(db: Database): Promise<Set<string>> {
  const rows = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`,
  );
  return new Set(rows.map((r) => r.name));
}

async function plan(db: Database, sql: string, params: unknown[]): Promise<string> {
  const rows = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
  return rows.map((r) => r.detail).join(' | ');
}

describe('event & notification query indexes (migration 003)', () => {
  let db: Database;
  let dbPath: string;
  let raw: sqlite3.Database;

  beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `notify-idx003-${process.pid}-${Date.now()}.db`);
    db = new Database(dbPath);
    await db.initialize();
    raw = (db as unknown as { db: sqlite3.Database }).db;

    const statuses = ['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PROCESSING'];
    const types = ['discord', 'webhook', 'Webhook', 'email'];
    await db.run('BEGIN');
    for (let i = 0; i < 300; i++) {
      const status = statuses[i % statuses.length];
      const ts = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
      await db.run(
        `INSERT INTO scheduled_notifications
           (payload, notification_type, target_recipient, execute_at, status,
            processing_completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['{}', types[i % types.length], `user-${i}`, ts, status, status === 'PENDING' ? null : ts, ts],
      );
      await db.run(
        `INSERT INTO processed_events
           (event_id, contract_address, fingerprint, ledger_number, event_type, processed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`e-${i}`, `C${i % 5}`, `C${i % 5}:e-${i}`, i, i % 3 ? 'contract' : 'System', ts],
      );
    }
    await db.run('COMMIT');
    await db.run('ANALYZE');
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('creates the new indexes on a fresh database via schema.sql', async () => {
    const names = await indexNames(db);
    for (const name of NEW_INDEXES) {
      expect(names.has(name)).toBe(true);
    }
  });

  it('migration down() removes and up() restores the indexes, idempotently', async () => {
    await migration003.down(raw);
    let names = await indexNames(db);
    for (const name of NEW_INDEXES) expect(names.has(name)).toBe(false);

    await migration003.up(raw);
    await migration003.up(raw); // IF NOT EXISTS — re-running is safe
    names = await indexNames(db);
    for (const name of NEW_INDEXES) expect(names.has(name)).toBe(true);
  });

  it('archival batch query uses the archivable index without a temp sort', async () => {
    const detail = await plan(
      db,
      `SELECT id FROM scheduled_notifications
       WHERE status IN ('COMPLETED','FAILED','CANCELLED')
         AND processing_completed_at IS NOT NULL
         AND processing_completed_at < ?
       ORDER BY processing_completed_at ASC
       LIMIT ?`,
      ['2027-01-01T00:00:00.000Z', 100],
    );
    expect(detail).toContain('idx_scheduled_notifications_archivable');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('notification search by type uses the LOWER(notification_type) index', async () => {
    const detail = await plan(
      db,
      `SELECT id FROM scheduled_notifications
       WHERE LOWER(notification_type) = ?
       ORDER BY created_at DESC LIMIT 50`,
      ['webhook'],
    );
    expect(detail).toContain('idx_scheduled_notifications_type_lower_created');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('processed-event search by type uses the LOWER(event_type) index', async () => {
    const detail = await plan(
      db,
      `SELECT id FROM processed_events
       WHERE LOWER(event_type) = ?
       ORDER BY processed_at DESC LIMIT 50`,
      ['system'],
    );
    expect(detail).toContain('idx_processed_events_type_lower_processed');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('returns identical results with and without the new indexes', async () => {
    const queries: Array<[string, unknown[]]> = [
      [
        `SELECT id FROM scheduled_notifications
         WHERE status IN ('COMPLETED','FAILED','CANCELLED')
           AND processing_completed_at < ?
         ORDER BY processing_completed_at ASC, id ASC LIMIT 40`,
        ['2026-01-01T03:00:00.000Z'],
      ],
      [
        `SELECT id FROM scheduled_notifications
         WHERE LOWER(notification_type) = ? ORDER BY created_at DESC, id DESC`,
        ['webhook'],
      ],
      [
        `SELECT id FROM processed_events
         WHERE LOWER(event_type) = ? ORDER BY processed_at DESC, id DESC`,
        ['system'],
      ],
    ];

    const withIndexes = [];
    for (const [sql, params] of queries) withIndexes.push(await db.all(sql, params));

    await migration003.down(raw);
    try {
      for (let i = 0; i < queries.length; i++) {
        const [sql, params] = queries[i];
        expect(await db.all(sql, params)).toEqual(withIndexes[i]);
      }
    } finally {
      await migration003.up(raw);
    }

    // Case-insensitive match still includes mixed-case stored values.
    expect(withIndexes[1].length).toBe(150);
  });
});
