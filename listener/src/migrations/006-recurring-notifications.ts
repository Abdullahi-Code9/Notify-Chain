import * as sqlite3 from 'sqlite3';

function run(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (error) => (error ? reject(error) : resolve()));
  });
}

async function hasColumn(db: sqlite3.Database, column: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(scheduled_notifications)', (error, rows: Array<{ name: string }>) => {
      if (error) reject(error);
      else resolve(rows.some((row) => row.name === column));
    });
  });
}

const migration = {
  id: '006',
  name: 'recurring-notifications',
  up: async (db: sqlite3.Database) => {
    if (!(await hasColumn(db, 'recurrence_rule'))) {
      await run(db, 'ALTER TABLE scheduled_notifications ADD COLUMN recurrence_rule TEXT');
    }
    if (!(await hasColumn(db, 'occurrence_count'))) {
      await run(
        db,
        'ALTER TABLE scheduled_notifications ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!(await hasColumn(db, 'last_run_at'))) {
      await run(db, 'ALTER TABLE scheduled_notifications ADD COLUMN last_run_at DATETIME');
    }
  },
  down: async (db: sqlite3.Database) => {
    if (await hasColumn(db, 'last_run_at'))
      await run(db, 'ALTER TABLE scheduled_notifications DROP COLUMN last_run_at');
    if (await hasColumn(db, 'occurrence_count'))
      await run(db, 'ALTER TABLE scheduled_notifications DROP COLUMN occurrence_count');
    if (await hasColumn(db, 'recurrence_rule'))
      await run(db, 'ALTER TABLE scheduled_notifications DROP COLUMN recurrence_rule');
  },
};

export default migration;
