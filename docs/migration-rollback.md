# Database Migration Rollback Strategy

> How to reverse a NotifyChain listener migration, when a migration cannot be reversed, and the safeguards that keep destructive schema changes from silently losing data.

The listener uses an embedded SQLite database and a custom migration runner (`listener/src/database/migration-system.ts`).
Migrations live in `listener/src/migrations/` and are applied by `npm run migrate`.
This guide is the rollback counterpart to [DATABASE_BACKUP_RESTORE.md](./DATABASE_BACKUP_RESTORE.md): backups are the recovery of last resort, and this document explains when they are the *only* recovery.

---

## Table of Contents

1. [How Migrations Work Here](#how-migrations-work-here)
2. [Rolling Back a Migration](#rolling-back-a-migration)
3. [Which Migrations Are Reversible](#which-migrations-are-reversible)
4. [Destructive Migrations and Safeguards](#destructive-migrations-and-safeguards)
5. [Expand-Contract for Incompatible Changes](#expand-contract-for-incompatible-changes)
6. [Backout Checklist](#backout-checklist)
7. [CI Coverage](#ci-coverage)
8. [Order of Operations](#order-of-operations)

---

## How Migrations Work Here

- Migrations are TypeScript modules in `listener/src/migrations/`, named `NNN-description.ts`.
- Each module exports a default object with `id`, `name`, `up(db)`, and `down(db)`.
- Applied migrations are recorded in the `migrations` table (`id`, `name`, `applied_at`).
- `up` runs inside a transaction; if it throws, the transaction rolls back and nothing is recorded.
- `npm run migrate` applies pending migrations.
- `npm run check-migrations` reports whether any migration is pending (used in CI).

The runner was extended for this strategy with three capabilities:

| Capability | Where | Purpose |
|---|---|---|
| `rollbackLastMigration()` | `listener/src/database/migration-system.ts` | Runs the most recent migration's `down` in a transaction and removes its ledger row. |
| `destructive` flag + opt-in gate | `migration-system.ts`, `migrate-db.ts` | A migration that drops or narrows data refuses to apply unless `ALLOW_DESTRUCTIVE_MIGRATIONS=true` is set. |
| Duplicate-id detection | `migration-system.ts` | Fails fast if two migration files share an `id`. SQLite would otherwise skip the shadowed file forever. |

---

## Rolling Back a Migration

Use the rollback CLI. It rolls back **one** migration at a time, newest first.

```bash
cd listener

# Show what would be rolled back, change nothing
npm run rollback -- --dry-run

# Roll back the most recently applied migration
npm run rollback

# Roll back the last two migrations
npm run rollback -- --steps 2
```

What the CLI does:

1. Reads the applied migration ledger.
2. Finds the migration file matching the most recent applied `id`.
3. Refuses if the migration is flagged `destructive` (see below).
4. Runs `down(db)` inside a transaction and deletes the ledger row.
5. If `down` throws, the transaction rolls back and the ledger is unchanged, so the database is left exactly as it was.

> The runner never edits `down` behaviour at runtime. If a `down` is wrong, fix the migration file and re-run.

---

## Which Migrations Are Reversible

| Migration | Change | Reversible? | Notes |
|---|---|---|---|
| `001-initial-schema` | Creates core tables, indexes, triggers | Yes (`down` drops them) | Recreating from `schema.sql` restores the baseline. |
| `002-query-performance-indexes` | Adds indexes | Yes | `down` drops each index. |
| `003-delivery-receipts` | Creates `delivery_receipts` table + indexes | Yes | `down` drops the table and indexes. |
| `003-event-notification-query-indexes` | Adds expression indexes | Yes | `down` drops each index. |
| `003-notification-deduplication-key` | Adds `deduplication_key` column + unique index | Yes | `down` rebuilds the table without the column, preserving all other columns. |
| `004-database-data-integrity` | Rebuilds tables with `CHECK` constraints | **No** | `down` throws; recover from backup. |
| `005-notification-expiration` | Rebuilds tables to add `expires_at` | **No** | `down` throws; recover from backup. |

A migration whose `down` intentionally throws is not a bug: it is the signal that the change cannot be faithfully reversed and that a backup is the recovery path.

---

## Destructive Migrations and Safeguards

A migration is **destructive** when it drops data or narrows the schema such that the previous shape cannot be reconstructed from the new one. Examples in this repo:

- `004` and `005` **rebuild** core tables (`CREATE new`, `INSERT SELECT`, `DROP old`, `RENAME`).
  The old column set and constraints are gone after the rebuild.
- Dropping a column, narrowing a type, adding or tightening a `CHECK`, or removing a constraint are all destructive in the same sense.

Safeguards in place:

1. **Explicit opt-in gate.** `npm run migrate` aborts before applying any pending migration flagged `destructive` unless `ALLOW_DESTRUCTIVE_MIGRATIONS=true` is set:

   ```bash
   # Take and verify a backup FIRST (see DATABASE_BACKUP_RESTORE.md), then:
   ALLOW_DESTRUCTIVE_MIGRATIONS=true npm run migrate
   ```

2. **Non-reversible `down`.** Destructive migrations throw from `down`, so `npm run rollback` cannot be used to "revert" them and mistake data loss for a rollback. The error points at backup-based recovery.

3. **Backup requirement.** Destructive migrations ship with the expectation that the operator has a verified pre-migration backup. See [DATABASE_BACKUP_RESTORE.md](./DATABASE_BACKUP_RESTORE.md) for how to take and verify one.

4. **CI guard.** `npm run check:migrations-integrity` fails the build if a migration flagged `destructive` has a `down` that succeeds (it must throw), or if a non-destructive migration does not round-trip cleanly.

### Declaring a destructive migration

```ts
const migration = {
  id: '006',
  name: 'drop-legacy-column',
  destructive: true, // refuses to apply without ALLOW_DESTRUCTIVE_MIGRATIONS=true
  up: async (db) => {
    /* ... */
  },
  down: async () => {
    throw new Error('Migration 006 cannot be safely rolled back; restore a database backup instead');
  },
};
export default migration;
```

When a destructive change *can* be expressed reversibly, prefer the expand-contract approach below instead of declaring `destructive`.

---

## Expand-Contract for Incompatible Changes

When a schema change is incompatible with code that is still running, do not ship a single destructive migration. Split it into two backward-compatible phases:

1. **Expand** (safe, reversible). Add the new column/table/index alongside the old one. Old code keeps working; new code can start writing to both. No data is lost, and `down` simply removes the addition.
2. **Contract** (destructive). After all code reads only the new shape and a verified backup exists, drop the old column/table in a separate migration flagged `destructive: true`.

This keeps every intermediate state deployable and reversible except the final, deliberate contract step.

---

## Backout Checklist

Use this when a migration must be backed out. Work top to bottom; stop at the first step that applies.

- [ ] **Identify the migration.** `npm run rollback -- --dry-run` shows the newest applied migration.
- [ ] **Is it reversible?** Check the table in [Which Migrations Are Reversible](#which-migrations-are-reversible).
- [ ] **Reversible path.**
  - [ ] Stop the listener to avoid concurrent writers.
  - [ ] `npm run rollback` (add `--steps N` for more).
  - [ ] Confirm the ledger no longer lists the migration: `sqlite3 "$DATABASE_PATH" "SELECT id, name FROM migrations"`.
  - [ ] Deploy the matching previous application build.
  - [ ] Restart the listener and drain the queue.
- [ ] **Destructive path.** Stop here and restore from backup instead:
  - [ ] Stop the listener.
  - [ ] Restore the most recent verified backup per [DATABASE_BACKUP_RESTORE.md](./DATABASE_BACKUP_RESTORE.md).
  - [ ] Deploy the matching previous application build.
  - [ ] Restart the listener and verify queue depth and delivery resume.
- [ ] **Record the incident** in the release notes and, if a `down` was missing or wrong, open a follow-up to fix the migration file.

---

## CI Coverage

The `migrations` job in `.github/workflows/ci.yml` runs, on every push and pull request:

```bash
cd listener
npm ci
npm run check:migrations-integrity   # ids unique, up/down present, reversible set round-trips, destructive set guarded
npm run check-migrations             # fail if pending migrations are uncommitted
npm run migrate                      # apply all migrations against a scratch DB
```

`check:migrations-integrity` (`listener/src/scripts/check-migration-integrity.ts`) uses an in-memory SQLite database, so it needs no external service.
It catches:

- a migration with no `up` or no `down`;
- two migration files sharing an `id` (which would silently skip one);
- a non-destructive migration whose `up` + `down` do not round-trip cleanly;
- a migration flagged `destructive` whose `down` succeeds (it must throw to force backup-based recovery).

---

## Order of Operations

For a **planned** schema change:

1. Author the migration; keep it additive (expand) where possible.
2. Run `npm run check:migrations-integrity` and `npm run migrate` locally against a scratch DB.
3. Open the PR; let the `migrations` CI job pass.
4. Take and verify a backup in staging, deploy, and verify.
5. Only then deploy to production.

For an **incident** on production:

1. Stop the listener.
2. Take an immediate backup of the current (post-migration) database for forensics.
3. If the migration is reversible, run `npm run rollback` and revert the app build.
4. If it is destructive, restore the pre-migration backup and revert the app build.
5. Verify queue depth and delivery, then write up the incident.
