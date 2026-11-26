# Backend Architecture Documentation

Complete technical documentation of NotifyChain backend services, their responsibilities, communication patterns, and data flow.

> **Audience**: Backend developers, system architects, and contributors implementing features affecting Listener Service, contracts, or APIs.

---

## Table of Contents

1. [Overview](#overview)
2. [Service Responsibilities](#service-responsibilities)
3. [API Interactions](#api-interactions)
4. [Storage Architecture](#storage-architecture)
5. [Data Flow & Event Lifecycle](#data-flow--event-lifecycle)
6. [Communication Patterns](#communication-patterns)
7. [Error Handling & Recovery](#error-handling--recovery)
8. [Scalability Considerations](#scalability-considerations)
9. [Database Reference](#database-reference)

---

## Overview

NotifyChain is composed of three major backend layers:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Frontend & User Interfaces                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────┐        ┌──────────────────────────┐ │
│  │  React Dashboard       │        │  Third-party Webhooks    │ │
│  │  (Web UI)              │        │  (Discord, Slack, etc.)  │ │
│  └────────────┬───────────┘        └──────────────┬───────────┘ │
│               │                                    │             │
├───────────────┼────────────────────────────────────┼─────────────┤
│               │                                    │             │
│  ┌─────────────▼────────────────────────────────────▼──────────┐ │
│  │          Listener Service (Node.js/TypeScript)             │ │
│  │                                                             │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐    │ │
│  │  │ Event        │  │ Notification │  │ REST API      │    │ │
│  │  │ Subscriber   │  │ Dispatcher   │  │ (/api/events) │    │ │
│  │  └──────────────┘  └──────────────┘  └───────────────┘    │ │
│  │         │                   │                               │ │
│  │         └───────────────────┼───────────────────────────┐   │ │
│  │                             │                           │   │ │
│  │  ┌──────────────────────────▼──────────────────────┐    │   │ │
│  │  │      Event Processing Pipeline                 │    │   │ │
│  │  │  - Deduplication                               │    │   │ │
│  │  │  - Filtering                                   │    │   │ │
│  │  │  - Enrichment                                  │    │   │ │
│  │  │  - Scheduling                                  │    │   │ │
│  │  └──────────────────────────┬─────────────────────┘    │   │ │
│  │                             │                           │   │ │
│  └─────────────────────────────┼───────────────────────────┘   │ │
│                                │                               │ │
├────────────────────────────────┼───────────────────────────────┤
│                                │                               │
│  ┌──────────────────────────────▼────────────────────────┐    │ │
│  │  Storage Layer (SQLite)                              │    │ │
│  │  - processed_events / polling_cursors                │    │ │
│  │  - scheduled_notifications / delivery records         │    │ │
│  │  - Scheduling metadata                                │    │ │
│  │  - Deduplication state                                │    │ │
│  └──────────────────────────────┬────────────────────────┘    │ │
│                                 │                              │ │
├─────────────────────────────────┼──────────────────────────────┤
│                                 │                              │
│  ┌────────────────────────────────▼─────────────────────────┐ │
│  │           Stellar Network (RPC)                         │ │
│  │  - Smart Contracts                                       │ │
│  │  - Events (Soroban)                                      │ │
│  │  - Transaction Ledger                                    │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Service Responsibilities

### 1. Listener Service

The Listener Service is the event aggregation and delivery engine. It runs as a Node.js/TypeScript service that continuously monitors the Stellar network, processes events, and exposes an API.

#### Core Responsibilities

| Responsibility | Implementation | Key Files |
|----------------|-----------------|-----------|
| **Event Polling** | Poll Stellar RPC for new ledgers and contract events | `src/index.ts`, `src/services/EventSubscriber.ts` |
| **Event Deduplication** | Prevent duplicate processing of the same event | `src/services/Deduplicator.ts` |
| **Event Storage** | Persist events to database for querying and retention | `src/db/` |
| **API Server** | Expose REST API for events and system info | `src/routes/events.ts`, `src/routes/health.ts` |
| **Notification Dispatch** | Send events to Discord, email, HTTP targets | `src/services/NotificationDispatcher.ts` |
| **Notification Scheduling** | Schedule delayed notifications with expiration support | `src/services/Scheduler.ts` |
| **Contract Monitoring** | Watch multiple Soroban contracts simultaneously | `src/index.ts` |

#### Event Subscriber

**Purpose**: Monitor the Stellar network for new events and pass them to the processing pipeline.

**Architecture**:
```typescript
EventSubscriber
├── Maintains list of contracts to watch
├── Polls Stellar RPC at regular intervals
├── Extracts contract events from new ledgers
├── Handles ledger reorganizations (reorg detection)
└── Passes events downstream for deduplication
```

**Key algorithms**:
- **Incremental polling**: Tracks last processed ledger to avoid re-polling old ledgers
- **Reorg detection**: Detects when Stellar consensus reverses a ledger and handles rollback
- **Batching**: Groups events from multiple contracts before processing

#### Event Deduplicator

**Purpose**: Prevent the same event from being processed multiple times.

**Architecture**:
```typescript
Deduplicator
├── Maintains in-memory cache of recent event signatures
├── Uses event ID + contract + type as dedup key
├── Configurable window (e.g., last 5 minutes)
├── Falls back to database for longer durations
└── Emits event_filtered event when duplicate detected
```

**Dedup key format**:
```
sha256(`${contractId}:${eventId}:${eventType}:${ledger}`)
```

#### Notification Dispatcher

**Purpose**: Route events to configured targets (Discord, HTTP, email, etc.).

**Architecture**:
```typescript
NotificationDispatcher
├── Discord Webhook Handler
│   ├── Formats event as Discord embed
│   ├── Respects Discord rate limits (10 req/sec)
│   └── Retries with exponential backoff
├── HTTP Target Handler
│   ├── Posts event as JSON
│   ├── Supports custom headers & auth
│   └── Retries with exponential backoff
└── Email Handler (if configured)
    ├── Sends HTML email
    └── Batches multiple events
```

**Retry strategy**:
```
Attempt 1: Immediate
Attempt 2: 5 seconds
Attempt 3: 25 seconds
Attempt 4: 125 seconds
Attempt 5: 625 seconds (then give up)
```

#### Scheduler

**Purpose**: Schedule delayed notifications and manage expiration.

**Architecture**:
```typescript
Scheduler
├── Polls database for notifications due
├── Filters by:
│   - Current ledger time
│   - Expiration status
│   - Revocation status
├── Processes due notifications
├── Emits NotificationExpired event
└── Cleans up expired records
```

**Processing cycle**:
```
Every SCHEDULER_POLL_INTERVAL_MS:
1. Query: SELECT FROM notifications WHERE scheduled_for <= now() AND expired = false AND revoked = false
2. Lock batch for this processor (prevent duplicates across horizontally-scaled listeners)
3. Process each notification (emit event, call dispatcher)
4. Delete processed records from database
```

### 2. Smart Contracts (Stellar/Soroban)

Smart contracts are the on-chain source of truth. They emit structured events that the Listener Service consumes.

#### AutoShare Contract

**Location**: `contract/contracts/hello-world/`

**Responsibilities**:
- Group creation and management
- Member management with percentage-based splits
- Payment processing
- Pause/unpause functionality
- Admin functions (withdrawal, transfer)

**Events emitted**:
```rust
AutoshareCreated        // Group created
AutoshareUpdated        // Group members updated
GroupActivated          // Group reactivated
GroupDeactivated        // Group deactivated
AdminTransferred        // Admin rights transferred
Withdrawal              // Admin withdrawal
ContractPaused          // Contract paused
ContractUnpaused        // Contract unpaused
NotificationScheduled   // Notification scheduled
NotificationExpired     // Notification expired
NotificationRevoked     // Notification revoked
NotificationExtended    // Notification expiration extended
```

**Storage structure**:
```rust
Key: (salt=autoshare, contract=CONTRACT_ID, id=group_id)
Value: AutoShareDetails {
    id: BytesN<32>,
    name: String,
    creator: Address,
    priority: NotificationPriority,
    usage_count: u32,
    total_usages_paid: u32,
    members: Vec<GroupMember>,
    is_active: bool,
}
```

#### TaskBounty Contract

**Location**: `Documents/Task Bounty/`

**Responsibilities**:
- Task creation with escrowed rewards
- Submission management
- Dispute resolution
- Approval/rejection of work
- Payment distribution

**Events emitted**:
- Task lifecycle events
- Payment events
- Dispute events

### 3. Storage Layer

The storage layer persists events for historical queries, deduplication, and notification scheduling.

#### Database Schema

**Events Table** (primary event log):
```sql
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,           -- Soroban event ID
    contract_id TEXT NOT NULL,               -- Contract address
    event_type TEXT NOT NULL,                -- Event name (e.g., "autoshare_created")
    data JSON NOT NULL,                      -- Full event payload
    ledger_sequence INTEGER NOT NULL,        -- Ledger containing event
    created_at TIMESTAMP NOT NULL,           -- Event creation time (ledger time)
    stored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,  -- When we stored it
    processed_at TIMESTAMP,                  -- When dispatcher processed it
    category TEXT,                           -- Event category (admin, financial, etc.)
    priority TEXT,                           -- Priority (low, medium, high, critical)
    INDEX idx_contract_created (contract_id, created_at),
    INDEX idx_event_type (event_type),
    INDEX idx_ledger (ledger_sequence)
);
```

**Notifications Table** (scheduled notifications):
```sql
CREATE TABLE notifications (
    id TEXT PRIMARY KEY,                     -- Notification ID
    creator TEXT NOT NULL,                   -- Creator address
    created_at INTEGER NOT NULL,             -- Created timestamp (ledger seconds)
    expires_at INTEGER NOT NULL,             -- Expiration timestamp
    revoked_by TEXT,                         -- Address that revoked it (or NULL)
    revoked_at INTEGER,                      -- When revoked (or NULL)
    scheduled_for INTEGER,                   -- When to deliver (for off-chain scheduling)
    delivered BOOLEAN DEFAULT 0,             -- Whether delivered
    delivered_at TIMESTAMP,                  -- When delivered
    INDEX idx_expires (expires_at),
    INDEX idx_scheduled (scheduled_for),
    INDEX idx_delivered (delivered)
);
```

**Polling State Table** (tracks progress):
```sql
CREATE TABLE polling_state (
    contract_id TEXT PRIMARY KEY,
    last_processed_ledger INTEGER NOT NULL,
    last_sync_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_contract (contract_id)
);
```

---

## API Interactions

### Listener Service HTTP API

#### 1. GET `/health`

Health check endpoint for monitoring and load balancers.

**Response**:
```json
{
  "status": "ok",
  "uptime_seconds": 3600,
  "contracts_watched": ["CXXXXXXX", "CYYYYYYY"],
  "last_event_time": "2024-01-15T10:30:45Z",
  "database_ok": true
}
```

#### 2. GET `/api/events`

Retrieve paginated event stream.

**Query Parameters**:
- `limit` (default: 100, max: 500)
- `offset` (default: 0)
- `contract_id` (optional) — filter by contract
- `event_type` (optional) — filter by event type
- `since` (optional) — ISO 8601 timestamp, return events after this time
- `category` (optional) — filter by category (admin, financial, etc.)

**Response**:
```json
{
  "events": [
    {
      "id": "e1234567890",
      "contract_id": "CXXXXXXX",
      "event_type": "autoshare_created",
      "ledger_sequence": 12345,
      "created_at": "2024-01-15T10:30:45Z",
      "data": {
        "creator": "GYYYYYYY",
        "id": "0x1234...",
        "category": "Group",
        "priority": "Medium"
      },
      "category": "Group",
      "priority": "Medium"
    }
  ],
  "total": 5000,
  "has_more": true
}
```

#### 3. GET `/api/events/:event_id`

Retrieve a specific event by ID.

**Response**:
```json
{
  "id": "e1234567890",
  "contract_id": "CXXXXXXX",
  "event_type": "autoshare_created",
  "ledger_sequence": 12345,
  "created_at": "2024-01-15T10:30:45Z",
  "data": { /* full event payload */ }
}
```

#### 4. GET `/api/notifications/:notification_id`

Retrieve scheduled notification details.

**Response**:
```json
{
  "id": "notif_xyz",
  "creator": "GYYYYYYY",
  "created_at": 1705310045,
  "expires_at": 1705313645,
  "revoked_by": null,
  "revoked_at": null,
  "scheduled_for": 1705313000,
  "delivered": false
}
```

### Stellar Contract Interface

#### Creating an AutoShare Group

```typescript
// Soroban contract call
const tx = new SorobanInvoke()
  .setFunction("create")
  .setParam("id", Buffer.from("..."))
  .setParam("name", "Engineering Fund")
  .setParam("creator", Address)
  .setParam("usage_count", 100)
  .setParam("payment_token", tokenAddress);

// Chain of events emitted:
// 1. AutoshareCreated { creator, id, category, priority }
// 2. (Listener polls ledger)
// 3. (Listener emits via API)
```

#### Scheduling a Notification

```typescript
// Soroban contract call
const tx = new SorobanInvoke()
  .setFunction("schedule_notification")
  .setParam("notification_id", Buffer.from("..."))
  .setParam("creator", Address)
  .setParam("ttl_seconds", 3600);  // 1 hour

// Chain of events:
// 1. NotificationScheduled emitted with expiry = now + ttl_seconds
// 2. Event stored in notifications table
// 3. Scheduler polls at configurable interval
// 4. When expired, NotificationExpired event emitted
// 5. Notification record cleaned up (if enabled)
```

---

## Storage Architecture

### Data Lifecycle

```
Contract Event       Listener     Dedup Check    Database      API Query
     ↓                  ↓             ↓              ↓              ↓
[Soroban]         [RPC Polling]   [Cache]     [SQLite/Postgres] [REST]
     │                  │             │              │              │
     └──────────────────┴─────────────┴──────────────┴──────────────┘
                    One-way data flow →
```

### Storage Tiers

| Tier | Technology | Purpose | Retention | Scalability |
|------|-----------|---------|-----------|------------|
| **Hot** | In-memory cache (Deduplicator) | Fast dedup lookup | 5 minutes | Local process only |
| **Warm** | SQLite `scheduled_notifications` and operational tables | Active delivery state and audit | Configurable retention | One writer per database file |
| **Cold** | SQLite `notification_archive` | Terminal notification snapshots | Configurable archive retention | Remains in the same database file |

PostgreSQL, horizontal Listener scaling, and a shared PostgreSQL repository are
future design directions, not implemented current runtime behavior. See
[Database Schema and Relationships](docs/DATABASE_SCHEMA.md) for the implemented
SQLite entities, constraints, indexes, and relationships.

### Migration Path: SQLite → PostgreSQL

PostgreSQL support is not implemented in the current Listener. A future migration
would require a new connection implementation, PostgreSQL migration dialect,
cross-database backup/export tooling, and validation of SQLite-specific triggers,
partial indexes, and constraints. Do not configure `DATABASE_URL` expecting it
to switch databases; the current Listener opens `DATABASE_PATH` through SQLite.

---

## Data Flow & Event Lifecycle

### Complete Event Journey

```
1. On-Chain: Contract state change
   └─> Smart contract emits Soroban event

2. Listener Polls
   └─> EventSubscriber calls RPC getLedgerEvents()
       └─> Returns: [{ id, type, contract_id, data }]

3. Deduplication
   └─> Deduplicator checks if event seen before
       └─> If new → pass to next stage
       └─> If duplicate → emit event_filtered, discard

4. Database Storage
   └─> Record event identity in processed_events
       └─> Update polling_cursors and schedule notification rows as applicable

5. Notification Dispatch
   └─> NotificationDispatcher picks up event
       └─> Check if notification targets configured
       └─> Send to Discord (if webhook set)
       └─> Send to custom HTTP endpoint (if configured)
       └─> Mark notification_sent = true

6. API Availability
   └─> Event immediately available via GET /api/events
       └─> Can filter by contract, type, time range
       └─> Can correlate with on-chain contract state

7. Cleanup (Optional)
   └─> After RETENTION_DAYS (e.g., 30 days)
       └─> Delete old events
       └─> Run VACUUM to reclaim space
```

### Event Expiration Lifecycle

For scheduled notifications with expiration support:

```
1. Contract schedules notification
   expires_at = now + ttl_seconds
   └─> NotificationScheduled event emitted

2. Listener stores notification
   INSERT INTO notifications (id, expires_at, ...)
   
3. Notification before expiry
   └─> API reports: is_notification_expired() = false
   └─> Can be revoked or extended

4. Notification at/after expiry
   └─> Scheduler detects: now >= expires_at
   └─> Calls: expire_notification()
   └─> Contract emits: NotificationExpired event
   └─> Listener deletes notification record

5. After expiration
   └─> is_notification_expired() = true
   └─> Cannot be revoked or extended
   └─> Is deleted from storage (reaping)
```

---

## Communication Patterns

### Listener ↔ Stellar Network (Pull)

```
Listener (Client)          Stellar RPC (Server)
     │                            │
     ├─ POST /                    │
     │  getLedgerEvents()         │
     ├───────────────────────────→│
     │                            │
     │        [events]            │
     │←───────────────────────────┤
     │                            │
```

**Frequency**: Configurable via `POLLING_INTERVAL_MS` (default: 5000ms)

**Error handling**:
- RPC timeout → backoff & retry (up to 5 attempts)
- RPC error 429 (rate limit) → exponential backoff
- RPC error 5xx (server error) → backoff & retry

### Dashboard ↔ Listener (Pull)

```
Dashboard (Browser)        Listener Service
     │                            │
     ├─ GET /api/events          │
     ├───────────────────────────→│
     │                            │
     │    [JSON events]           │
     │←───────────────────────────┤
     │                            │
```

**Polling**: Dashboard polls at `REACT_APP_POLL_INTERVAL` (e.g., 5 seconds)

**Caching**:
- Browser cache: `Cache-Control: private, max-age=5`
- Conditional requests: `If-Modified-Since` header support

### Listener → Discord/HTTP (Push)

```
Listener                   Discord Webhook / HTTP Target
     │                            │
     ├─ POST /webhooks/...        │
     │  (event as JSON)           │
     ├───────────────────────────→│
     │                            │
     │    [202 Accepted]          │
     │←───────────────────────────┤
     │                            │
```

**Async**: Notification dispatch is asynchronous; doesn't block event processing

**Rate limiting**:
- Discord: 10 requests/second per webhook
- Custom: Configurable via `HTTP_RATE_LIMIT` env var

---

## Error Handling & Recovery

### RPC Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `ECONNREFUSED` | RPC unreachable | Retry with exponential backoff |
| `ETIMEDOUT` | Network timeout | Increase timeout, retry |
| `429 Too Many Requests` | Rate limited | Exponential backoff, reduce polling frequency |
| `500 Internal Server Error` | RPC crash | Retry, switch to backup RPC |

### Database Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `SQLITE_CANTOPEN` | Database locked | Restart listener, release locks |
| `disk I/O error` | Disk full | Free disk space, or migrate to PostgreSQL |
| `UNIQUE constraint failed` | Duplicate event ID | Dedup filter should prevent this; if it occurs, skip event |

### Notification Dispatch Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `ENOTFOUND` (Discord/HTTP host) | Invalid webhook URL | Log error, continue (don't block event storage) |
| `ECONNREFUSED` | Webhook server down | Retry with backoff, eventually give up |
| `401 Unauthorized` | Invalid credentials | Log error, alert operator |

---

## Scalability Considerations

### Horizontal Scaling

For high-volume deployments, run multiple Listener instances:

```
┌──────────────────────────────────────────────────────┐
│          Load Balancer (nginx / HAProxy)             │
└─────────────┬──────────────────────────────────────┬─┘
              │                                       │
        ┌─────▼─────┐                        ┌──────▼──────┐
        │ Listener 1 │                        │ Listener 2  │
        │            │                        │             │
        │ Polling    │                        │ Polling     │
        │ Dedup      │                        │ Dedup       │
        │ (shared DB)│                        │ (shared DB) │
        └─────┬──────┘                        └──────┬──────┘
              │                                     │
              └─────────────┬──────────────────────┘
                            │
                   ┌────────▼────────┐
                   │ PostgreSQL      │
                   │ (shared storage)│
                   └─────────────────┘
```

**Key patterns**:
- **Shared database**: All listeners write to same database (SQLite or PostgreSQL)
- **Scheduling lock**: `SCHEDULER_PROCESSOR_ID` ensures only one scheduler processes notifications
- **Dedup cache**: Local per-instance; database fallback for long-term dedup
- **No session state**: Each listener is stateless (can be killed/restarted anytime)

### Optimization Tips

1. **Increase polling frequency** for low-latency event delivery:
   ```bash
   POLLING_INTERVAL_MS=1000  # 1 second instead of default 5 seconds
   ```

2. **Tune dedup window** based on event volume:
   ```bash
   DEDUP_WINDOW_MS=300000  # 5 minutes (longer = more memory)
   ```

3. **Batch notification dispatch** to reduce API calls:
   ```bash
   NOTIFICATION_BATCH_SIZE=10
   NOTIFICATION_BATCH_TIMEOUT_MS=1000
   ```

4. **Run configured retention and archival jobs** rather than ad-hoc event deletion:
   - purge or archive terminal `scheduled_notifications`
   - account for cascades from `dead_letter_queue` and `notification_execution_log`
   - remove expired `processed_events`, rate-limit records, and idempotency keys
   - back up first, then apply retention policy

5. **For higher concurrency**, PostgreSQL would require a dedicated implementation
   and migration; it is not a runtime fallback for the SQLite Listener today.

---

## Database Reference

The authoritative persisted-entity guide is
[Database Schema and Relationships](docs/DATABASE_SCHEMA.md). It documents the
core, audit, template, delivery, deduplication, metrics, and auxiliary tables,
their constraints and foreign keys, the ER diagram, and SQLite-specific behavior.

Use [Database Query Performance](docs/DATABASE_QUERY_PERFORMANCE.md) for index
rationale and query plans, and [Database Backup and Restore](docs/DATABASE_BACKUP_RESTORE.md)
for data protection and recovery procedures.

---

## References

- **System Architecture Diagrams**: [SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md)
- **Architecture Overview**: [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md)
- **API Documentation**: [API_DOCS.md](./API_DOCS.md)
- **Soroban Documentation**: https://developers.stellar.org/learn/fundamentals/soroban
- **Stellar RPC Reference**: https://developers.stellar.org/api/methods

