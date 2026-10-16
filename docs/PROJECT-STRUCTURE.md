# Project Structure Guide

> Map of the Notify-Chain repository: what each major directory is for, what belongs there, and where related documentation lives.

This guide is for new contributors, maintainers, and anyone onboarding to the codebase. It describes the **current** layout of the repository. For how the layers interact at runtime, see [ARCHITECTURE_OVERVIEW.md](../ARCHITECTURE_OVERVIEW.md) and [SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md).

---

## Table of Contents

1. [High-Level Layout](#high-level-layout)
2. [Top-Level Directory Tree](#top-level-directory-tree)
3. [Major Application Directories](#major-application-directories)
4. [Configuration, Docs, and Tooling](#configuration-docs-and-tooling)
5. [Tests](#tests)
6. [Where to Put New Code](#where-to-put-new-code)
7. [Related Documentation](#related-documentation)

---

## High-Level Layout

Notify-Chain is organized as a **multi-package monorepo** (no root `package.json`). Each major product surface lives in its own top-level directory and can be developed independently:

| Layer | Directory | Stack | Responsibility |
|-------|-----------|-------|----------------|
| On-chain (AutoShare) | `contract/` | Soroban / Rust | Subscription and group management contract; emits typed events |
| On-chain (TaskBounty example) | `Documents/Task Bounty/` | Soroban / Rust | Task/bounty example contract and its own docs |
| Off-chain listener | `listener/` | Node.js / TypeScript | Poll Stellar RPC, deduplicate events, deliver notifications, expose HTTP APIs |
| Operator dashboard | `dashboard/` | React + Vite | Primary UI for events, health, templates, and activity |
| Additional frontend | `frontend/` | React (Vite + Next-style `app/`) | Preferences, subscriptions, and saved-filter UI |

---

## Top-Level Directory Tree

```
Notify-Chain/
├── contract/                 # Soroban workspace (AutoShare / hello-world)
├── listener/                 # Off-chain event listener + HTTP API
├── dashboard/                # Primary React + Vite operator dashboard
├── frontend/                 # Additional React UI (preferences / subscriptions)
├── docs/                     # Curated documentation (this guide lives here)
├── Documents/                # Task Bounty contract + audit notes
├── scripts/                  # Repo-level shell helpers (health check, fuzz coverage)
├── tools/                    # Small CLIs (e.g. filters-cli)
├── issues/                   # Local markdown issue drafts (not GitHub Issues)
├── .github/                  # GitHub Actions workflows and templates
├── .kiro/                    # Kiro agent specs
├── .vscode/                  # Editor settings
├── README.md                 # Project entry point
├── CONTRIBUTING.md           # Contribution guidelines
├── DEVELOPMENT.md            # Local development guide
└── *.md                      # Architecture, lifecycle, deployment, and feature docs
```

Architecturally significant root markdown guides (not every file is listed) include:

- `ARCHITECTURE_OVERVIEW.md`, `SYSTEM_ARCHITECTURE.md`, `BACKEND_ARCHITECTURE.md`
- `NOTIFICATION_LIFECYCLE.md`, `NOTIFICATION_FAILURE_RECOVERY.md`
- `ENVIRONMENT_VARIABLES_AND_SECRETS.md`, `CONTRACT_EVENT_REFERENCE.md`
- `LOCAL_DEVELOPMENT.md`, `DEPLOYMENT_PLAYBOOK.md`, `CONTRIBUTING.md`

---

## Major Application Directories

### `contract/` — Soroban smart contracts

**Purpose:** Rust workspace that builds and tests the AutoShare contract (crate path `contracts/hello-world`).

```
contract/
├── Cargo.toml                      # Workspace configuration (members: contracts/*)
├── README.md
└── contracts/
    └── hello-world/
        ├── Cargo.toml
        ├── Makefile
        └── src/
            ├── lib.rs              # Contract entry point
            ├── autoshare_logic.rs  # Core business logic
            ├── preferences_logic.rs
            ├── reputation_logic.rs
            ├── mock_token.rs       # Test token helper
            ├── base/               # Shared types, errors, events, preferences, validation
            ├── interfaces/         # Contract trait / interface definitions
            └── tests/              # Contract unit and integration tests
```

| Path | Responsibility | Do **not** put here |
|------|----------------|---------------------|
| `base/` | Shared types, errors, events, metadata validation | Off-chain HTTP handlers or Discord delivery |
| `interfaces/` | On-chain interface definitions | Dashboard UI code |
| `*_logic.rs` | Contract business logic | Listener polling or SQLite access |
| `tests/` | Rust contract tests | Jest / React tests |

---

### `listener/` — Off-chain listener service

**Purpose:** Long-running Node.js/TypeScript service that polls Stellar for contract events, maintains an event registry, delivers Discord notifications (when configured), persists scheduled notifications in SQLite, and exposes HTTP APIs for the dashboard and operators.

```
listener/
├── src/
│   ├── index.ts              # Process entry point
│   ├── config.ts             # Environment → typed Config loader
│   ├── api/                  # HTTP servers and routes (events, templates, archive, rate limit)
│   ├── services/             # Event subscriber, queues, schedulers, Discord, archive, metrics
│   ├── store/                # In-memory event registry and preference store
│   ├── database/             # SQLite init, schema SQL, migration system
│   ├── migrations/           # Incremental DB migrations
│   ├── types/                # Shared TypeScript types (Config, notifications, templates)
│   ├── utils/                # Logger, event helpers, validators, pagination
│   ├── scripts/              # DB migrate / check-migrations CLI scripts
│   ├── examples/             # Runnable examples (e.g. schedule notification)
│   ├── test-utils/           # Shared test fixtures
│   ├── tests/                # Integration-style tests
│   └── __tests__/            # Additional Jest suites (lifecycle, load, retry)
├── docs/                     # Listener-scoped docs (templates API, quickstart)
├── .env.example              # Environment variable template
├── package.json
├── tsconfig.json
└── jest.config.js
```

| Module | Responsibility | Do **not** put here |
|--------|----------------|---------------------|
| `api/` | HTTP surface (`/api/events`, schedule, health, webhooks, templates) | Soroban contract logic |
| `services/` | Event ingestion, queues, delivery, schedulers, archive, analytics | React components |
| `store/` | Short-lived in-memory state (registry, preferences) | Durable schema definitions (use `database/`) |
| `database/` + `migrations/` | Schema and durable persistence | Transient request formatting |
| `config.ts` | Load and validate env-based configuration | Hard-coded production secrets |

Service docs also live beside the package (`listener/INSTALLATION.md`, `listener/API.md`, `listener/LOGGING.md`, and others).

---

### `dashboard/` — Primary operator UI

**Purpose:** React + Vite application that consumes the listener’s events and related APIs to show real-time activity, health, templates, and operator workflows.

```
dashboard/
└── src/
    ├── components/     # UI building blocks
    ├── pages/          # Route-level views
    ├── services/       # HTTP clients (events, templates, webhooks, health, …)
    ├── store/          # Client state (e.g. Zustand)
    ├── hooks/          # React hooks
    ├── config/         # Front-end configuration helpers
    ├── types/          # Shared front-end types
    ├── utils/          # Formatting and helpers
    ├── benchmark/      # Performance helpers
    ├── test/           # Test mocks and helpers
    └── __tests__/      # Component / unit tests
```

**Belongs here:** dashboard UI, client-side stores, and API clients aimed at the listener.  
**Does not belong here:** Stellar RPC polling, SQLite schema, or Soroban contract sources.

---

### `frontend/` — Additional React surface

**Purpose:** Separate React app (Vite + Next-style `app/` layout) focused on preferences, subscriptions, and saved filters. Complements `dashboard/`; it is not a replacement for the main operator dashboard.

**Belongs here:** preference/subscription UI and related client services.  
**Does not belong here:** the primary events explorer (prefer `dashboard/`) or listener server code.

---

### `Documents/` — Example contract and audits

```
Documents/
├── Task Bounty/          # Standalone TaskBounty Soroban-style crate + project docs
│   ├── src/              # task, submission, dispute, events, storage, …
│   ├── API.md
│   ├── ARCHITECTURE.md
│   ├── README.md
│   └── …
└── *.md                  # Audit / investigation notes (e.g. API key rotation)
```

`Documents/Task Bounty/` is a **second on-chain example** (task escrow / bounty flows), documented separately from AutoShare under `contract/`.

---

## Configuration, Docs, and Tooling

### `docs/`

Curated documentation that is intentionally kept under `docs/` rather than (or in addition to) the large set of root-level guides:

| Path | Contents |
|------|----------|
| `docs/PROJECT-STRUCTURE.md` | This guide |
| `docs/contract-api.md` | Contract API notes |
| `docs/MONITORING_INTEGRATION.md` | Monitoring integration |
| `docs/ROADMAP.md` | Roadmap |
| `docs/notifications/lifecycle.md` | Scheduled-notification deep dive (points to root lifecycle doc) |

### `.github/`

CI/CD and GitHub metadata:

- `workflows/ci.yml` — dashboard lint/build/test, listener typecheck/test, Rust tests
- `workflows/staging.yml`, `preview.yml`, `preview-cleanup.yml` — deploy / preview flows
- Issue and PR templates as present in the tree

### `scripts/`

Repo-level shell utilities (removed — health check and fuzz coverage scripts are no longer present).

### `tools/`

Small standalone tooling packages:

- `tools/filters-cli/` — `notify-filters` CLI and its unit tests

### `issues/`

Local markdown drafts of historical issue ideas. These are **not** synchronized with GitHub Issues; use GitHub for tracking work.

### `.kiro/` / `.vscode/`

Editor / agent configuration (Kiro specs, VS Code settings). Not part of the runtime product.

---

## Tests

| Location | What they cover |
|----------|-----------------|
| `contract/contracts/hello-world/src/tests/` | Soroban contract unit/integration tests (`cargo test`) |
| `Documents/Task Bounty/` (crate tests) | TaskBounty contract tests |
| `listener/` (`src/tests/`, `src/__tests__/`, `*.test.ts` beside sources) | Jest suites for config, queues, schedulers, APIs |
| `dashboard/src/__tests__/`, `dashboard/src/test/` | Dashboard unit tests and mocks |
| `frontend/` | Vitest suites (see `frontend/package.json`) |
| `tools/filters-cli/__tests__/` | CLI unit tests |

There is **no** root-level test runner; run tests inside the package you are changing.

---

## Where to Put New Code

| If you are changing… | Prefer… |
|----------------------|---------|
| On-chain AutoShare behavior or events | `contract/contracts/hello-world/src/` |
| TaskBounty example behavior | `Documents/Task Bounty/src/` |
| Event polling, delivery, scheduling, SQLite | `listener/src/services/` (+ `database/` / `migrations/` as needed) |
| HTTP routes exposed by the listener | `listener/src/api/` |
| Env-based defaults and validation | `listener/src/config.ts` (and document in env/config guides) |
| Operator-facing events UI | `dashboard/src/` |
| Preferences / subscription UX | `frontend/` |
| Cross-cutting architecture explanation | Root `*.md` or `docs/` (follow existing naming) |

Keep package boundaries: do not import dashboard React code into the listener, and do not embed listener Node modules inside the contracts.

---

## Related Documentation

| Topic | Document |
|-------|----------|
| Architecture (contributor-facing) | [ARCHITECTURE_OVERVIEW.md](../ARCHITECTURE_OVERVIEW.md) |
| Visual system architecture | [SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md) |
| Local development | [DEVELOPMENT.md](../DEVELOPMENT.md), [LOCAL_DEVELOPMENT.md](../LOCAL_DEVELOPMENT.md) |
| Notification lifecycle | [NOTIFICATION_LIFECYCLE.md](../NOTIFICATION_LIFECYCLE.md) |
| Environment variables / secrets | [ENVIRONMENT_VARIABLES_AND_SECRETS.md](../ENVIRONMENT_VARIABLES_AND_SECRETS.md) |
| Contributing | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Contract package README | [contract/README.md](../contract/README.md) |
| Task Bounty overview | [Documents/Task Bounty/PROJECT_OVERVIEW.md](../Documents/Task%20Bounty/PROJECT_OVERVIEW.md) |

---

## Validation Notes

Directory names and responsibilities in this guide were checked against the repository tree under `contract/`, `listener/`, `dashboard/`, `frontend/`, `docs/`, `Documents/`, `scripts/`, `tools/`, `issues/`, and `.github/`. Trivial generated artifacts (`node_modules/`, `dist/`, `target/`) are omitted on purpose.
