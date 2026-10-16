# ADR-0004: Database and Persistence Architecture

## Metadata

- **Status**: Accepted
- **Date**: 2026-09-30
- **Authors**: @lynndabel
- **Related Issues**: N/A
- **Supersedes**: N/A
- **Superseded By**: N/A

## Context

NotifyChain requires persistent storage for multiple purposes:

1. **Event Deduplication**: Track processed events to prevent duplicates across restarts and reorgs
2. **Scheduled Notifications**: Store delayed notifications with expiration and revocation
3. **Polling Cursors**: Track last processed ledger per contract for resumption
4. **Rate Limiting**: Log rate limit violations for audit and monitoring
5. **User Preferences**: Store user notification preferences and subscriptions
6. **Analytics**: Store aggregated metrics and historical data

The system must balance:
- **Simplicity**: Easy to deploy and maintain
- **Performance**: Fast reads and writes for high event volume
- **Scalability**: Support horizontal scaling for production
- **Reliability**: ACID guarantees for critical operations
- **Portability**: Easy to migrate between environments

## Decision

We use SQLite as the primary database for development and single-instance deployments, with a migration path to PostgreSQL for production multi-instance deployments.

### Database Choice: SQLite

**Rationale**:
- **Zero Configuration**: No separate database server to manage
- **Embedded**: Single file storage, easy backup and migration
- **ACID Compliant**: Full transaction support for critical operations
- **Performance**: Excellent for read-heavy workloads with moderate write volume
- **Portability**: Single file can be copied between environments
- **Sufficient Scale**: Handles millions of records efficiently with proper indexing

**Trade-offs**:
- **Write Concurrency**: Limited write concurrency (single writer)
- **Network Access**: Cannot be accessed over network (file-based)
- **Scaling**: Limited to single-instance deployments

### Migration Path: PostgreSQL

For production deployments requiring horizontal scaling, we support PostgreSQL:

**When to Migrate**:
- Multiple listener instances needed
- High write volume (>1000 events/second)
- Network access to database required
- Need for advanced features (replication, connection pooling)

**Migration Strategy**:
- Same schema and queries work with both SQLite and PostgreSQL
- Configuration via `DATABASE_URL` environment variable
- Automatic detection and connection pool initialization
- Migration script to export/import data

### Schema Design

#### Core Tables

**events**: Primary event log
```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  contract_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  data JSON NOT NULL,
  ledger_sequence INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL,
  stored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP,
  category TEXT,
  priority TEXT,
  INDEX idx_contract_created (contract_id, created_at),
  INDEX idx_event_type (event_type),
  INDEX idx_ledger (ledger_sequence)
);
```

**processed_events**: Deduplication tracking
```sql
CREATE TABLE processed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  contract_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ledger_sequence INTEGER NOT NULL,
  is_reorg_duplicate BOOLEAN DEFAULT 0,
  processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_event_id (event_id),
  INDEX idx_contract_ledger (contract_id, ledger_sequence)
);
```

**polling_cursors**: Cursor tracking per contract
```sql
CREATE TABLE polling_cursors (
  contract_id TEXT PRIMARY KEY,
  last_ledger INTEGER NOT NULL,
  reorg_detection_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**scheduled_notifications**: Delayed notifications
```sql
CREATE TABLE scheduled_notifications (
  id TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_by TEXT,
  revoked_at INTEGER,
  scheduled_for INTEGER,
  delivered BOOLEAN DEFAULT 0,
  delivered_at TIMESTAMP,
  status TEXT DEFAULT 'PENDING',
  processor_id TEXT,
  lock_expires_at TIMESTAMP,
  INDEX idx_expires (expires_at),
  INDEX idx_scheduled (scheduled_for),
  INDEX idx_status (status)
);
```

**rate_limit_events**: Rate limit audit log
```sql
CREATE TABLE rate_limit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  limit_value INTEGER NOT NULL,
  window_ms INTEGER NOT NULL,
  INDEX idx_client (client_id),
  INDEX idx_timestamp (timestamp)
);
```

### Data Retention and Cleanup

**Retention Policies**:
- Events: 30 days (configurable via `PROCESSED_EVENT_RETENTION_MS`)
- Processed events: 30 days
- Rate limit events: 24 hours
- Scheduled notifications: Deleted after delivery/expiration
- Analytics snapshots: 30 days

**Cleanup Job**:
- Runs at `CLEANUP_INTERVAL_MS` (default: 1 hour)
- Deletes expired records based on retention policy
- Runs `VACUUM` on SQLite to reclaim space
- Configurable per table type

### Transaction Boundaries

**Critical Operations Use Transactions**:
- Event insertion + deduplication check
- Cursor update + event processing
- Notification scheduling + lock acquisition
- Rate limit violation logging

**Example**:
```typescript
await db.transaction(async (tx) => {
  // Check if event already processed
  const existing = await tx.get(
    'SELECT id FROM processed_events WHERE event_id = ?',
    [eventId]
  );
  
  if (existing) {
    throw new Error('Duplicate event');
  }
  
  // Insert event
  await tx.run(
    'INSERT INTO events (event_id, contract_id, ...) VALUES (?, ?, ...)',
    [eventId, contractId, ...]
  );
  
  // Mark as processed
  await tx.run(
    'INSERT INTO processed_events (event_id, ...) VALUES (?, ...)',
    [eventId, ...]
  );
});
```

### Connection Management

**SQLite**:
- Single connection per process
- WAL mode enabled for better concurrency
- Connection pooling not needed

**PostgreSQL**:
- Connection pool via `pg` library
- Configurable pool size (default: 10)
- Automatic connection reuse
- Connection timeout handling

## Consequences

### Positive

- **Simplicity**: SQLite provides zero-configuration deployment for development
- **Portability**: Single file database easy to backup and migrate
- **Performance**: SQLite is fast for read-heavy workloads with proper indexing
- **Migration Path**: Clear upgrade path to PostgreSQL when needed
- **ACID Guarantees**: Transactions ensure data consistency
- **Low Overhead**: No separate database server to manage

### Negative

- **Write Concurrency**: SQLite limited to single writer at a time
- **Scaling**: SQLite limited to single-instance deployments
- **Network Access**: SQLite cannot be accessed over network
- **Backup Complexity**: Large SQLite files require careful backup strategies
- **Feature Limitations**: SQLite lacks some PostgreSQL features (replication, extensions)

### Risks

- **Database Lock Contention**: High write volume could cause lock contention in SQLite
  - **Mitigation**: Use WAL mode, optimize queries, migrate to PostgreSQL if needed
- **File Corruption**: SQLite file could be corrupted if process crashes during write
  - **Mitigation**: WAL mode reduces risk; regular backups; consider PostgreSQL for critical deployments
- **Storage Exhaustion**: Unbounded table growth could fill disk
  - **Mitigation**: Configurable retention policies; automated cleanup; monitoring
- **Migration Complexity**: Migrating from SQLite to PostgreSQL requires downtime
  - **Mitigation**: Document migration process; use migration scripts; plan downtime window

## Alternatives Considered

| Alternative | Description | Rejected Because |
|-------------|-------------|------------------|
| PostgreSQL Only | Use PostgreSQL for all deployments | Overkill for development; adds infrastructure complexity |
| MySQL | Use MySQL instead of PostgreSQL | PostgreSQL has better JSON support and more advanced features |
| MongoDB | Use NoSQL document store | Schema-less approach doesn't fit structured event data |
| Redis | Use in-memory data store | No persistence; not suitable for event log |
| Event Sourcing with Append-Only Log | Store all events in append-only log | Overkill; we only need current state, not full history |

## Implementation

### Database Abstraction Layer

**Implementation**: `listener/src/database/` directory

**Components**:
- `index.ts`: Database initialization and connection management
- `schema.sql`: Schema definitions and migrations
- `migrations/`: Migration scripts for schema changes

**Connection Logic**:
```typescript
if (DATABASE_URL?.startsWith('postgresql://')) {
  // PostgreSQL connection pool
  pool = new Pool({ connectionString: DATABASE_URL });
  await runMigrations(pool);
} else {
  // SQLite connection
  db = new Database(DATABASE_PATH || './data/notifications.db');
  db.pragma('journal_mode = WAL');
  await runMigrations(db);
}
```

### Configuration

```env
# SQLite (default)
DATABASE_PATH=./data/notifications.db

# PostgreSQL (for production)
DATABASE_URL=postgresql://user:pass@host:5432/notifychain

# Retention Policies
PROCESSED_EVENT_RETENTION_MS=2592000000
RATE_LIMIT_EVENT_RETENTION_MS=86400000
EVENT_RETENTION_MS=86400000

# Cleanup
CLEANUP_INTERVAL_MS=3600000
```

### Monitoring

**Key Metrics**:
- Database size
- Query latency (p50, p95, p99)
- Lock wait time (SQLite)
- Connection pool utilization (PostgreSQL)
- Table row counts
- Cleanup job execution time

**Alerting**:
- Alert if database size exceeds threshold
- Alert if query latency exceeds threshold
- Alert if connection pool exhausted (PostgreSQL)
- Alert if cleanup job fails

## References

- [Backend Architecture](../../BACKEND_ARCHITECTURE.md)
- [Architecture Overview](../../ARCHITECTURE_OVERVIEW.md)
- [SQLite Documentation](https://www.sqlite.org/docs.html)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)

---

## Notes

- WAL mode is critical for SQLite write performance
- Consider implementing read replicas for PostgreSQL in high-volume deployments
- Future enhancement: Add support for database sharding for very large deployments
- Regular backups are essential; implement automated backup strategy for production
