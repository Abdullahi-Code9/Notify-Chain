import * as sqlite3 from 'sqlite3';
import migration from './006-recurring-notifications';

function openDatabase(): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (error) => (error ? reject(error) : resolve(db)));
  });
}

function run(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (error) => (error ? reject(error) : resolve()));
  });
}

function columns(db: sqlite3.Database): Promise<string[]> {
  return new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(scheduled_notifications)', (error, rows: Array<{ name: string }>) => {
      if (error) reject(error);
      else resolve(rows.map((row) => row.name));
    });
  });
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('migration 006 recurring notifications', () => {
  let db: sqlite3.Database;

  beforeEach(async () => {
    db = await openDatabase();
  });

  afterEach(async () => {
    await close(db);
  });

  it('adds recurrence columns to existing notification tables', async () => {
    await run(
      db,
      'CREATE TABLE scheduled_notifications (id INTEGER PRIMARY KEY, execute_at DATETIME NOT NULL)',
    );
    await migration.up(db);

    expect(await columns(db)).toEqual(
      expect.arrayContaining(['recurrence_rule', 'occurrence_count', 'last_run_at']),
    );
  });

  it('is safe when the base schema already has recurrence columns', async () => {
    await run(
      db,
      `CREATE TABLE scheduled_notifications (
        id INTEGER PRIMARY KEY,
        recurrence_rule TEXT,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        last_run_at DATETIME
      )`,
    );

    await expect(migration.up(db)).resolves.toBeUndefined();
  });
});
