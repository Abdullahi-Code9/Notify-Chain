/**
 * Migration System
 * 
 * A custom SQLite database migration system for the Notify-Chain listener.
 * 
 * Features:
 * - Tracks applied migrations in a `migrations` table
 * - Atomic migrations using transactions (rolls back on failure)
 * - Loads migrations from a specified directory
 * - Applies pending migrations in order
 * 
 * Migration file structure:
 * Each migration should export a default object with:
 * - id: Unique identifier (e.g., "001")
 * - name: Human-readable name (e.g., "initial-schema")
 * - up(db): Function to apply the migration
 * - down(db): Function to roll back the migration (optional)
 *
 * Rollback strategy: see docs/migration-rollback.md. Migrations that cannot be
 * reversed (table rebuilds that drop columns/constraints) expose a `down` that
 * throws, so rolling them back fails loudly instead of silently losing data;
 * the documented recovery path for those is restoring a backup.
 */
import * as sqlite3 from 'sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../utils/logger';

export interface Migration {
  id: string;
  name: string;
  up: (db: sqlite3.Database) => Promise<void>;
  down: (db: sqlite3.Database) => Promise<void>;
  /**
   * Optional guard evaluated before `up` runs. Throwing aborts the migration.
   * Used to require an explicit opt-in (e.g. a verified pre-migration backup)
   * for migrations flagged as destructive.
   */
  precheck?: (db: sqlite3.Database) => Promise<void> | void;
  /**
   * True when the migration drops or narrows data and therefore cannot be
   * reversed by running `down`. Such migrations are only applied when the
   * caller opts in explicitly (see `runMigrations({ allowDestructive })`).
   */
  destructive?: boolean;
}

export class MigrationRunner {
  private db: sqlite3.Database;
  private migrationsDir: string;

  constructor(db: sqlite3.Database, migrationsDir: string) {
    this.db = db;
    this.migrationsDir = migrationsDir;
  }

  private run(sql: string, params: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (error) => (error ? reject(error) : resolve()));
    });
  }

  private all<T>(sql: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, (error, rows) => (error ? reject(error) : resolve(rows as T[])));
    });
  }

  private async ensureForeignKeysEnabled(): Promise<void> {
    const current = await new Promise<number>((resolve, reject) => {
      this.db.get('PRAGMA foreign_keys', (error, row: { foreign_keys: number }) => {
        if (error) reject(error);
        else resolve(row.foreign_keys);
      });
    });

    if (current !== 1) {
      await new Promise<void>((resolve, reject) => {
        this.db.run('PRAGMA foreign_keys = ON', (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    const verified = await new Promise<number>((resolve, reject) => {
      this.db.get('PRAGMA foreign_keys', (error, row: { foreign_keys: number }) => {
        if (error) reject(error);
        else resolve(row.foreign_keys);
      });
    });
    if (verified !== 1) {
      throw new Error('SQLite foreign key enforcement could not be enabled');
    }
  }

  async initializeMigrationTable(): Promise<void> {
    await this.ensureForeignKeysEnabled();
    await this.run(`
      CREATE TABLE IF NOT EXISTS migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async getAppliedMigrations(): Promise<string[]> {
    const rows = await this.all<{ id: string }>('SELECT id FROM migrations ORDER BY applied_at');
    return rows.map((row) => row.id);
  }

  async applyMigration(migration: Migration): Promise<void> {
    await this.ensureForeignKeysEnabled();
    if (migration.precheck) {
      await migration.precheck(this.db);
    }
    await this.run('BEGIN TRANSACTION');
    try {
      await migration.up(this.db);
      await this.run('INSERT INTO migrations (id, name) VALUES (?, ?)', [migration.id, migration.name]);
      await this.run('COMMIT');
      logger.info(`Migration ${migration.id} (${migration.name}) applied successfully`);
    } catch (error) {
      try {
        await this.run('ROLLBACK');
      } catch (rollbackError) {
        logger.error(`Migration ${migration.id} rollback failed`, { error: rollbackError });
      }
      logger.error(`Migration ${migration.id} failed, rolling back`, { error });
      throw error;
    }
  }

  /**
   * Roll back the most recently applied migration by invoking its `down`.
   * The `migrations` row is deleted and the change runs in a transaction, so a
   * failing `down` leaves the database and the ledger untouched.
   *
   * Throws (without touching the database) when the migration is destructive
   * (its `down` cannot faithfully reverse the change) - restore a backup
   * instead. See docs/migration-rollback.md.
   */
  async rollbackLastMigration(): Promise<Migration | null> {
    await this.initializeMigrationTable();
    const rows = await this.all<{ id: string; name: string }>(
      'SELECT id, name FROM migrations ORDER BY applied_at DESC, rowid DESC LIMIT 1',
    );
    if (rows.length === 0) {
      logger.info('No applied migrations to roll back');
      return null;
    }

    const { id, name } = rows[0];
    const migration = (await this.loadMigrations()).find((m) => m.id === id);
    if (!migration) {
      throw new Error(
        `Cannot roll back migration ${id} (${name}): no matching migration file found. ` +
          'Restore a backup or recreate the migration file before retrying.',
      );
    }
    if (migration.destructive) {
      throw new Error(
        `Migration ${id} (${name}) is marked destructive and cannot be reversed by rollback. ` +
          'Restore the verified pre-migration backup instead - see docs/migration-rollback.md.',
      );
    }

    await this.ensureForeignKeysEnabled();
    await this.run('BEGIN TRANSACTION');
    try {
      await migration.down(this.db);
      await this.run('DELETE FROM migrations WHERE id = ?', [id]);
      await this.run('COMMIT');
      logger.info(`Migration ${id} (${name}) rolled back successfully`);
      return migration;
    } catch (error) {
      try {
        await this.run('ROLLBACK');
      } catch (rollbackError) {
        logger.error(`Rollback of migration ${id} failed to revert cleanly`, { error: rollbackError });
      }
      logger.error(`Rollback of migration ${id} failed`, { error });
      throw error;
    }
  }

  async loadMigrations(): Promise<Migration[]> {
    const files = fs.readdirSync(this.migrationsDir).sort();
    const migrations: Migration[] = [];

    for (const file of files) {
      // Colocated test files (*.test.ts) share this directory; importing them
      // would execute test globals (describe/it) outside a test runner.
      if (file.includes('.test.')) continue;
      if (file.endsWith('.ts') || file.endsWith('.js')) {
        const migrationPath = path.join(this.migrationsDir, file);
        const module = await import(migrationPath);
        if (module.default && typeof module.default.up === 'function') {
          migrations.push(module.default);
        }
      }
    }

    return migrations;
  }

  async getPendingMigrations(): Promise<Migration[]> {
    const appliedMigrations = await this.getAppliedMigrations();
    const allMigrations = await this.loadMigrations();
    this.assertUniqueIds(allMigrations);
    return allMigrations.filter(
      (migration) => !appliedMigrations.includes(migration.id)
    );
  }

  /**
   * A replicated migration `id` makes the ledger ambiguous: once one file with
   * a given id is recorded, the others sharing that id are silently skipped.
   * Fail fast so the collision is fixed at author time instead of causing a
   * migration to never run in production.
   */
  private assertUniqueIds(migrations: Migration[]): void {
    const seen = new Map<string, string>();
    for (const migration of migrations) {
      const existing = seen.get(migration.id);
      if (existing) {
        throw new Error(
          `Duplicate migration id "${migration.id}" detected: "${existing}" and "${migration.name}". ` +
            'Every migration must use a unique id (see docs/migration-rollback.md).',
        );
      }
      seen.set(migration.id, migration.name);
    }
  }

  async runMigrations(options: { allowDestructive?: boolean } = {}): Promise<void> {
    await this.initializeMigrationTable();
    const pendingMigrations = await this.getPendingMigrations();

    if (pendingMigrations.length === 0) {
      logger.info('No pending migrations to apply');
      return;
    }

    const destructivePending = pendingMigrations.filter((m) => m.destructive);
    if (destructivePending.length > 0 && !options.allowDestructive) {
      const ids = destructivePending.map((m) => `${m.id} (${m.name})`).join(', ');
      throw new Error(
        `Refusing to apply ${destructivePending.length} destructive migration(s) without an explicit ` +
          `opt-in: ${ids}. Destructive migrations cannot be rolled back, so take and verify a ` +
          'pre-migration backup and re-run with ALLOW_DESTRUCTIVE_MIGRATIONS=true. ' +
          'See docs/migration-rollback.md.',
      );
    }

    logger.info(`Applying ${pendingMigrations.length} pending migrations...`);
    for (const migration of pendingMigrations) {
      await this.applyMigration(migration);
    }
    logger.info('All migrations applied successfully');
  }
}
