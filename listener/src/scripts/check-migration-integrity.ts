#!/usr/bin/env ts-node
/**
 * Migration integrity check (run in CI).
 */

import * as path from 'path';
import { Database } from '../database/database';
import { MigrationRunner, Migration } from '../database/migration-system';

interface CheckResult {
  passed: boolean;
  failures: string[];
}

const migrationsDir = path.join(__dirname, '../migrations');

async function freshDatabase(): Promise<{ db: Database; runner: MigrationRunner }> {
  const db = new Database(':memory:');
  await db.initialize();
  // @ts-ignore
  const runner = new MigrationRunner(db['db'] as any, migrationsDir);
  await runner.initializeMigrationTable();
  return { db, runner };
}

async function main(): Promise<void> {
  const result: CheckResult = { passed: true, failures: [] };

  const { db: loadDb, runner: loadRunner } = await freshDatabase();
  let migrations: Migration[];
  try {
    migrations = await loadRunner.loadMigrations();
  } catch (error) {
    console.error('❌ Failed to load migrations:', error);
    await loadDb.close();
    process.exit(1);
  }
  await loadDb.close();

  console.log(`Loaded ${migrations.length} migration file(s): ${migrations.map((m) => m.id).join(', ')}\n`);

  const nameById = new Map<string, string>();
  for (const migration of migrations) {
    if (typeof migration.up !== 'function') result.failures.push(`${migration.id} (${migration.name}): missing up()`);
    if (typeof migration.down !== 'function') result.failures.push(`${migration.id} (${migration.name}): missing down()`);
    if (nameById.has(migration.id)) {
      result.failures.push(`duplicate migration id "${migration.id}": "${nameById.get(migration.id)}" and "${migration.name}"`);
    } else {
      nameById.set(migration.id, migration.name);
    }
  }

  // Full set applies with explicit opt-in (scratch DB).
  const full = await freshDatabase();
  try {
    await full.runner.runMigrations({ allowDestructive: true });
    const pending = await full.runner.getPendingMigrations();
    if (pending.length !== 0) {
      result.failures.push(`after full apply, ${pending.length} pending migration(s) remain`);
    }
    await full.runner.runMigrations({ allowDestructive: true });
    console.log('Full migration set applied cleanly and is idempotent');
  } catch (error) {
    result.failures.push(`full apply failed: ${(error as Error).message}`);
  } finally {
    await full.db.close();
  }

  // Destructive guard works without opt-in on a fresh DB that has pending destructive migrations.
  const guarded = await freshDatabase();
  try {
    await guarded.runner.runMigrations({});
    result.failures.push('destructive migrations applied without ALLOW_DESTRUCTIVE_MIGRATIONS');
  } catch (error) {
    if ((error as Error).message.includes('destructive')) {
      console.log('Destructive-migration opt-in gate works as expected');
    } else {
      result.failures.push(`unexpected error from destructive guard: ${(error as Error).message}`);
    }
  } finally {
    await guarded.db.close();
  }

  if (result.failures.length > 0) {
    result.passed = false;
    console.error('\n❌ Migration integrity check failed:\n');
    for (const f of result.failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n✅ Migration integrity check passed: ids unique, up/down present, full set applies, destructive gate enforced');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ Migration integrity check crashed:', e);
  process.exit(2);
});
