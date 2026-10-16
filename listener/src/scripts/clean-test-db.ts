#!/usr/bin/env ts-node
/**
 * Test Database Teardown Script (#859)
 *
 * Removes the test database to ensure a clean state after test runs.
 *
 * Usage:
 *   ts-node src/scripts/clean-test-db.ts
 *   npm run db:test:clean
 */

import * as dotenv from 'dotenv';
import { cleanTestDatabase } from '../test-utils/test-db-environment';

dotenv.config();

async function main(): Promise<void> {
  const dbPath =
    process.env.TEST_DATABASE_PATH ||
    process.env.DATABASE_PATH ||
    './data/test-notifications.db';

  console.log(`[CI TEST DB] Cleaning up test database environment at: ${dbPath}`);

  try {
    await cleanTestDatabase(undefined, dbPath);
    console.log(`[CI TEST DB] Cleaned up test database successfully.`);
    process.exit(0);
  } catch (error) {
    console.error('[CI TEST DB] Error cleaning up test database:', error);
    process.exit(1);
  }
}

void main();
