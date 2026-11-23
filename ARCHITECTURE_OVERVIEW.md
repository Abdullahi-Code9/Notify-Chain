# NotifyChain — Architecture Overview Guide

> **Audience**: New contributors, integrators, and reviewers who want a single
> document that explains *how NotifyChain fits together* before they dig into
> the per-component docs.

This guide gives you a high-level mental model of the system: what each layer
is responsible for, how data moves between them, and which files in the
repository implement each piece.

> **New to NotifyChain?** Start with
> [`SYSTEM_ARCHITECTURE_DIAGRAM.md`](SYSTEM_ARCHITECTURE_DIAGRAM.md) for a
> complete visual ASCII architecture diagram covering all components and data
> flow, or [`SYSTEM_ARCHITECTURE.md`](SYSTEM_ARCHITECTURE.md) for Mermaid
> diagrams and a structured narrative. Then return here for the detailed
> walkthrough.

> **Security reviewers:** See [`SECURITY_THREAT_MODEL.md`](SECURITY_THREAT_MODEL.md)
> for the full threat model — critical assets, trust boundaries, attack vectors,
> mitigations, and open risks — maintained alongside this document.

It does **not** replace the deeper subsystem docs linked at the end — read it
first, then dive into the linked material as needed.

---

## 1. What NotifyChain Is

NotifyChain is an **event monitoring and notification platform for Stellar
(Soroban) smart contracts**. It exists to make on-chain activity *visible and
actionable* to humans and external systems without requiring continuous RPC
polling from every consumer.

The system solves three problems:

1. **Discoverability** — turning low-level Soroban contract events into a
   structured, queryable feed.
2. **Delivery** — pushing that feed to Discord webhooks, scheduled
   notifications, and HTTP API consumers.
3. **Insight** — rendering the feed through a React dashboard for human
   operators.

The project is structured so that each of these concerns lives in a
separate layer that can be developed, tested, and deployed independently.

---

## 2. System at a Glance

```
                ┌──────────────────────────────────────────────┐
                │              NotifyChain                     │
                │                                              │
   On-chain     │  ┌────────────────────┐                      │
 ┌────────────┐ │  │  Soroban Contracts │  emit  ┌───────────┐ │
 │  Users /   │ │  │   (TaskBounty,     │ ─────▶ │  Stellar  │ │
 │  dApps     │ │  │    AutoShare, …)   │ events │  Network  │ │
 └─────┬──────┘ │  └────────────────────┘        └─────┬─────┘ │
       │ invoke│                                      │       │
       ▼        │                                      ▼       │
 ┌────────────┐ │  ┌────────────────────────────────────────┐ │
 │  Contract  │ │  │          Listener Service               │ │
 │   Calls    │ │  │   (Node.js + TypeScript off-chain)     │ │
 └────────────┘ │  │                                        │ │
                │  │  EventSubscriber ─▶ Deduplicator       │ │
                │  │        │                               │ │
                │  │        ▼                               │ │
                │  │  ┌──────────────┐  ┌───────────────┐   │ │
                │  │  │ Notification │  │  REST API     │   │ │
                │  │  │  Dispatcher  │  │  /api/events  │   │ │
                │  │  └──────┬───────┘  └───────┬───────┘   │ │
                │  └─────────┼──────────────────┼───────────┘ │
                │            │                  │             │
                │            ▼                  ▼             │
                │   ┌────────────────┐  ┌──────────────────┐  │
                │   │ Discord /      │  │   Dashboard      │  │
                │   │ Webhook /      │  │  (React + Vite)  │  │
                │   │ Email target   │  │                  │  │
                │   └────────────────┘  └──────────────────┘  │
                └──────────────────────────────────────────────┘
```

| Layer | Where it lives | Tech | One-line responsibility |
|-------|----------------|------|--------------------------|
| Smart Contracts | `contract/`, `Documents/Task Bounty/` | Soroban / Rust | Execute business logic; emit one structured event per state change |
| Listener Service | `listener/` | Node.js + TypeScript | Poll the network, deduplicate events, dispatch notifications, expose HTTP API |
| Dashboard | `dashboard/` | React + Vite | Render the events feed for human operators |
| Documentation | `*.md`, `Documents/`, `issues/` | Markdown | Onboarding, architecture, contracts, ops runbooks |

---

## 3. Layer 1 — Smart Contracts (On-Chain Source of Truth)

The on-chain layer is the canonical source of truth. Every state transition is
recorded in contract storage **and** published as a typed Soroban event. The
listener never infers state from anything other than those events.

### 3.1 Contract Catalog

Two reference contracts ship with the repository:

| Contract | Path | Purpose |
|----------|------|---------|
| **TaskBounty** | `Documents/Task Bounty/` | Decentralized task + reward board. Users create tasks with escrowed rewards, submit work, approve/reject submissions, raise disputes, and trigger payouts. |
| **AutoShare** | `contract/contracts/hello-world/` | Subscription and group management. Handles group creation, member management, subscription payments, usage tracking, admin controls, and version exposure. |

Both contracts follow the same skeleton:

```
contracts/<name>/
├── src/
│   ├── base/
│   │   ├── errors.rs     # Error variants and codes
│   │   ├── events.rs     # Soroban event types emitted on-chain
│   │   └── types.rs      # Data structures (structs, enums)
│   ├── interfaces/       # Optional trait-style abstractions
│   ├── tests/            # Soroban test harness using Env::default()
│   ├── <name>_logic.rs   # Core business logic
│   └── lib.rs            # Contract entry point (#[contract])
├── Cargo.toml
└── Makefile
```

### 3.2 Why Two Reference Contracts?

The repo deliberately ships two contracts with **different shapes** so the
event-emission patterns stay general:

- **TaskBounty** uses an explicit lifecycle (`Open → InProgress → Completed
  / Cancelled / Disputed`) and emits per-lifecycle events. It's a good model
  for any "entity with stages" pattern.
- **AutoShare** uses a smaller CRUD surface (create group, add member, pay
  subscription) and emits a uniform `Action` event tagged with an enum.
  It's a good model for "actions against a singleton resource" pattern.

When you add a new contract, decide which shape it fits before writing the
event types — the listener's deduplicator keys on event topic hash, so
adding a new contract is additive, but the event schema should be stable
across versions.

### 3.3 On-Chain → Off-Chain Boundary

The contract layer commits to a single rule:

> **Anything the listener needs to know is published as a Soroban event.**

If a state change is not published as an event, the listener will *never*
see it. Conversely, the listener treats off-chain state (its own database,
its in-memory cache) as a derivable cache — it can be rebuilt from the
event stream at any time by replaying the chain.

This boundary keeps contracts simple and the listener replaceable.

---

## 4. Layer 2 — Listener Service (Off-Chain Event Engine)

The listener is a long-running Node.js process that turns the raw Soroban
event stream into three concrete things:

1. **A deduplicated, queryable event log** (exposed via `GET /api/events`).
2. **Outbound notifications** to Discord, webhooks, and (configurable) any
   HTTP target.
3. **A scheduler** for future-dated notifications, with at-least-once
   delivery semantics backed by SQLite locks.

### 4.1 Internal Pipeline

```
                Stellar RPC
                     │  getEvents()
                     ▼
 ┌────────────────────────────────────┐
 │  EventSubscriber                   │
 │  - Poll on interval                │
 │  - Cursor persisted to SQLite      │
 │  - Detect reorgs from ledger nums  │
 └────────────────┬───────────────────┘
                  │ raw events
                  ▼
 ┌────────────────────────────────────────┐
 │  Persistent Deduplication Layer        │
 │  - EventDeduplicationService           │
 │  - Check processed_events table        │
 │  - Mark reorg duplicates               │
 │  - Track polling cursors               │
 │  - (Prevents reorg-induced dups)       │
 └────────────────┬───────────────────────┘
                  │ 
                  ▼
 ┌────────────────────────────────────┐
 │  In-Memory Deduplicator            │
 │  - NotificationDeduplicator (LRU)  │
 │  - Event Registry                  │
 │  - (Short-term cache layer)        │
 └────────────────┬───────────────────┘
                  │ normalized events
        ┌─────────┴──────────┐
        ▼                    ▼
 ┌──────────────────┐  ┌──────────────────┐
 │ Notification     │  │ REST API         │
 │ Dispatcher       │  │ events-server.ts │
 │  - Discord       │  │  - /api/events   │
 │  - Webhook       │  │  - /api/schedule │
 │  - Email         │  │  - /api/stats    │
 └──────────────────┘  └──────────────────┘
                                  ▲
                                  │ GET
                                  │
                       ┌──────────┴──────────┐
                       │  Dashboard (React)  │
                       └─────────────────────┘
```

### 4.1a Event Deduplication Safeguards

To handle blockchain reorganizations (reorgs), NotifyChain employs **two-layer
deduplication**:

#### Layer 1: Persistent Deduplication (survives reorgs & restarts)
- **Service**: `EventDeduplicationService` in `listener/src/services/`
- **Storage**: `processed_events` and `polling_cursors` SQLite tables
- **Guarantees**:
  - Permanent record of all processed events
  - Detects reorg duplicates by ledger number comparison
  - Persists cursor positions for each contract
  - Survives service restarts

#### Layer 2: In-Memory Deduplication (short-term cache)
- **Service**: `NotificationDeduplicator` (existing)
- **Storage**: In-memory LRU map (60-second default window)
- **Purpose**: Catch recent duplicates without DB hits
- **Complement**: Works alongside persistent layer

**How Reorg Detection Works**:

1. Each polling cycle, compare event ledger with last known `polling_cursors.ledger`
2. If new ledger < last ledger → reorg detected
3. Increment `polling_cursors.reorg_detection_count`
4. When same event re-appears, it's marked as `is_reorg_duplicate = true`
5. Application skips duplicate notification and Discord send

**Example Reorg Scenario**:
```
Normal flow:      Events: e1(L100), e2(L105), e3(L110)
                  Cursor: L110
                  
Reorg occurs:     Ledger drops to L95
                  Cursor detects: 95 < 110 → REORG!
                  
Recovery:         Re-fetch e1(L100), e2(L105)
                  Both detected as duplicates
                  Notifications skipped (already sent)
```

For detailed monitoring, troubleshooting, and operational guidance, see:
- `REORG-DEDUPLICATION-MONITORING.md` — Metrics, alerts, and best practices
- `listener/src/services/event-deduplication-service.ts` — Implementation

### 4.2 Module Map

| Path | Role |
|------|------|
| `listener/src/index.ts` | Process entry point. Wires the subscriber, the dispatcher, and the HTTP server. |
| `listener/src/services/` | Domain services (event subscriber, scheduler, dispatcher). |
| `listener/src/store/` | Persistence layer — SQLite-backed event + schedule repositories. |
| `listener/src/database/` | SQLite migrations and schema. |
| `listener/src/api/` | HTTP routes (events server, scheduler endpoints). |
| `listener/src/scripts/` | Operational scripts (migrate, batch-validate). |
| `listener/src/types/` | Shared TypeScript types mirroring on-chain event shapes. |
| `listener/src/utils/` | Cross-cutting helpers (logging, batching, fixture builders). |
| `listener/src/test-utils/` | Reusable test fixtures and builders. |
| `listener/src/__tests__/` and `listener/src/tests/` | Unit and integration tests (Jest). |
| `listener/src/examples/` | Runnable example consumers of the public API. |

### 4.3 The Scheduler Subsystem

The scheduler is the part of the listener that handles *future-dated*
notifications. It is the most operationally complex piece because it has to
deal with at-least-once delivery across crashes and multi-instance
deployments.

```
┌──────────┐  schedule  ┌──────────────┐  store   ┌──────────────┐
│ Caller   │ ─────────▶ │ Notification │ ───────▶ │   SQLite     │
└──────────┘            │     API      │          │ (scheduled_) │
                        └──────────────┘          │ notifications│
                                                   └──────┬───────┘
                                                          │ tick (10s)
                                                          ▼
                                            ┌────────────────────────┐
                                            │ Background Scheduler   │
                                            │  1. Recover stale lock │
                                            │  2. Fetch PENDING due  │
                                            │  3. Atomic lock UPDATE │
                                            │  4. Dispatch           │
                                            └────────────────────────┘
```

The atomicity guarantee comes from a single SQL pattern:

```sql
UPDATE scheduled_notifications
   SET status = 'PROCESSING',
       processor_id = ?,
       lock_expires_at = NOW() + 60s
 WHERE id = ?
   AND status = 'PENDING'
```

The `WHERE status = 'PENDING'` predicate makes the lock acquisition
race-free across multiple listener instances. Only one worker can flip a
row to `PROCESSING`; the others see `changedRows === 0` and skip it.

For a deeper view of the scheduler's lifecycle, retry strategy, and
operational troubleshooting, see:

- `listener/ARCHITECTURE-DIAGRAM.md` — Scheduler-specific diagrams.
- `NOTIFICATION_FAILURE_RECOVERY.md` — Retry semantics and recovery
  procedures.
- `SCHEDULED-NOTIFICATIONS-DELIVERY.md` — End-to-end delivery semantics.

### 4.4 Configuration Surface

The listener reads its config from environment variables (see
`listener/src/config.ts`). The minimum required to run it locally:

```bash
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
LISTENER_DATABASE_PATH=./listener.db
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
LISTENER_PORT=3000
```

The full list — including scheduler intervals, batch sizes, retry budgets,
and feature flags — lives in `listener/src/config.ts`. New contributors
should read this file before proposing changes to defaults.

---

## 5. Layer 3 — Dashboard (Read-Only Consumer)

The dashboard is a single-page React app served from `dashboard/`. It is a
**strict read-only consumer** of the listener's HTTP API. It never talks to
Stellar directly and never writes back to the listener.

```
dashboard/
├── src/
│   ├── pages/          # Top-level routes (Events, Schedules, Stats)
│   ├── components/     # Reusable UI primitives (cards, lists, search)
│   ├── hooks/          # Custom React hooks for API calls
│   ├── services/       # HTTP client wrappers
│   ├── store/          # State management
│   ├── types/          # TypeScript types shared with the listener API
│   ├── utils/          # Helpers (formatters, dates, validators)
│   └── benchmark/      # Performance regression suite
├── index.html
├── vite.config.ts
└── package.json
```

### 5.1 Why Read-Only?

Keeping the dashboard downstream of the listener keeps the trust boundary
clean: the dashboard cannot pollute the event stream or skip the
deduplicator. If a new feature requires *writing* to the listener (e.g.
"resend this notification"), the right pattern is to add a new endpoint
under `listener/src/api/` and call it from the dashboard — never bypass.

### 5.2 Search & Filtering

The dashboard surfaces search and filter controls on top of `GET
/api/events`. Filter parameters are passed through to the listener's
SQLite query layer, which keeps indexes on the hot columns. See
`PR #122` (search bar with debounced autocomplete) for the canonical
implementation pattern when adding new filters.

---

## 6. End-to-End Data Flow

This is the canonical happy-path trace, from contract invocation to
dashboard render.

```
  ①  User calls a contract method (e.g. `task_bounty.create_task(...)`)
            │
            ▼
  ②  Contract mutates storage and emits a Soroban event
            │      topics: [("task_bounty", task_id), ...]
            │      data:   (TaskPayload)
            ▼
  ③  Listener's EventSubscriber polls the RPC, receives the event
            │
            ▼
  ④  Deduplicator checks the in-memory + DB cache
            │      first time seen  → mark seen, continue
            │      already seen     → drop
            ▼
  ⑤  Event is normalized to the listener's internal schema and
     persisted to the SQLite `events` table
            │
            ├──────────────┐
            ▼              ▼
  ⑥a Notification    ⑥b REST API
      Dispatcher         (events-server.ts)
            │              │
            ▼              ▼
  ⑦a Webhook /       ⑦b Dashboard fetches
      Discord /           /api/events and
      Email target        renders new entry
            │
            ▼
  ⑧  Human sees the notification; clicks through to dashboard;
      sees full event history including this one
```

If any step between ③ and ⑦ fails, the event is still in the SQLite store
(step ⑤), so the system can recover by replaying. The listener's
transaction boundary is the SQLite write — not the network call.

---

## 7. Project Structure (Repository Map)

```
Notify-Chain/
├── contract/                  Soroban workspace
│   ├── contracts/
│   │   └── hello-world/       AutoShare contract (Soroban)
│   └── Cargo.toml             Workspace manifest
├── dashboard/                 React + Vite dashboard (read-only)
├── listener/                  Node.js + TypeScript listener
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
├── Documents/                 Reference docs and contract variants
│   ├── Task Bounty/           TaskBounty contract + its own ARCHITECTURE.md
│   └── Stellar-save/          Archived design specs (read-only context)
├── issues/                    Issue templates + workflow specs
├── .github/                   Workflows, PR templates, issue forms
├── *.md                       Repo-root docs (README, this guide, runbooks)
├── ARCHITECTURE_OVERVIEW.md   ← you are here
└── SYSTEM_ARCHITECTURE.md     Visual system architecture with Mermaid diagrams
```

When you start working on a component:

1. **Touching a contract?** Start in `contract/contracts/<name>/src/` and
   re-read `Documents/Task Bounty/ARCHITECTURE.md` to keep event-schemas
   aligned with the listener.
2. **Touching the listener?** Start in `listener/src/index.ts`, then follow
   the module map in §4.2.
3. **Touching the dashboard?** Start in `dashboard/src/pages/` and check
   the listener API contract in `listener/src/api/` before changing
   request shapes.
4. **Writing or editing docs?** Update this guide (and the linked
   subsystem docs) in the same PR so the architecture stays accurate.

---

## 8. Where to Start as a Contributor

A practical first-day checklist:

1. **Read this file end-to-end** (≈ 15 minutes).
2. **Skim the README.md** at the repo root — it links to the runbooks and
   the local-dev guide.
3. **Set up the local dev environment** following `SETUP.md` (or the
   equivalent section in `Documents/Task Bounty/SETUP.md`).
4. **Pick a `good first issue`** from the issue tracker. Issues labeled
   `Maybe Rewarded` + `GrantFox OSS` are actively funded and have an
   assigned reviewer.
5. **Read the relevant subsystem doc** (links in §9 below) before writing
   any code.
6. **Run the test suite** for the layer you're touching — the listener
   uses Jest, the contracts use `cargo test`, the dashboard uses Jest.
7. **Open a draft PR early** so CI feedback starts flowing. Do not wait
   until "everything is done" to push.

If you get stuck, file an issue or drop a comment on the relevant PR —
maintainers track open questions actively.

---

## 9. Related Resources

### Sequence Diagrams (Issue #354)

Visual walkthroughs of the key data flows — the fastest way to build a
mental model of how the system moves data end-to-end:

| Diagram | What it covers |
|---------|----------------|
| [Notification Request Flow](API_SEQUENCE_DIAGRAMS.md#diagram-1--notification-request-flow) | Client → API validation → scheduled delivery to subscriber |
| [Event Processing Lifecycle](API_SEQUENCE_DIAGRAMS.md#diagram-2--event-processing-lifecycle) | On-chain contract event → EventSubscriber → deduplication → Discord / dashboard |
| [Scheduled Notification Delivery](API_SEQUENCE_DIAGRAMS.md#diagram-3--scheduled-notification-delivery) | POST /api/schedule → SQLite → background scheduler → delivery states |
| [Retry & Failure Recovery](API_SEQUENCE_DIAGRAMS.md#diagram-4--retry--failure-recovery) | In-memory retry queue vs DB-backed retry; stale lock recovery |
| [Dashboard Data Fetch](API_SEQUENCE_DIAGRAMS.md#diagram-5--dashboard-data-fetch) | React dashboard polling /api/events, /health, /api/analytics |

→ **[View all sequence diagrams →](API_SEQUENCE_DIAGRAMS.md)**

---

### Subsystem Architecture Docs (read alongside this guide)

- [Contributor Architecture Deep Dive](file:///workspaces/Notify-Chain/CONTRIBUTOR_ARCHITECTURE_DEEP_DIVE.md) — Deep dive into event indexing, lifecycle, scheduler concurrency model, sequence diagrams, and module mapping.
- `Documents/Task Bounty/ARCHITECTURE.md` — TaskBounty contract lifecycle, state machines, and event schema.
- [`SYSTEM_ARCHITECTURE_DIAGRAM.md`](SYSTEM_ARCHITECTURE_DIAGRAM.md) — **Visual ASCII architecture diagram** with full component map, event lifecycle, scheduler state machine, deduplication flow, DB schema, and deployment topologies.
- [`SYSTEM_ARCHITECTURE.md`](SYSTEM_ARCHITECTURE.md) — Mermaid diagrams and structured narrative covering all layers, component interactions, and data flow.
- `Documents/Task Bounty/ARCHITECTURE.md` — TaskBounty contract
  lifecycle, state machines, and event schema.
- `listener/ARCHITECTURE-DIAGRAM.md` — Scheduler subsystem diagrams.
- `Documents/Task Bounty/PROJECT_OVERVIEW.md` — High-level project pitch for the TaskBounty variant.

### Operational Docs

- [Smart Contract Deployment Playbook](file:///workspaces/Notify-Chain/DEPLOYMENT_PLAYBOOK.md) — Step-by-step deploy instructions, env variables, examples, and verification steps.
- [Smart Contract Event Catalog](file:///workspaces/Notify-Chain/EVENT_CATALOG.md) — Reference catalog for event names, payloads, category/priority routing rules, and SDK parsing examples.
- `README.md` — Top-level project intro and quick links.
- `CONTRIBUTING.md` — Contribution workflow, DCO, PR conventions.
- `TROUBLESHOOTING.md` — Common failure modes and fixes.
- `NOTIFICATION_FAILURE_RECOVERY.md` — Notification retry semantics.
- `NOTIFICATION_PAYLOAD_SCHEMA.md` — Canonical event payload fields.
- `SCHEDULED-NOTIFICATIONS-DELIVERY.md` — Delivery guarantees and edge
  cases.

### Reference Specs (Historical Context)

- `Documents/Stellar-save/.kiro/specs/global-state-management/` — Design
  notes for the listener's state-management layer. Read-only.

### Issue & PR Workflow

- `issues/` — Issue templates and labeled workflows.
- `.github/` — GitHub Actions, PR templates, CODEOWNERS.

---

## 10. Glossary

| Term | Definition |
|------|------------|
| **Soroban** | Stellar's smart-contract runtime. Compiles to WebAssembly. |
| **Event** | A structured log emitted by a contract on a state change. Has topics (filterable) and data (opaque payload). |
| **Cursor** | The listener's persisted "last seen ledger sequence" pointer, used to resume polling after restart. |
| **Deduplicator** | The in-listener component that drops events the system has already processed. Backed by an LRU cache + SQLite index. |
| **Dispatcher** | The in-listener component that turns a deduplicated event into outbound side effects (webhook, Discord, etc.). |
| **Scheduled notification** | A future-dated notification registered through `POST /api/schedule`. Backed by SQLite with atomic row-level locks. |
| **PENDING / PROCESSING / COMPLETED / FAILED** | The four terminal/intermediate states of a scheduled notification. See `SCHEDULED-NOTIFICATIONS-DELIVERY.md`. |
| **DCO** | Developer Certificate of Origin. All commits in this repo require a `Signed-off-by:` trailer. |
| **GrantFox** | The OSS campaign platform that funds `Maybe Rewarded` issues in this repo. Payouts are handled post-merge via the GrantFox dashboard. |

---

## 11. Open Questions / Follow-ups

This guide is intentionally high-level. If you find a topic that deserves
its own deep-dive doc, please open an issue with the label
`documentation` and a short proposal.

Known gaps:

- A **security model** doc covering auth boundaries, replay protection,
  and notification-target allowlists.
- An **observability** doc covering log schema, metrics, and tracing.

---

*Last reviewed: 2026-06-25. Maintained as part of issue #137.*
