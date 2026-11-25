import * as sqlite3 from 'sqlite3';

const migration = {
  id: '005',
  name: 'notification-deduplication-key',
  up: async (db: sqlite3.Database) => {
    const columns = await new Promise<any[]>((resolve, reject) => {
      db.all("PRAGMA table_info(scheduled_notifications)", (error, rows) => (error ? reject(error) : resolve(rows)));
    });
    if (!columns.some((col: any) => col.name === 'deduplication_key')) {
      await db.run(`
        ALTER TABLE scheduled_notifications
        ADD COLUMN deduplication_key TEXT
      `);
    }
    await db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_notifications_dedup_key
        ON scheduled_notifications(deduplication_key)
        WHERE deduplication_key IS NOT NULL
    `);
  },
  down: async (db: sqlite3.Database) => {
    await db.run('DROP INDEX IF EXISTS idx_scheduled_notifications_dedup_key');
    // SQLite does not support DROP COLUMN before 3.35; recreate without the column.
    await db.run('DROP TABLE IF EXISTS scheduled_notifications_backup');
    await db.run(`
      CREATE TEMP TABLE scheduled_notifications_backup AS
        SELECT * FROM scheduled_notifications
    `);
    await db.run('DROP TABLE scheduled_notifications');
    await db.run('DROP TABLE IF EXISTS scheduled_notifications_new');
    await db.run(`
      CREATE TABLE scheduled_notifications AS
        SELECT id, payload, payload_hash, notification_type, target_recipient,
               execute_at, expires_at, created_at, updated_at, status, retry_count,
               max_retries, processing_started_at, processing_completed_at,
               processor_id, lock_expires_at, last_error, error_details, event_id,
               contract_address, priority, metadata, next_retry_at
        FROM scheduled_notifications_backup
    `);
    await db.run('DROP TABLE IF EXISTS scheduled_notifications_backup');
  },
};

export default migration;
