/**
 * Tests for database connection recovery (#786).
 *
 * Covers:
 *  1. Queries keep working after the underlying handle is closed underneath
 *     the wrapper (transient failure -> transparent reconnect + retry).
 *  2. Reconnect attempts are bounded: a database that cannot be re-opened
 *     fails fast after the configured budget instead of hanging forever.
 *  3. Data errors (constraint violations) are NOT treated as connection
 *     failures and propagate immediately with no reconnect.
 *  4. No recovery happens inside a transaction: a failure mid-transaction
 *     rolls back and propagates without silently swapping the handle.
 */
import { Database } from '../database/database';
import * as fs from 'fs';
import * as path from 'path';

describe('Database connection recovery', () => {
  const testDbPath = './data/test-db-recovery.db';

  beforeEach(() => {
    const dbDir = path.dirname(testDbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  afterEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  test('recovers transparently when the handle is closed mid-flight', async () => {
    const db = new Database(testDbPath, { maxReconnectAttempts: 3, reconnectBaseDelayMs: 10 });
    await db.initialize();
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await db.run("INSERT INTO t (v) VALUES ('before')");

    // Simulate a transient connection loss: close the raw handle without
    // telling the wrapper.
    await new Promise<void>((resolve) => (db as any).db.close(() => resolve()));

    // The next query should detect the failure, reconnect, and succeed.
    await db.run("INSERT INTO t (v) VALUES ('after')");
    const rows = await db.all<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.map((r) => r.v)).toEqual(['before', 'after']);
    expect(db.isConnected()).toBe(true);
    await db.close();
  });

  test('fails fast after the reconnect budget when the database cannot be re-opened', async () => {
    const db = new Database(testDbPath, { maxReconnectAttempts: 2, reconnectBaseDelayMs: 1 });
    await db.initialize();

    // Make reconnection impossible: point the wrapper at a path in a
    // directory that does not exist, then kill the handle.
    (db as any).dbPath = './data/no-such-dir-xyz/db.sqlite';
    await new Promise<void>((resolve) => (db as any).db.close(() => resolve()));
    (db as any).db = null;

    const start = Date.now();
    await expect(db.all('SELECT 1')).rejects.toThrow();
    // initial try + 2 reconnect attempts, each bounded by backoff
    expect(Date.now() - start).toBeLessThan(10000);
  }, 15000);

  test('does not attempt recovery for data errors', async () => {
    const db = new Database(testDbPath, { maxReconnectAttempts: 3, reconnectBaseDelayMs: 1 });
    await db.initialize();
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)');
    await db.run("INSERT INTO t (v) VALUES ('dup')");

    const handleBefore = (db as any).db;
    await expect(db.run("INSERT INTO t (v) VALUES ('dup')")).rejects.toThrow();
    // Same handle: no reconnect happened for a constraint violation.
    expect((db as any).db).toBe(handleBefore);
    await db.close();
  });

  test('no recovery inside a transaction: failure rolls back and propagates', async () => {
    const db = new Database(testDbPath, { maxReconnectAttempts: 3, reconnectBaseDelayMs: 1 });
    await db.initialize();
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)');
    await db.run("INSERT INTO t (v) VALUES ('kept')");

    const handleBefore = (db as any).db;
    await expect(
      db.transaction(async () => {
        await db.run("INSERT INTO t (v) VALUES ('rolled-back')");
        await db.run("INSERT INTO t (v) VALUES ('kept')"); // constraint violation
      })
    ).rejects.toThrow();

    // Transaction rolled back: only the original row remains.
    const rows = await db.all<{ v: string }>('SELECT v FROM t');
    expect(rows.map((r) => r.v)).toEqual(['kept']);
    // No reconnect was triggered inside the transaction.
    expect((db as any).db).toBe(handleBefore);
    await db.close();
  });

  test('operations after an explicit close fail rather than silently reconnecting', async () => {
    const db = new Database(testDbPath);
    await db.initialize();
    await db.close();
    await expect(db.all('SELECT 1')).rejects.toThrow('Database not initialized');
  });
});
