import * as sqlite3 from 'sqlite3';

/**
 * Migration 003 — Event & notification query indexes
 *
 * Targets hot queries that migration 002 left doing a full scan or a
 * temp-B-tree sort (see docs/DATABASE_QUERY_PERFORMANCE.md for plans and
 * before/after timings):
 * - archival / retention cleanup of terminal notifications
 * - notification search filtered by LOWER(notification_type)
 * - processed-event search filtered by LOWER(event_type)
 *
 * All statements are additive (CREATE INDEX IF NOT EXISTS) so existing
 * queries, rows and schema behaviour are unchanged.
 */

const INDEXES: Array<{ name: string; sql: string }> = [
  {
    // archive-service.ts / cleanup-service.ts:
    //   WHERE status IN ('COMPLETED','FAILED','CANCELLED')
    //     AND processing_completed_at < ? ORDER BY processing_completed_at
    name: 'idx_scheduled_notifications_archivable',
    sql: `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_archivable
            ON scheduled_notifications(processing_completed_at)
            WHERE status IN ('COMPLETED','FAILED','CANCELLED')`,
  },
  {
    // notification-search-service.ts:
    //   WHERE LOWER(notification_type) = ? ORDER BY created_at DESC
    name: 'idx_scheduled_notifications_type_lower_created',
    sql: `CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_type_lower_created
            ON scheduled_notifications(LOWER(notification_type), created_at)`,
  },
  {
    // notification-search-service.ts:
    //   WHERE LOWER(event_type) = ? ORDER BY processed_at DESC
    name: 'idx_processed_events_type_lower_processed',
    sql: `CREATE INDEX IF NOT EXISTS idx_processed_events_type_lower_processed
            ON processed_events(LOWER(event_type), processed_at)`,
  },
];

function run(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

const migration = {
  id: '003',
  name: 'event-notification-query-indexes',
  indexNames: INDEXES.map((i) => i.name),
  up: async (db: sqlite3.Database) => {
    for (const index of INDEXES) {
      await run(db, index.sql);
    }
  },
  down: async (db: sqlite3.Database) => {
    for (const index of INDEXES) {
      await run(db, `DROP INDEX IF EXISTS ${index.name}`);
    }
  },
};

export default migration;
