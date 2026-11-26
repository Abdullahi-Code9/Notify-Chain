# NotifyChain — System Architecture

> **Audience**: Developers, integrators, and operators who need a visual
> and structured understanding of the NotifyChain system architecture,
> component interactions, and data flow.

## Table of Contents

1. [System Overview](#1-system-overview)
2. [High-Level Architecture](#2-high-level-architecture)
3. [On-Chain Layer — Smart Contracts](#3-on-chain-layer--smart-contracts)
4. [Off-Chain Layer — Listener Service](#4-off-chain-layer--listener-service)
5. [Presentation Layer — Dashboard & Frontend](#5-presentation-layer--dashboard--frontend)
6. [End-to-End Data Flow](#6-end-to-end-data-flow)
7. [Database Schema](#7-database-schema)
8. [Deployment Architecture](#8-deployment-architecture)
9. [Related Documentation](#9-related-documentation)

---

## 1. System Overview

NotifyChain is an **event monitoring and notification platform for Stellar
(Soroban) smart contracts**. It bridges on-chain contract activity to
off-chain consumers — Discord webhooks, REST API clients, and a React
dashboard — without requiring continuous RPC polling from every consumer.

The system is structured into three independent layers:

| Layer | Directory | Tech | Responsibility |
|-------|-----------|------|----------------|
| **Smart Contracts** | `contract/`, `Documents/Task Bounty/` | Soroban / Rust | Execute business logic and emit typed events per state change |
| **Listener Service** | `listener/` | Node.js / TypeScript | Poll Stellar RPC, deduplicate events, dispatch notifications, expose HTTP API |
| **Dashboard / Frontend** | `dashboard/`, `frontend/` | React + Vite, Next.js | Render event feed, analytics, and schedules for human operators |

---

## 2. High-Level Architecture

```mermaid
architecture-beta
    group onchain(on-chain)[On-Chain Layer]
    group offchain(off-chain)[Off-Chain Layer]
    group presentation(presentation)[Presentation Layer]

    service user(user)[Users / dApps] in onchain
    service contract(contract)[Soroban Contracts] in onchain
    service stellar(stellar)[Stellar Network] in onchain

    service listener(listener)[Listener Service] in offchain
    service db(db)[SQLite] in offchain
    service rest(rest)[REST API] in offchain

    service discord(discord)[Discord] in presentation
    service dashboard(dashboard)[Dashboard] in presentation
    service frontend(frontend)[Frontend] in presentation

    user:R --> L:contract
    contract:B --> T:stellar
    stellar:B --> T:listener
    listener:R --> L:db
    listener:T --> L:rest
    rest:T --> L:dashboard
    rest:T --> L:frontend
    listener:B --> T:discord
```

### Layer Responsibilities

- **On-Chain Layer**: The canonical source of truth. Contracts own state and
  emit one structured Soroban event per state transition.
- **Listener Service**: The core orchestration engine. Polls the Stellar
  network, deduplicates, dispatches notifications, and serves the HTTP API.
- **Presentation Layer**: Read-only consumers of the listener's API. Never
  talk to Stellar directly.

---

## 3. On-Chain Layer — Smart Contracts

### Contract Architecture

```mermaid
block-beta
    columns 6

    block:contract_core:2
        columns 1
        lib["lib.rs / Entry Point (#[contract])"]
        logic["autoshare_logic.rs / Core Business Logic"]
    end

    block:base:2
        columns 2
        errors["errors.rs<br/>Error Types"]
        events["events.rs<br/>Soroban Events"]
        types["types.rs<br/>Data Structures"]
    end

    block:tests:2
        columns 1
        test_files["Test Suite<br/>(8 test files)"]
        mock["mock_token.rs<br/>Mock Token"]
    end

    lib --> logic
    logic --> errors
    logic --> events
    logic --> types
    logic --> test_files
    test_files --> mock
```

### Key Abstractions

| Concept | Location | Purpose |
|---------|----------|---------|
| `#[contract]` / `#[contractimpl]` | `lib.rs` | Soroban contract entry point macros |
| `#[contractevent]` | `base/events.rs` | Typed event definitions (12 event types) |
| `#[contracttype]` | `base/types.rs` | Storage data structures |
| `NotificationCategory` | `base/events.rs` | Event categorization: Group, Admin, Financial, Notification |
| `NotificationPriority` | `base/events.rs` | Priority levels: Low, Medium, High, Critical |
| `DataKey` | `base/types.rs` | Storage key enum for persistent state |

### Contracts Catalog

| Contract | Path | Purpose |
|----------|------|---------|
| **AutoShare** | `contract/contracts/hello-world/` | Subscription and group management. Group CRUD, member management, subscription payments, usage tracking. |
| **TaskBounty** | `Documents/Task Bounty/` | Decentralized task + reward board. Task lifecycle, submissions, disputes, payouts. |

---

## 4. Off-Chain Layer — Listener Service

### Internal Component Architecture

```mermaid
flowchart TB
    subgraph "Listener Service (Node.js + TypeScript)"
        direction TB

        EP["index.ts<br/>Entry Point"]
        
        subgraph "Polling & Ingestion"
            ES["EventSubscriber<br/>- Polls Stellar RPC<br/>- Validates events<br/>- Manages cursors<br/>- Reconnect logic"]
            EDS["EventDeduplicationService<br/>- Persistent SQLite dedup<br/>- Reorg detection<br/>- Cursor tracking"]
        end

        subgraph "Queues & Concurrency"
            EPQ["EventProcessingQueue<br/>- Configurable concurrency<br/>- Retry with backoff<br/>- Poll-based processing"]
            NRQ["NotificationRetryQueue<br/>- Exponential backoff<br/>- Max 5 retries<br/>- Fingerprint dedup"]
        end

        subgraph "Storage"
            ER["EventRegistry<br/>- In-memory ring buffer<br/>- Max 10k events<br/>- 24h TTL"]
            DB["SQLite Database<br/>- processed_events<br/>- polling_cursors<br/>- scheduled_notifications<br/>- notification_templates<br/>- rate_limit_events"]
            ND["NotificationDeduplicator<br/>- In-memory LRU cache<br/>- 60s window<br/>- 10k entries"]
        end

        subgraph "Notification Delivery"
            DNS["DiscordNotificationService<br/>- Discord embed formatting<br/>- Webhook POST via fetch()<br/>- 5s timeout"]
            NS["NotificationScheduler<br/>- Background 10s tick<br/>- Atomic lock acquisition<br/>- Stale lock recovery"]
        end

        subgraph "HTTP API (events-server.ts)"
            HEALTH["GET /health"]
            EVENTS["GET /api/events"]
            SCHEDULE["POST /api/schedule<br/>GET /api/schedule/stats<br/>GET /api/schedule/:id"]
            WEBHOOKS["POST /api/webhooks"]
            TEMPLATES["GET/PUT/POST /api/templates"]
            PREFERENCES["GET/PUT /api/preferences/:userId"]
            ANALYTICS["GET /api/analytics<br/>GET /api/notifications/history"]
            RL["RateLimiter<br/>Sliding window<br/>Per-client config"]
        end

        subgraph "Supporting Services"
            CS["CleanupService<br/>- Periodic pruning<br/>- Event TTL enforcement"]
            NTS["NotificationTemplateService<br/>- Template CRUD<br/>- Read-through cache<br/>- Immutable audit log"]
            NPS["PreferenceStore<br/>- Per-user gating<br/>- Category enable/disable"]
        end
    end

    EP --> ES
    EP --> NS
    EP --> CS
    ES --> EDS
    ES --> EPQ
    ES --> ER
    EPQ --> DNS
    DNS --> NRQ
    DNS --> ND
    NS --> DB
    NS --> DNS
    
    HEALTH --> RL
    EVENTS --> RL
    SCHEDULE --> RL
    WEBHOOKS --> RL
    TEMPLATES --> RL
    PREFERENCES --> RL
    ANALYTICS --> RL
    
    EVENTS --> ER
    SCHEDULE --> DB
    PREFERENCES --> NPS
    TEMPLATES --> NTS
    WEBHOOKS --> DB
```

### Module Map

| Path | Role |
|------|------|
| `listener/src/index.ts` | Entry point. Wires subscriber, scheduler, server, and cleanup. |
| `listener/src/services/event-subscriber.ts` | Polls Stellar RPC, validates, deduplicates, processes events. |
| `listener/src/services/event-deduplication-service.ts` | Persistent dedup + reorg detection via SQLite. |
| `listener/src/services/discord-notification.ts` | Formats and delivers Discord webhook notifications. |
| `listener/src/services/event-processing-queue.ts` | Concurrency-controlled event processing with backoff. |
| `listener/src/services/notification-retry-queue.ts` | Exponential-backoff retry for failed notifications. |
| `listener/src/services/notification-deduplicator.ts` | In-memory LRU dedup (60s window). |
| `listener/src/services/notification-scheduler.ts` | Background scheduler for future-dated notifications. |
| `listener/src/services/notification-api.ts` | High-level scheduling API. |
| `listener/src/services/scheduled-notification-repository.ts` | SQLite CRUD for scheduled notifications. |
| `listener/src/services/notification-template-service.ts` | Template management with read-through cache. |
| `listener/src/services/webhook-verifier.ts` | HMAC signature verification for inbound webhooks. |
| `listener/src/services/cleanup-service.ts` | Periodic pruning of expired events and records. |
| `listener/src/services/notification-analytics-aggregator.ts` | Notification delivery analytics. |
| `listener/src/services/notification-history.ts` | Delivery history queries. |
| `listener/src/store/event-registry.ts` | In-memory event ring buffer. |
| `listener/src/store/preference-store.ts` | Per-user notification preference gating. |
| `listener/src/database/database.ts` | SQLite wrapper with migrations. |
| `listener/src/api/events-server.ts` | HTTP server (raw `http` module, no Express). |
| `listener/src/api/rate-limiter.ts` | Sliding window rate limiter. |
| `listener/src/config.ts` | Environment variable parsing and validation. |

### Scheduler Subsystem

```mermaid
flowchart LR
    subgraph "Scheduler Subsystem"
        direction TB
        API["POST /api/schedule<br/>Notification API"]
        REPO["ScheduledNotificationRepository<br/>CRUD + Lock Management"]
        SCHED["NotificationScheduler<br/>Background Worker (10s tick)"]
        DB_[(SQLite)]
        EXEC["Delivery Execution"]
    end

    API -->|validate + insert| REPO
    REPO --> DB_
    SCHED -->|poll PENDING due| DB_
    SCHED -->|atomic UPDATE lock| DB_
    SCHED --> EXEC
    EXEC -->|success| DB_
    EXEC -->|failure| SCHED
```

The scheduler provides **at-least-once delivery** for future-dated notifications:

1. **Schedule**: Caller submits via `POST /api/schedule` → stored as `PENDING`
2. **Poll**: Background worker ticks every 10s, queries `WHERE status='PENDING' AND execute_at <= NOW()`
3. **Lock**: Atomic `UPDATE ... WHERE status='PENDING'` provides race-free distributed lock
4. **Execute**: Dispatches via configured channel (Discord, webhook, etc.)
5. **Complete**: Marks `COMPLETED` on success; retries or marks `FAILED` on failure

---

## 5. Presentation Layer — Dashboard & Frontend

```mermaid
flowchart LR
    subgraph "Presentation Layer"
        direction TB
        DASH["Dashboard<br/>React 19 + Vite 6 + Zustand 5"]
        FE["Frontend<br/>Next.js 14 + Chart.js"]
    end

    subgraph "Listener API"
        REST["REST API<br/>events-server.ts"]
    end

    REST -->|GET /api/events| DASH
    REST -->|GET /api/schedule/*| DASH
    REST -->|GET /api/events| FE
    REST -->|GET /api/analytics| FE
    REST -->|GET /api/schedule/stats| FE
```

| Component | Tech | Responsibility |
|-----------|------|----------------|
| **Dashboard** | React 19, Vite 6, Zustand 5 | Events feed, schedule viewer, stats. Read-only consumer. |
| **Frontend** | Next.js 14, Chart.js, Tailwind CSS | Analytics dashboard with visualization. Read-only consumer. |

---

## 6. End-to-End Data Flow

### Primary Flow: Event → Notification

```mermaid
sequenceDiagram
    participant User as User / dApp
    participant Contract as Soroban Contract
    participant Stellar as Stellar Network
    participant Subscriber as EventSubscriber
    participant Dedup as Deduplication Layer
    participant Discord as DiscordNotificationService
    participant Registry as Event Registry
    participant API as REST API
    participant Dashboard as Dashboard / Frontend

    User->>Contract: invoke contract function
    Contract->>Contract: mutate state
    Contract->>Stellar: emit typed Soroban event
    
    loop Every 30s (configurable)
        Subscriber->>Stellar: poll getEvents()
        Stellar-->>Subscriber: events[]
    end
    
    Subscriber->>Subscriber: validateEventPayload()
    Subscriber->>Subscriber: matchesEventFilter()
    
    Subscriber->>Dedup: isDuplicate (persistent SQLite check)
    Dedup-->>Subscriber: not duplicate
    
    alt Reorg detected
        Dedup->>Dedup: ledger_num comparison
        Dedup->>Dedup: mark is_reorg_duplicate
        Dedup-->>Subscriber: skip
    end
    
    Subscriber->>Registry: addFromInput()
    Registry-->>Subscriber: DisplayEvent
    
    Subscriber->>Discord: sendEventNotification()
    Discord->>Discord: NotificationDeduplicator (in-memory LRU)
    
    alt First send
        Discord->>Discord: format Discord embed
        Discord->>Discord: POST webhook (5s timeout)
        Discord->>Dedup: recordProcessedEvent()
        
        alt Success (2xx)
            Discord-->>Subscriber: true ✓
        else Failure
            Discord->>NotificationRetryQueue: enqueue for retry
            Discord-->>Subscriber: false ✗
        end
    end
    
    Note over Dashboard: User navigates to dashboard
    Dashboard->>API: GET /api/events
    API->>Registry: fetch events
    Registry-->>API: DisplayEvent[]
    API-->>Dashboard: JSON response
    Dashboard->>Dashboard: render event feed
```

### Secondary Flow: Scheduled Notifications

```mermaid
sequenceDiagram
    participant Caller as Caller / System
    participant API as REST API
    participant Repo as ScheduledNotificationRepository
    participant DB as SQLite
    participant Scheduler as NotificationScheduler
    participant Discord as DiscordNotificationService

    Caller->>API: POST /api/schedule {payload, executeAt, ...}
    API->>API: validate request
    API->>Repo: create()
    Repo->>DB: INSERT INTO scheduled_notifications
    DB-->>Repo: id=123
    Repo-->>API: {id: 123}
    API-->>Caller: 201 Created {id: 123}
    
    Note over Scheduler: Background loop every 10s
    
    loop Every 10s
        Scheduler->>DB: recoverStaleLocks()
        Scheduler->>DB: SELECT PENDING due notifications (LIMIT 10)
        DB-->>Scheduler: rows[]
        
        Scheduler->>DB: atomic UPDATE status='PROCESSING' WHERE status='PENDING'
        DB-->>Scheduler: changedRows=N
        
        loop For each locked notification
            Scheduler->>Discord: execute delivery
            
            alt Success
                Scheduler->>DB: UPDATE status='COMPLETED'
            else Failure + retries left
                Scheduler->>DB: UPDATE status='PENDING', retry_count++
            else Failure + no retries left
                Scheduler->>DB: UPDATE status='FAILED'
            end
        end
    end
```

### Deduplication Safeguards

NotifyChain employs **two-layer deduplication**:

| Layer | Service | Storage | Window | Survival |
|-------|---------|---------|--------|----------|
| **Persistent** | `EventDeduplicationService` | SQLite `processed_events` | Permanent | Restarts + reorgs |
| **In-Memory** | `NotificationDeduplicator` | LRU cache (10k entries) | 60 seconds | Session only |

**Reorg Detection** works by comparing event ledger numbers:

1. Each polling cycle compares the first event's ledger with the stored cursor
2. If `new_ledger < last_known_ledger` → reorg detected
3. The event is marked as `is_reorg_duplicate` in SQLite
4. Notification is skipped (already sent during the original chain)

---

## 7. Database Schema

```mermaid
erDiagram
    scheduled_notifications ||--o{ notification_execution_log : has
    notification_templates ||--o{ notification_template_audit_log : audits

    scheduled_notifications {
        int id PK
        text payload "JSON payload"
        varchar notification_type "discord, email, webhook, sms"
        text target_recipient "User ID, webhook URL, or recipient"
        datetime execute_at "When to send"
        datetime created_at
        datetime updated_at
        varchar status "PENDING|PROCESSING|COMPLETED|FAILED|CANCELLED"
        int retry_count
        int max_retries
        datetime processing_started_at
        datetime processing_completed_at
        varchar processor_id "Distributed lock owner"
        datetime lock_expires_at "Lock timeout"
        text last_error
        text error_details "JSON error context"
        text event_id "Original event reference"
        text contract_address "Stellar contract"
        int priority "1-10, lower=higher"
        text metadata "Additional JSON metadata"
    }

    notification_execution_log {
        int id PK
        int scheduled_notification_id FK
        int execution_attempt
        datetime execution_time
        varchar status "SUCCESS|FAILED|RETRY"
        text error_message
        text response_data "JSON response"
        int duration_ms
    }

    processed_events {
        int id PK
        text event_id "Unique RPC event ID"
        text contract_address "Emitting contract"
        text fingerprint "UK: contract_address:event_id"
        int ledger_number "Event ledger sequence"
        text tx_hash "Transaction hash"
        varchar event_type "contract, system, etc"
        datetime processed_at
        boolean is_reorg_duplicate "Detected via reorg"
        int reorg_detection_count
        datetime last_redetected_at
        varchar status "PROCESSED|SKIPPED|ERROR"
        boolean notification_sent
        text error_reason
    }

    polling_cursors {
        int id PK
        text contract_address UK "One cursor per contract"
        text cursor "Last RPC cursor"
        int ledger_number "Last ledger number"
        datetime updated_at
        boolean reorg_detected
        int reorg_detection_count
    }

    notification_templates {
        text id PK
        text name
        text type
        text subject
        text body
        text variables
        text metadata
        datetime created_at
        datetime updated_at
    }

    notification_template_audit_log {
        int id PK
        text template_id FK
        text actor
        text action "default: UPDATE"
        datetime changed_at
        text previous_snapshot
        text new_snapshot
    }

    rate_limit_events {
        int id PK
        text client_id "IP or API key"
        varchar client_type "IP|API_KEY"
        text endpoint "Request path"
        varchar method "GET|POST|PUT|DELETE"
        datetime timestamp
        int limit_threshold
        int window_ms
    }
```

### Index Strategy

| Table | Index | Purpose |
|-------|-------|---------|
| `scheduled_notifications` | `status + execute_at` WHERE `status='PENDING'` | Scheduler polling query |
| `scheduled_notifications` | `lock_expires_at + status` WHERE `status='PROCESSING'` | Stale lock recovery |
| `processed_events` | `fingerprint` (UNIQUE) | Fast dedup lookup |
| `processed_events` | `contract_address + event_id` | Contract-scoped lookup |
| `processed_events` | `ledger_number + contract_address` | Reorg detection |
| `polling_cursors` | `contract_address` (UNIQUE) | Cursor retrieval |

---

## 8. Deployment Architecture

### Single Instance

```mermaid
flowchart LR
    subgraph "Single Host / Container"
        LISTENER["Listener Service<br/>Node.js Process"]
        DB[("SQLite<br/>File")]
        DISCORD_SEND["Discord Webhook"]
    end

    STELLAR[("Stellar Network")]
    DASH["Dashboard<br/>React + Vite"]

    STELLAR -->|RPC polling| LISTENER
    LISTENER --> DB
    LISTENER -->|POST| DISCORD_SEND
    LISTENER -->|HTTP API| DASH
```

### Multi-Instance (Horizontal Scaling)

```mermaid
flowchart TB
    subgraph "Shared Storage"
        DB[("SQLite<br/>notifications.db")]
    end

    subgraph "Instance 1"
        L1["Listener A<br/>processor_id: worker-abc"]
        Q1["EventProcessingQueue"]
        S1["NotificationScheduler"]
    end

    subgraph "Instance 2"
        L2["Listener B<br/>processor_id: worker-xyz"]
        Q2["EventProcessingQueue"]
        S2["NotificationScheduler"]
    end

    STELLAR[("Stellar Network")]
    DISCORD["Discord Webhook"]

    STELLAR -->|poll| L1
    STELLAR -->|poll| L2
    L1 -->|atomic lock| DB
    L2 -->|atomic lock| DB
    L1 --> DISCORD
    L2 --> DISCORD
    S1 -->|atomic UPDATE| DB
    S2 -->|atomic UPDATE| DB
```

Key points for multi-instance:
- SQLite handles concurrent writes via atomic `UPDATE ... WHERE status='PENDING'`
- Each instance has a unique `processor_id` for lock ownership
- Stale lock recovery ensures crashed workers don't block notifications
- Event processing uses independent `EventProcessingQueue` instances

### Configuration Surface

All configuration is via environment variables, parsed and validated in
`listener/src/config.ts`:

| Category | Key Variables |
|----------|--------------|
| **Stellar** | `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `CONTRACT_ADDRESSES` (JSON) |
| **Polling** | `POLL_INTERVAL_MS` (default 30000), `MAX_RECONNECT_ATTEMPTS`, `RECONNECT_DELAY_MS` |
| **API Server** | `EVENTS_API_PORT` (default 8787), `EVENTS_API_CORS_ORIGIN` |
| **Discord** | `DISCORD_WEBHOOK_URL`, `DEDUP_WINDOW_MS`, `DEDUP_MAX_SIZE` |
| **Scheduler** | `SCHEDULER_ENABLED`, `SCHEDULER_POLL_INTERVAL_MS` (default 10000), `SCHEDULER_BATCH_SIZE` (default 10) |
| **Database** | `DATABASE_PATH` (default `./data/notifications.db`) |
| **Rate Limiting** | `RATE_LIMIT_ENABLED`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS` |
| **Retry** | `RETRY_BASE_DELAY_MS` (default 5000), `RETRY_MAX_RETRIES` (default 5) |
| **Logging** | `LOG_LEVEL` (default `info`) |
| **Cleanup** | `CLEANUP_EVENT_RETENTION_MS`, `CLEANUP_INTERVAL_MS` |

---

## 9. Related Documentation

### Architecture Docs
- [`SYSTEM_ARCHITECTURE_DIAGRAM.md`](SYSTEM_ARCHITECTURE_DIAGRAM.md) — **Visual ASCII architecture diagram** covering all on-chain and off-chain components, data flow, event lifecycle, scheduler state machine, deduplication, DB schema, and deployment topologies
- [`ARCHITECTURE_OVERVIEW.md`](ARCHITECTURE_OVERVIEW.md) — Contributor-facing architecture deep-dive
- [`SECURITY_THREAT_MODEL.md`](SECURITY_THREAT_MODEL.md) — Critical assets, trust boundaries, threat-to-mitigation mapping, dependencies, and open risks
- [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) — SQLite tables, relationships, constraints, ER diagram, and indexes
- [`ARCHITECTURE_DIAGRAM.md`](ARCHITECTURE_DIAGRAM.md) — Scheduler retry deduplication flow diagrams
- [`listener/ARCHITECTURE-DIAGRAM.md`](listener/ARCHITECTURE-DIAGRAM.md) — Scheduler subsystem diagrams
- [`Documents/Task Bounty/ARCHITECTURE.md`](Documents/Task%20Bounty/ARCHITECTURE.md) — TaskBounty contract architecture

### Operational Docs
- [`NOTIFICATION_FAILURE_RECOVERY.md`](NOTIFICATION_FAILURE_RECOVERY.md) — Retry lifecycle and recovery
- [`REORG-DEDUPLICATION-MONITORING.md`](REORG-DEDUPLICATION-MONITORING.md) — Reorg detection and monitoring
- [`RATE-LIMITING-IMPLEMENTATION.md`](RATE-LIMITING-IMPLEMENTATION.md) — Rate limiter design
- [`SCHEDULED-NOTIFICATIONS-DELIVERY.md`](SCHEDULED-NOTIFICATIONS-DELIVERY.md) — Delivery semantics
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — Common failure modes

### Reference
- [`listener/API.md`](listener/API.md) — Full REST API specification
- [`NOTIFICATION_PAYLOAD_SCHEMA.md`](NOTIFICATION_PAYLOAD_SCHEMA.md) — Event payload schema
- [`contract/README.md`](contract/README.md) — AutoShare contract ABI reference

---

*Last updated: 2026-06-24. Maintained as part of issue #97.*
