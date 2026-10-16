# CI Test Database Environment (#859)

The CI Test Database Environment provides a reproducible, isolated database environment for running integration tests in Continuous Integration (CI) and local environments.

## Overview & Acceptance Criteria

- **Database Provisioning**: CI can provision the required database automatically on demand without manual setup or pre-existing files.
- **Automated Migrations**: Schema creation and all incremental database migrations (`001-initial-schema`, `002-query-performance-indexes`, etc.) execute automatically during provisioning.
- **Clean State Guarantee**: Previous database artifacts (including write-ahead logs and shared memory files) are removed prior to test execution, ensuring tests always start from and leave a clean state.

---

## 1. Lifecycle & Architecture

```
[ CI Job Starts ]
        │
        ▼
[ Clean Previous Artifacts ] ──► Unlink .db, -wal, -shm, -journal
        │
        ▼
[ Initialize Database ] ───────► Connect to SQLite instance
        │
        ▼
[ Run Migrations Automatically ]► Execute baseline schema + MigrationRunner
        │
        ▼
[ Clean State Verification ] ──► Ensure schema tables exist & row count == 0
        │
        ▼
[ Run Integration Test Suite ] ─► Tests run against isolated test DB
        │
        ▼
[ Teardown & Clean Up ] ───────► db:test:clean removes test DB
```

---

## 2. Scripts and Commands

The environment is managed via utility scripts in `listener/src/scripts/`:

### 1. Provision Test Database (`db:test:setup`)
```bash
npm run db:test:setup
# Or directly:
ts-node src/scripts/setup-test-db.ts
```

What this does:
1. Deletes any pre-existing database files at `DATABASE_PATH` or `TEST_DATABASE_PATH`.
2. Creates the database directory if needed.
3. Initializes the SQLite schema (`schema.sql`).
4. Discovers and applies all pending migrations in `listener/src/migrations/` in order.
5. Verifies all tables exist and logs a summary of applied migrations.

### 2. Clean Test Database (`db:test:clean`)
```bash
npm run db:test:clean
# Or directly:
ts-node src/scripts/clean-test-db.ts
```

What this does:
- Safely closes open database connections and removes the SQLite database file and associated lock/journal files.

### 3. Run Integration Tests with Clean Test DB
```bash
npm run test:ci-db
```

---

## 3. CI Pipeline Integration

In GitHub Actions workflows (e.g. `.github/workflows/ci.yml`), the test database environment is provisioned as follows:

```yaml
jobs:
  test-database-integration:
    name: CI Test Database & Integration Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
          cache-dependency-path: listener/package-lock.json

      - name: Install dependencies
        working-directory: listener
        run: npm ci

      - name: Provision reproducible database & apply migrations
        working-directory: listener
        env:
          DATABASE_PATH: ./data/test-notifications.db
        run: npm run db:test:setup

      - name: Verify migrations
        working-directory: listener
        run: npm run check-migrations

      - name: Run integration tests
        working-directory: listener
        env:
          DATABASE_PATH: ./data/test-notifications.db
        run: npm test -- src/__tests__/integration.test.ts --silent

      - name: Clean test database state
        working-directory: listener
        if: always()
        run: npm run db:test:clean
```

---

## 4. Programmatic Usage in Test Suites

Test suites can also programmatically create isolated test environments using `listener/src/test-utils/test-db-environment.ts`:

```typescript
import { provisionTestDatabase, cleanTestDatabase } from '../test-utils/test-db-environment';
import { Database } from '../database/database';

describe('Integration Test Suite', () => {
  let db: Database;
  let dbPath: string;

  beforeAll(async () => {
    // Automatically provision clean DB with all migrations applied
    const provisioned = await provisionTestDatabase({
      dbPath: './data/test-suite.db',
      runMigrations: true,
    });
    db = provisioned.db;
    dbPath = provisioned.dbPath;
  });

  afterAll(async () => {
    // Teardown and delete test database
    await cleanTestDatabase(db, dbPath);
  });

  test('runs in clean state', async () => {
    const rows = await db.all('SELECT COUNT(*) as count FROM scheduled_notifications');
    expect(rows[0].count).toBe(0);
  });
});
```
