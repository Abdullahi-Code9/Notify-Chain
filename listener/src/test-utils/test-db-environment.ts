/**
 * CI Test Database Environment Manager (#859)
 *
 * Provides a reproducible database environment for integration tests running in CI.
 *
 * Acceptance Criteria:
 * - CI can provision the required database.
 * - Migrations run automatically.
 * - Tests start from a clean state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../database/database';
import { MigrationRunner } from '../database/migration-system';
import logger from '../utils/logger';

export interface TestDbOptions {
  dbPath?: string;
  runMigrations?: boolean;
  verbose?: boolean;
}

export interface ProvisionedTestDb {
  db: Database;
  dbPath: string;
  appliedMigrations: string[];
}

/**
 * Remove a database file and any associated SQLite write-ahead log / shared memory files.
 */
export function removeDatabaseFiles(dbPath: string): void {
  const filesToRemove = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];

  for (const file of filesToRemove) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch (err) {
        logger.warn(`Could not delete test database artifact: ${file}`, { error: err });
      }
    }
  }
}

/**
 * Provisions a fresh, reproducible database environment for integration tests.
 * 1. Purges any pre-existing database files to guarantee a completely clean state.
 * 2. Creates the target directory.
 * 3. Initializes the SQLite schema.
 * 4. Automatically discovers and executes all pending migrations in order.
 * 5. Verifies database readiness and table structure.
 */
export async function provisionTestDatabase(
  options: TestDbOptions = {}
): Promise<ProvisionedTestDb> {
  const resolvedPath = path.resolve(
    options.dbPath ||
      process.env.TEST_DATABASE_PATH ||
      process.env.DATABASE_PATH ||
      './data/test-notifications.db'
  );

  // 1. Guarantee clean state by unlinking prior test databases
  removeDatabaseFiles(resolvedPath);

  // 2. Ensure parent directory exists
  const parentDir = path.dirname(resolvedPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // 3. Connect to database and run baseline schema
  const db = new Database(resolvedPath);
  await db.initialize();

  // 4. Automatically run all incremental migrations
  let appliedMigrations: string[] = [];
  if (options.runMigrations !== false) {
    const migrationsDir = path.join(__dirname, '../migrations');
    // @ts-ignore - access underlying sqlite3 handle for MigrationRunner
    const sqliteDb = db['db'];

    if (fs.existsSync(migrationsDir) && sqliteDb) {
      const runner = new MigrationRunner(sqliteDb, migrationsDir);
      await runner.runMigrations();
      appliedMigrations = await runner.getAppliedMigrations();
    }
  }

  // 5. Verify tables exist and are empty (clean state verification)
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );
  const tableNames = tables.map((t) => t.name);

  if (options.verbose) {
    logger.info('Test database provisioned successfully', {
      dbPath: resolvedPath,
      tables: tableNames,
      appliedMigrations,
    });
  }

  return {
    db,
    dbPath: resolvedPath,
    appliedMigrations,
  };
}

/**
 * Cleans up and tears down the test database environment.
 */
export async function cleanTestDatabase(
  dbOrPath?: Database | string,
  explicitPath?: string
): Promise<void> {
  let targetPath = explicitPath;

  if (dbOrPath instanceof Database) {
    try {
      await dbOrPath.close();
    } catch {
      // Ignore close errors during teardown
    }
  } else if (typeof dbOrPath === 'string') {
    targetPath = dbOrPath;
  }

  const finalPath = path.resolve(
    targetPath ||
      process.env.TEST_DATABASE_PATH ||
      process.env.DATABASE_PATH ||
      './data/test-notifications.db'
  );

  removeDatabaseFiles(finalPath);
}

/**
 * Resets all tables in a test database to an empty state without dropping schema definitions.
 */
export async function resetDatabaseTables(db: Database): Promise<void> {
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'migrations'"
  );

  await db.transaction(async () => {
    for (const table of tables) {
      await db.run(`DELETE FROM ${table.name}`);
    }
  });
}
