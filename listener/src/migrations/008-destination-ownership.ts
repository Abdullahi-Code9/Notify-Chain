import * as sqlite3 from 'sqlite3';

/**
 * Default fallback owner assigned to legacy destination records that predate
 * explicit ownership tracking. Isolated under the `legacy:` namespace so no
 * regular user credential (`credential:<id>` / `legacy:<hash>`) can claim it
 * implicitly without an explicit administrative migration step.
 */
export const DEFAULT_LEGACY_DESTINATION_OWNER_ID = 'legacy:unassigned';

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

function get<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row as T | undefined)));
  });
}

function all<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows as T[])));
  });
}

async function tableExists(db: sqlite3.Database, name: string): Promise<boolean> {
  const row = await get<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  );
  return Boolean(row);
}

async function getColumns(db: sqlite3.Database, table: string): Promise<string[]> {
  const rows = await all<{ name: string }>(db, `PRAGMA table_info(${table})`);
  return rows.map((row) => row.name);
}

export function resolveLegacyDestinationOwnerId(): string {
  const configured = process.env.LEGACY_DESTINATION_OWNER_ID?.trim();
  if (configured) {
    return configured;
  }
  return DEFAULT_LEGACY_DESTINATION_OWNER_ID;
}

const CREATE_DESTINATIONS_INDEXES_AND_TRIGGER = [
  'CREATE INDEX IF NOT EXISTS idx_destinations_owner_id ON destinations(owner_id)',
  'CREATE INDEX IF NOT EXISTS idx_destinations_owner_provider ON destinations(owner_id, provider)',
  'CREATE INDEX IF NOT EXISTS idx_destinations_owner_created ON destinations(owner_id, created_at)',
  `CREATE TRIGGER IF NOT EXISTS update_destinations_timestamp
   AFTER UPDATE ON destinations
   FOR EACH ROW
   BEGIN
     UPDATE destinations
     SET updated_at = CURRENT_TIMESTAMP
     WHERE id = NEW.id;
   END`,
];

/**
 * Safely migrates existing destination records to enforce explicit ownership
 * (`owner_id NOT NULL`), preserving all configuration, secrets, and timestamps.
 *
 * Strategy:
 * 1. Fresh DB (no `destinations` table): creates `destinations` with strict
 *    non-empty `owner_id` constraint and indexes.
 * 2. Legacy `destinations` table missing `owner_id`: rebuilds the table into
 *    the ownership-enforced schema, preserving every row. Any existing
 *    `user_id` or `account_id` column is mapped into `owner_id`; rows without
 *    a valid owner receive `resolveLegacyDestinationOwnerId()` (`legacy:unassigned`
 *    by default) so they remain quarantined from arbitrary user accounts.
 * 3. `destinations` table already has `owner_id`: safely backfills any NULL
 *    or whitespace-only `owner_id` values and ensures ownership indexes exist.
 * 4. Creates `scheduled_notification_destinations` when `scheduled_notifications`
 *    is present so scheduled notification references stay bound to their owner.
 */
export async function applyDestinationOwnershipMigration(
  db: sqlite3.Database,
  legacyOwnerId: string = resolveLegacyDestinationOwnerId(),
): Promise<{ migratedLegacyRows: number }> {
  const normalizedFallback = legacyOwnerId.trim();
  if (!normalizedFallback) {
    throw new Error('Legacy destination fallback ownerId must be a non-empty string');
  }

  let migratedLegacyRows = 0;

  if (!(await tableExists(db, 'destinations'))) {
    await run(
      db,
      `CREATE TABLE IF NOT EXISTS destinations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL CHECK (LENGTH(TRIM(owner_id)) > 0),
        provider TEXT NOT NULL CHECK (provider IN ('webhook', 'discord', 'email', 'telegram')),
        display_name TEXT NOT NULL CHECK (LENGTH(TRIM(display_name)) > 0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'not_configured' CHECK (status IN ('connected', 'not_configured', 'error', 'disabled')),
        settings_json TEXT NOT NULL DEFAULT '{}',
        secrets_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        last_tested_at INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
  } else {
    const columns = await getColumns(db, 'destinations');
    const hasOwnerId = columns.includes('owner_id');

    if (!hasOwnerId) {
      const legacyOwnerExpr = columns.includes('user_id')
        ? "COALESCE(NULLIF(TRIM(user_id), ''), ?)"
        : columns.includes('account_id')
          ? "COALESCE(NULLIF(TRIM(account_id), ''), ?)"
          : '?';

      const countRow = await get<{ count: number }>(
        db,
        columns.includes('user_id')
          ? 'SELECT COUNT(*) AS count FROM destinations WHERE user_id IS NULL OR LENGTH(TRIM(user_id)) = 0'
          : columns.includes('account_id')
            ? 'SELECT COUNT(*) AS count FROM destinations WHERE account_id IS NULL OR LENGTH(TRIM(account_id)) = 0'
            : 'SELECT COUNT(*) AS count FROM destinations',
      );
      migratedLegacyRows = countRow?.count ?? 0;

      const displayNameExpr = columns.includes('display_name')
        ? "COALESCE(NULLIF(TRIM(display_name), ''), provider)"
        : 'provider';
      const enabledExpr = columns.includes('enabled') ? 'COALESCE(enabled, 1)' : '1';
      const statusExpr = columns.includes('status')
        ? "COALESCE(NULLIF(TRIM(status), ''), 'not_configured')"
        : "'not_configured'";
      const settingsExpr = columns.includes('settings_json')
        ? "COALESCE(settings_json, '{}')"
        : columns.includes('settings')
          ? "COALESCE(settings, '{}')"
          : "'{}'";
      const secretsExpr = columns.includes('secrets_json')
        ? "COALESCE(secrets_json, '{}')"
        : columns.includes('secrets')
          ? "COALESCE(secrets, '{}')"
          : "'{}'";
      const lastErrorExpr = columns.includes('last_error') ? 'last_error' : 'NULL';
      const lastTestedExpr = columns.includes('last_tested_at') ? 'last_tested_at' : 'NULL';
      const createdAtExpr = columns.includes('created_at')
        ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
        : 'CURRENT_TIMESTAMP';
      const updatedAtExpr = columns.includes('updated_at')
        ? 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
        : 'CURRENT_TIMESTAMP';

      await run(
        db,
        `CREATE TABLE destinations_v008 (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL CHECK (LENGTH(TRIM(owner_id)) > 0),
          provider TEXT NOT NULL CHECK (provider IN ('webhook', 'discord', 'email', 'telegram')),
          display_name TEXT NOT NULL CHECK (LENGTH(TRIM(display_name)) > 0),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          status TEXT NOT NULL DEFAULT 'not_configured' CHECK (status IN ('connected', 'not_configured', 'error', 'disabled')),
          settings_json TEXT NOT NULL DEFAULT '{}',
          secrets_json TEXT NOT NULL DEFAULT '{}',
          last_error TEXT,
          last_tested_at INTEGER,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
      );

      await run(
        db,
        `INSERT INTO destinations_v008 (
          id, owner_id, provider, display_name, enabled, status,
          settings_json, secrets_json, last_error, last_tested_at, created_at, updated_at
        )
        SELECT
          id,
          ${legacyOwnerExpr},
          provider,
          ${displayNameExpr},
          ${enabledExpr},
          ${statusExpr},
          ${settingsExpr},
          ${secretsExpr},
          ${lastErrorExpr},
          ${lastTestedExpr},
          ${createdAtExpr},
          ${updatedAtExpr}
        FROM destinations`,
        [normalizedFallback],
      );

      await run(db, 'DROP TABLE destinations');
      await run(db, 'ALTER TABLE destinations_v008 RENAME TO destinations');
    } else {
      const missingCount = await get<{ count: number }>(
        db,
        'SELECT COUNT(*) AS count FROM destinations WHERE owner_id IS NULL OR LENGTH(TRIM(owner_id)) = 0',
      );
      migratedLegacyRows = missingCount?.count ?? 0;

      if (migratedLegacyRows > 0) {
        await run(
          db,
          'UPDATE destinations SET owner_id = ? WHERE owner_id IS NULL OR LENGTH(TRIM(owner_id)) = 0',
          [normalizedFallback],
        );
      }
    }
  }

  for (const stmt of CREATE_DESTINATIONS_INDEXES_AND_TRIGGER) {
    await run(db, stmt);
  }

  if (await tableExists(db, 'scheduled_notifications')) {
    await run(
      db,
      `CREATE TABLE IF NOT EXISTS scheduled_notification_destinations (
        scheduled_notification_id INTEGER PRIMARY KEY,
        destination_id TEXT,
        owner_id TEXT NOT NULL CHECK (LENGTH(TRIM(owner_id)) > 0),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (scheduled_notification_id) REFERENCES scheduled_notifications(id) ON DELETE CASCADE,
        FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE SET NULL
      )`,
    );
    await run(
      db,
      'CREATE INDEX IF NOT EXISTS idx_sched_dest_destination_id ON scheduled_notification_destinations(destination_id) WHERE destination_id IS NOT NULL',
    );
    await run(
      db,
      'CREATE INDEX IF NOT EXISTS idx_sched_dest_owner_id ON scheduled_notification_destinations(owner_id)',
    );
  }

  return { migratedLegacyRows };
}

const migration = {
  id: '008',
  name: 'destination-ownership',
  up: async (db: sqlite3.Database) => {
    await applyDestinationOwnershipMigration(db);
  },
  down: async (db: sqlite3.Database) => {
    await run(db, 'DROP INDEX IF EXISTS idx_sched_dest_owner_id');
    await run(db, 'DROP INDEX IF EXISTS idx_sched_dest_destination_id');
    await run(db, 'DROP TABLE IF EXISTS scheduled_notification_destinations');
    await run(db, 'DROP TRIGGER IF EXISTS update_destinations_timestamp');
    await run(db, 'DROP INDEX IF EXISTS idx_destinations_owner_created');
    await run(db, 'DROP INDEX IF EXISTS idx_destinations_owner_provider');
    await run(db, 'DROP INDEX IF EXISTS idx_destinations_owner_id');
    await run(db, 'DROP TABLE IF EXISTS destinations');
  },
};

export default migration;
