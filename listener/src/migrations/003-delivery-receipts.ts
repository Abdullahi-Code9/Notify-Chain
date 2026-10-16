import * as sqlite3 from 'sqlite3';

const migration = {
  id: '003',
  name: 'delivery-receipts',
  up: async (db: sqlite3.Database) => {
    await db.run(`
      CREATE TABLE IF NOT EXISTS delivery_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notification_id INTEGER NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'rejected', 'pending')),
        attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
        provider_message_id TEXT,
        provider_response TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_delivery_receipts_notification_attempt
        ON delivery_receipts(notification_id, attempt_count, id)
    `);
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_delivery_receipts_status_created
        ON delivery_receipts(status, created_at)
    `);
  },
  down: async (db: sqlite3.Database) => {
    await db.run('DROP INDEX IF EXISTS idx_delivery_receipts_status_created');
    await db.run('DROP INDEX IF EXISTS idx_delivery_receipts_notification_attempt');
    await db.run('DROP TABLE IF EXISTS delivery_receipts');
  },
};

export default migration;
