#!/usr/bin/env ts-node
/**
 * Database migration script
 * Run this to initialize or update the database schema
 * 
 * Usage:
 *   npm run migrate
 *   or
 *   ts-node src/scripts/migrate-db.ts
 */

import { Database } from '../database/database';
import { MigrationRunner } from '../database/migration-system';
import logger from '../utils/logger';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

async function migrate() {
  try {
    logger.info('Starting database migration...');

    const dbPath = process.env.DATABASE_PATH || './data/notifications.db';
    const migrationsDir = path.join(__dirname, '../migrations');
    
    const db = new Database(dbPath);
    await db.initialize();
    
    // @ts-ignore - Accessing private db property to pass to MigrationRunner
    const sqliteDb = db['db'] as any;
    
    const runner = new MigrationRunner(sqliteDb, migrationsDir);
    // Destructive migrations (table rebuilds that drop data) refuse to run
    // unless explicitly opted in after a verified backup - see docs/migration-rollback.md.
    const allowDestructive = /^(1|true|yes)$/i.test(process.env.ALLOW_DESTRUCTIVE_MIGRATIONS || '');
    await runner.runMigrations({ allowDestructive });

    logger.info('Database migration completed successfully', { dbPath });

    await db.close();
    process.exit(0);
  } catch (error) {
    logger.error('Database migration failed', { error });
    process.exit(1);
  }
}

migrate();
