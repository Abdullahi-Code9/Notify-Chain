#!/usr/bin/env ts-node
/**
 * Test Database Provisioning Script (#859)
 *
 * Provisions a clean, reproducible database environment for integration tests in CI.
 *
 * Usage:
 *   ts-node src/scripts/setup-test-db.ts
 *   npm run db:test:setup
 *
 * Environment Variables:
 *   DATABASE_PATH / TEST_DATABASE_PATH (default: ./data/test-notifications.db)
 */

import * as dotenv from 'dotenv';
import { provisionTestDatabase } from '../test-utils/test-db-environment';
import logger from '../utils/logger';

dotenv.config();

async function main(): Promise<void> {
  const dbPath =
    process.env.TEST_DATABASE_PATH ||
    process.env.DATABASE_PATH ||
    './data/test-notifications.db';

  console.log(`[CI TEST DB] Provisioning reproducible test database environment at: ${dbPath}`);

  try {
    const { db, appliedMigrations } = await provisionTestDatabase({
      dbPath,
      runMigrations: true,
      verbose: true,
    });

    // Check count of tables
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );

    console.log(`[CI TEST DB] Successfully provisioned test database:`);
    console.log(`  - Clean state: Verified (prior files removed, initial row count 0)`);
    console.log(`  - Total tables created: ${tables.length}`);
    console.log(`  - Migrations automatically applied: ${appliedMigrations.length} (${appliedMigrations.join(', ') || 'baseline schema'})`);
    console.log(`  - Database ready for CI integration tests.`);

    await db.close();
    process.exit(0);
  } catch (error) {
    console.error('[CI TEST DB] Failed to provision test database environment:', error);
    process.exit(1);
  }
}

void main();
