/**
 * Migration 008 — event integrity constraints (issue #1121).
 *
 * Adds database-level guarantees for event data:
 *   - UNIQUE (contract_address, event_id) on processed_events, so the same
 *     on-chain event can never be recorded twice even if a writer bypasses
 *     the fingerprint column.
 *   - event_processing_timings (issue #1120), a child of processed_events
 *     with a FOREIGN KEY (ON DELETE CASCADE) and one row per event.
 *   - api_idempotency_keys (issue #1114), UNIQUE (scope, idempotency_key).
 *
 * Safety:
 *   - Purely additive: no table is rebuilt and no row is modified or deleted.
 *   - Existing data is audited first. If processed_events already holds
 *     duplicate (contract_address, event_id) rows the migration aborts and
 *     names the count, leaving every row in place for an operator to resolve.
 *   - The runner executes `up` inside a transaction, so any failure rolls the
 *     whole migration back.
 *   - Idempotent: every statement is IF NOT EXISTS, so databases bootstrapped
 *     from schema.sql (which already contains these objects) are unaffected.
 */
import * as sqlite3 from 'sqlite3';

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

function getCount(db: sqlite3.Database, sql: string): Promise<number> {
  return new Promise((resolve, reject) => {
    db.get(sql, (error, row: { count: number } | undefined) => {
      if (error) reject(error);
      else resolve(row?.count ?? 0);
    });
  });
}

function getRows(db: sqlite3.Database, sql: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (error, rows) => (error ? reject(error) : resolve(rows)));
  });
}

async function tableExists(db: sqlite3.Database, table: string): Promise<boolean> {
  const count = await getCount(
    db,
    `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
  );
  return count > 0;
}

export const DUPLICATE_PROCESSED_EVENTS_SQL = `SELECT COUNT(*) AS count FROM (
  SELECT 1 FROM processed_events
  GROUP BY contract_address, event_id HAVING COUNT(*) > 1
)`;

const migration = {
  id: '008',
  name: 'event-integrity-constraints',
  up: async (db: sqlite3.Database) => {
    if (!(await tableExists(db, 'processed_events'))) {
      throw new Error('Migration 008 requires the processed_events table');
    }

    const duplicates = await getCount(db, DUPLICATE_PROCESSED_EVENTS_SQL);
    if (duplicates > 0) {
      throw new Error(
        `Migration 008 aborted: processed_events has ${duplicates} duplicate (contract_address, event_id) group(s). ` +
          'Resolve them (keep one row per event) and re-run; no data was changed.',
      );
    }

    await run(
      db,
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_processed_events_contract_event
         ON processed_events(contract_address, event_id)`,
    );

    await run(
      db,
      `CREATE TABLE IF NOT EXISTS event_processing_timings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        processed_event_id INTEGER NOT NULL UNIQUE,
        retrieval_ms REAL CHECK (retrieval_ms IS NULL OR retrieval_ms >= 0),
        decode_validation_ms REAL CHECK (decode_validation_ms IS NULL OR decode_validation_ms >= 0),
        persistence_ms REAL CHECK (persistence_ms IS NULL OR persistence_ms >= 0),
        notification_prep_ms REAL CHECK (notification_prep_ms IS NULL OR notification_prep_ms >= 0),
        total_ms REAL CHECK (total_ms IS NULL OR total_ms >= 0),
        outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('processed', 'duplicate', 'skipped', 'error')),
        recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (processed_event_id) REFERENCES processed_events(id) ON DELETE CASCADE
      )`,
    );
    await run(
      db,
      `CREATE INDEX IF NOT EXISTS idx_event_processing_timings_recorded_at
         ON event_processing_timings(recorded_at)`,
    );

    await run(
      db,
      `CREATE TABLE IF NOT EXISTS api_idempotency_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        status VARCHAR(20) NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
        response_status INTEGER CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
        response_body TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        UNIQUE (scope, idempotency_key),
        CHECK (status = 'IN_PROGRESS' OR (response_status IS NOT NULL AND response_body IS NOT NULL))
      )`,
    );
    await run(
      db,
      `CREATE INDEX IF NOT EXISTS idx_api_idempotency_keys_expires_at
         ON api_idempotency_keys(expires_at)`,
    );

    // Scoped to the table this migration owns, so unrelated legacy data
    // cannot block it.
    const foreignKeyViolations = await getRows(db, 'PRAGMA foreign_key_check(event_processing_timings)');
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `Migration 008 detected ${foreignKeyViolations.length} foreign-key violation(s)`,
      );
    }
  },
  down: async (db: sqlite3.Database) => {
    // Only objects this migration created are removed; processed_events rows
    // are untouched. Timing and idempotency records are diagnostic/cache data.
    await run(db, 'DROP INDEX IF EXISTS idx_api_idempotency_keys_expires_at');
    await run(db, 'DROP TABLE IF EXISTS api_idempotency_keys');
    await run(db, 'DROP INDEX IF EXISTS idx_event_processing_timings_recorded_at');
    await run(db, 'DROP TABLE IF EXISTS event_processing_timings');
    await run(db, 'DROP INDEX IF EXISTS ux_processed_events_contract_event');
  },
};

export default migration;
