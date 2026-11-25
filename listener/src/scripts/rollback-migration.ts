#!/usr/bin/env ts-node
/**
 * Database migration rollback script.
 *
 * Rolls back the most recently applied migration by running its `down` in a
 * transaction. Destructive migrations (table rebuilds that drop columns or
 * constraints) cannot be reversed this way and abort with guidance to restore a
 * backup instead - see docs/migration-rollback.md.
 *
 * Usage:
 *   npm run rollback                 # roll back one migration
 *   npm run rollback -- --dry-run    # show what would be rolled back, change nothing
 *   npm run rollback -- --steps 2    # roll back the last two migrations
 *   or
 *   ts-node src/scripts/rollback-migration.ts [--dry-run] [--steps N]
 */

import { Database } from '../database/database';
import { MigrationRunner } from '../database/migration-system';
import logger from '../utils/logger';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

interface Options {
  dryRun: boolean;
  steps: number;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { dryRun: false, steps: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--steps') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--steps expects a positive integer, received "${argv[i + 1]}"`);
      }
      options.steps = value;
      i++;
    } else if (arg.startsWith('--steps=')) {
      const value = Number(arg.slice('--steps='.length));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--steps expects a positive integer, received "${arg}"`);
      }
      options.steps = value;
    } else {
      throw new Error(`Unknown argument "${arg}". Supported: --dry-run, --steps <n>.`);
    }
  }
  return options;
}

async function rollback(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const dbPath = process.env.DATABASE_PATH || './data/notifications.db';
  const migrationsDir = path.join(__dirname, '../migrations');

  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    await db.initialize();
    // @ts-ignore - Accessing private db property to pass to MigrationRunner
    const sqliteDb = db['db'] as any;
    const runner = new MigrationRunner(sqliteDb, migrationsDir);

    const applied = await runner.getAppliedMigrations();
    if (applied.length === 0) {
      logger.info('No applied migrations to roll back', { dbPath });
      await db.close();
      process.exit(0);
    }

    if (options.dryRun) {
      logger.info(`Dry run: ${Math.min(options.steps, applied.length)} migration(s) would be rolled back`, {
        dbPath,
        mostRecent: applied[applied.length - 1],
      });
      logger.info(`Applied migration order: ${applied.join(', ')}`);
      await db.close();
      process.exit(0);
    }

    for (let step = 0; step < options.steps; step++) {
      const rolledBack = await runner.rollbackLastMigration();
      if (!rolledBack) {
        logger.info('No more migrations to roll back');
        break;
      }
    }

    logger.info('Rollback completed successfully', { dbPath });
    await db.close();
    process.exit(0);
  } catch (error) {
    logger.error('Migration rollback failed', { error });
    if (db) {
      try {
        await db.close();
      } catch {
        // best-effort cleanup
      }
    }
    process.exit(1);
  }
}

rollback();
