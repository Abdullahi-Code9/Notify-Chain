# NotifyChain

> A contract + off-chain helper system for tracking blockchain events and delivering real-time notifications.

## Overview

NotifyChain is an open-source event monitoring and notification system designed for smart contracts. It combines on-chain event emission with an off-chain listener service to track contract activity and trigger custom actions such as notifications, webhooks, emails, or integrations with external applications.

The project enables developers to build reactive decentralized applications without continuously polling the blockchain.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Event Flow](#event-flow)
4. [Local Development Guide](#local-development-guide)
5. [Smart Contract Upgrade Guide](#smart-contract-upgrade-guide)
6. [Contract API Examples](#contract-api-examples)
7. [Freighter Troubleshooting](#freighter-troubleshooting)
8. [Wallet UX States](#wallet-ux-states)
9. [Features](#features)
10. [Use Cases](#use-cases)
11. [Tech Stack](#tech-stack)
12. [Contributing](#contributing)
13. [License](#license)

> **Listener service docs**:
> - [API Contract and Event Reference](listener/API_CONTRACT_EVENT_REFERENCE.md)
> - [API Usage Cookbook](listener/API_USAGE_COOKBOOK.md)
> - [Listener Configuration](docs/LISTENER-CONFIGURATION.md) — env options, defaults, examples, and recommended values.
> - [Notification Processing Flow](docs/NOTIFICATION-FLOW.md) — blockchain event to delivery stages, diagrams, failure/retry, and troubleshooting.
> - [Notification Lifecycle](NOTIFICATION_LIFECYCLE.md) — end-to-end on-chain/off-chain flow from event detection to delivery, ack, retry, and archival.
> - [Notification Failure Recovery](NOTIFICATION_FAILURE_RECOVERY.md) — retry lifecycle, configuration, and troubleshooting.
>
> **Repository map**: [Project Structure Guide](docs/PROJECT-STRUCTURE.md) — major directories, modules, and where code belongs.
>
> **Event reference**: [Smart Contract Event Reference Guide](CONTRACT_EVENT_REFERENCE.md) — all emitted events, parameters, data types, and usage recommendations for indexers and listeners.
>
> **Dashboard Storybook**: [dashboard/STORYBOOK.md](dashboard/STORYBOOK.md) — component documentation for design and development reviews.
> **API errors**: [API Error Reference](docs/API_ERROR_REFERENCE.md) — every error response the listener API returns, with causes and resolutions.
>
> **Operations**: [Database Backup and Restore](docs/DATABASE_BACKUP_RESTORE.md) — backup strategy, critical data tiers, backup verification, and a tested restore procedure for the listener database.
>
> **Architecture decisions**: [Architecture Decision Records](docs/adr/README.md) — the *why* behind the project's significant technical choices, including the [off-chain listener architecture](docs/adr/0001-off-chain-listener-architecture.md), [Soroban on Stellar](docs/adr/0002-soroban-smart-contracts.md), [SQLite persistence](docs/adr/0003-sqlite-for-local-persistence.md), [TypeScript for the listener](docs/adr/0004-typescript-for-listener-service.md), and the [event deduplication strategy](docs/adr/0005-event-deduplication-strategy.md).
>
> **Contributor guides**: [Git Workflow](docs/GIT_WORKFLOW.md) · [Contributor Troubleshooting](docs/CONTRIBUTOR_TROUBLESHOOTING.md) · [Blockchain Event Lifecycle](CONTRIBUTOR_EVENT_LIFECYCLE.md)

---

## Architecture Overview

NotifyChain is built from three cooperating layers. On-chain contracts emit
events, an off-chain listener turns those events into notifications and a
queryable feed, and a dashboard renders that feed for humans. Each layer can be
run and developed independently.

| Component | Location | Tech | Responsibility |
|-----------|----------|------|----------------|
| **Smart Contracts** | `contract/`, `Documents/Task Bounty/` | Soroban / Rust | Execute business logic and emit a structured event for every important state change |
| **Listener Service** | `listener/` | Node.js / TypeScript | Poll the Stellar network for contract events, deduplicate them, push notifications, and expose an HTTP events API |
| **Dashboard** | `dashboard/` | React + Vite | Fetch the listener's events API and display real-time contract activity |

### How the Components Interact

```
        On-chain                         Off-chain
 ┌────────────────────┐         ┌──────────────────────────────┐
 │  Soroban Contracts │         │        Listener Service       │
 │  (TaskBounty,      │  emit   │  ┌────────────────────────┐   │
 │   AutoShare)       │ ──────► │  │ EventSubscriber (poll) │   │
 │                    │ events  │  └───────────┬────────────┘   │
 └────────────────────┘         │              ▼                │
            ▲                    │  ┌────────────────────────┐  │
            │ invoke             │  │ Deduplicator + Registry │ │
            │                    │  └───────────┬────────────┘  │
 ┌────────────────────┐         │      ┌────────┴────────┐      │
 │   Users / dApps    │         │      ▼                 ▼      │
 └────────────────────┘         │  Discord         /api/events  │
                                │  webhook          HTTP API     │
                                └──────────────────────┬─────────┘
                                                       │ fetch
                                                       ▼
                                            ┌────────────────────┐
                                            │  React Dashboard   │
                                            └────────────────────┘
```

> A visual system architecture diagram with Mermaid diagrams spanning
> all layers is available in
> [`SYSTEM_ARCHITECTURE.md`](SYSTEM_ARCHITECTURE.md). It provides the
> quickest way to understand the full system at a glance.
>
> A high-level, contributor-facing architecture guide lives in
> [`ARCHITECTURE_OVERVIEW.md`](ARCHITECTURE_OVERVIEW.md). It walks new
> contributors through the on-chain, off-chain, and dashboard layers,
> the end-to-end data flow, and links out to every subsystem doc.
>
> A more detailed, contract-level architecture write-up lives in
> [`Documents/Task Bounty/ARCHITECTURE.md`](Documents/Task%20Bounty/ARCHITECTURE.md).
>
> **New to the codebase?** The
> [API & Notification Sequence Diagrams](API_SEQUENCE_DIAGRAMS.md)
> visually trace every major data flow — from client request to subscriber
> delivery and from on-chain event to dashboard render.

### Contract Responsibilities

The on-chain layer is the source of truth. Each contract owns its own state and
emits typed events (see [Event Flow](#event-flow)) that the off-chain layer
consumes. Two example contracts ship with the project:

#### 1. TaskBounty Contract (`Documents/Task Bounty/`)

A decentralized task and reward board that allows users to:
- Create tasks with escrowed rewards
- Submit work
- Approve/reject submissions
- Raise disputes
- Manage payouts automatically

Key Modules:
- `types.rs`: Data structures and enums
- `storage.rs`: Storage access patterns
- `task.rs`: Task creation and management
- `submission.rs`: Work submission handling
- `dispute.rs`: Dispute resolution
- `events.rs`: Event emission

#### 2. AutoShare Contract (`contract/contracts/hello-world/`)

A subscription and group management contract that allows users to:
- Create sharing groups
- Manage group members
- Handle subscription payments
- Track usage
- Admin management
- Expose contract version for verification

Key Modules:
- `base/types.rs`: Data structures
- `base/errors.rs`: Error definitions
- `base/events.rs`: Event emission
- `interfaces/autoshare.rs`: Interface definitions
- `autoshare_logic.rs`: Core business logic
- `mock_token.rs`: Mock token for testing
- `tests/`: Comprehensive test suite

---

## Project Structure

> **Full directory guide:** [docs/PROJECT-STRUCTURE.md](docs/PROJECT-STRUCTURE.md) —
> purpose and responsibilities of every major directory and module, plus where
> new code should live.

```
Notify-Chain/
├── contract/                          # Soroban contract workspace
│   ├── contracts/
│   │   └── hello-world/               # AutoShare contract implementation
│   │       ├── src/
│   │       │   ├── base/
│   │       │   │   ├── errors.rs     # Error definitions
│   │       │   │   ├── events.rs     # Event types
│   │       │   │   └── types.rs      # Data structures
│   │       │   ├── interfaces/
│   │       │   │   └── autoshare.rs  # Interfaces
│   │       │   ├── tests/
│   │       │   │   ├── autoshare_test.rs
│   │       │   │   ├── mock_token_test.rs
│   │       │   │   ├── pause_test.rs
│   │       │   │   ├── test_utils.rs
│   │       │   │   └── test_utils_test.rs
│   │       │   ├── autoshare_logic.rs # Core contract logic
│   │       │   ├── lib.rs            # Contract entry point
│   │       │   └── mock_token.rs     # Mock token for testing
│   │       ├── Cargo.toml
│   │       ├── Makefile
│   │       └── build_log.txt
│   ├── Cargo.toml                    # Workspace configuration
│   └── README.md
├── listener/                         # Off-chain listener service (Node + TS)
│   └── src/
│       ├── api/                      # Events HTTP API (/api/events, /health)
│       ├── services/                 # Subscriber, deduplicator, Discord notifier
│       ├── store/                    # In-memory event registry
│       ├── utils/                    # Logging, formatting, helpers
│       └── index.ts                  # Service entry point
├── dashboard/                        # Real-time event dashboard (React + Vite)
│   └── src/
│       ├── components/               # Event list / card / filter UI
│       ├── services/                 # Events API client
│       └── store/                    # Client-side event store (Zustand)
├── Documents/
│   ├── Task Bounty/                  # TaskBounty contract and docs
│   │   ├── src/
│   │   │   ├── dispute.rs
│   │   │   ├── events.rs
│   │   │   ├── lib.rs
│   │   │   ├── storage.rs
│   │   │   ├── submission.rs
│   │   │   ├── task.rs
│   │   │   ├── test.rs
│   │   │   └── types.rs
│   │   ├── API.md
│   │   ├── ARCHITECTURE.md
│   │   ├── CONTRIBUTING.md
│   │   ├── PROJECT_CHECKLIST.md
│   │   ├── PROJECT_OVERVIEW.md
│   │   ├── README.md
│   │   ├── SETUP.md
│   │   ├── SUMMARY.md
│   │   ├── WORKFLOWS.md
│   │   └── Cargo.toml
│   └── Stellar-save/
├── .vscode/
│   └── settings.json
├── README.md                        # This file
├── ARCHITECTURE_OVERVIEW.md         # High-level architecture guide (issue #137)
├── SYSTEM_ARCHITECTURE.md           # Visual system architecture with Mermaid diagrams (issue #97)
└── .gitignore
```

---

## Event Flow

> **Processing flow guide:** [Notification Processing Flow](docs/NOTIFICATION-FLOW.md) — event detection through delivery, retries, and DLQ.
>
> 📊 **See also:** [API & Notification Sequence Diagrams](API_SEQUENCE_DIAGRAMS.md) — Mermaid diagrams that visually trace the complete notification request flow, on-chain event processing lifecycle, scheduled delivery states, retry/failure recovery, and dashboard data fetch.

### End-to-End Notification Flow

This is how a single on-chain action becomes a delivered notification:

```
1. A user invokes a contract function (e.g. create_task)
   ↓
2. The contract updates state and emits a typed event
   ↓
3. The listener's EventSubscriber polls the Stellar RPC and picks up the event
   ↓
4. The event is validated, parsed, and recorded in the in-memory event registry
   ↓
5. The deduplicator drops events already seen (by contract + event id)
   ↓
6. A Discord notification is sent (if a webhook is configured)
   ↓
7. The dashboard fetches GET /api/events and renders the new activity
```

Key pieces of the off-chain pipeline:

- **`EventSubscriber`** (`listener/src/services/event-subscriber.ts`) polls the
  configured contracts on an interval and reconnects on failure.
- **`NotificationDeduplicator`** (`listener/src/services/notification-deduplicator.ts`)
  prevents the same event from being notified twice.
- **`DiscordNotificationService`** (`listener/src/services/discord-notification.ts`)
  formats and delivers notifications.
- **Events API** (`listener/src/api/events-server.ts`) exposes `GET /api/events`
  for the dashboard and `GET /health` for monitoring.

The contract events that drive this flow are listed below.

### 1. TaskBounty Contract Events

| Event | Trigger | Data Included |
|-------|---------|---------------|
| `TaskCreated` | When a new task is created | Task ID, Poster address, Title, Reward, Deadline |
| `WorkSubmitted` | When work is submitted for a task | Task ID, Submission ID, Contributor, Work URL |
| `SubmissionApproved` | When a submission is approved | Task ID, Submission ID, Contributor, Reward |
| `SubmissionRejected` | When a submission is rejected | Task ID, Submission ID, Contributor |
| `TaskCancelled` | When a task is cancelled | Task ID, Poster address |
| `DisputeRaised` | When a dispute is raised | Task ID, Submission ID, Raiser, Reason |

#### Example Event Flow (Task Creation → Submission → Approval)

```
1. Poster calls create_task()
   ↓
2. Contract escrows reward tokens
   ↓
3. Contract emits TaskCreated event
   ↓
4. Contributor calls submit_work()
   ↓
5. Contract emits WorkSubmitted event
   ↓
6. Poster calls approve_submission()
   ↓
7. Contract transfers reward to contributor
   ↓
8. Contract emits SubmissionApproved event
```

### 2. AutoShare Contract Events

| Event | Trigger | Data Included |
|-------|---------|---------------|
| `AutoshareCreated` | When a new AutoShare group is created | Creator address, Group ID |
| `AutoshareUpdated` | When a group is updated | Updater address, Group ID |
| `ContractPaused` | When the contract is paused | N/A |
| `ContractUnpaused` | When the contract is unpaused | N/A |
| `GroupDeactivated` | When a group is deactivated | Creator address, Group ID |
| `GroupActivated` | When a group is activated | Creator address, Group ID |
| `AdminTransferred` | When admin rights are transferred | Old admin, New admin |
| `Withdrawal` | When tokens are withdrawn | Token address, Recipient, Amount |

---

## Local Development Guide

### Prerequisites

Before getting started, make sure you have the following installed:

1. **Rust**: The programming language used for Soroban contracts
2. **WebAssembly Target**: For compiling to Wasm
3. **Stellar CLI**: For interacting with Soroban contracts

#### Installing Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

Verify installation:
```bash
rustc --version
cargo --version
```

#### Adding WebAssembly Target

```bash
rustup target add wasm32-unknown-unknown
```

#### Installing Stellar CLI

```bash
cargo install --locked stellar-cli --features opt
```

Verify installation:
```bash
stellar --version
```

### Setting Up the Project

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Core-Foundry/Notify-Chain.git
   cd Notify-Chain
   ```

2. **Building the AutoShare contract**:
   ```bash
   cd contract
   stellar contract build
   ```

3. **Running tests for AutoShare contract**:
   ```bash
   cd contracts/hello-world
   cargo test
   ```

4. **Building the TaskBounty contract**:
   ```bash
   cd ../../Documents/Task\ Bounty
   cargo build --target wasm32-unknown-unknown --release
   # Or using Stellar CLI:
   stellar contract build
   ```

5. **Running tests for TaskBounty contract**:
   ```bash
   cargo test
   ```

### Using Stellar CLI

#### 1. Generate a Test Identity

```bash
stellar keys generate test-user --network testnet
```

#### 2. Fund Your Identity with Test XLM

```bash
stellar keys fund test-user --network testnet
```

#### 3. Deploy a Contract to Testnet

```bash
cd contract/contracts/hello-world
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/hello_world.wasm \
  --source test-user \
  --network testnet
```

#### 4. Initialize the Contract

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source test-user \
  --network testnet \
  -- \
  initialize_admin \
  --admin <ADMIN_ADDRESS>
```

### Useful Commands

| Command | Purpose |
|---------|---------|
| `stellar contract build` | Build a contract |
| `cargo test` | Run tests |
| `stellar contract deploy` | Deploy a contract |
| `stellar contract invoke` | Call a contract function |
| `stellar contract optimize` | Optimize contract for deployment |
| `stellar keys list` | List your identities |

### IDE Setup (VS Code)

Install the following extensions for a smooth development experience:

1. [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) - Rust language support
2. [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) - Debugger
3. [Better TOML](https://marketplace.visualstudio.com/items?itemName=bungcip.better-toml) - TOML file support

Add this to `.vscode/settings.json`:
```json
{
  "rust-analyzer.cargo.target": "wasm32-unknown-unknown",
  "rust-analyzer.checkOnSave.allTargets": false
}
```

---

## Smart Contract Upgrade Guide

Before changing contract storage, public methods, event schemas, authorization
rules, or deployment artifacts, read the
[Smart Contract Upgrade Guide](CONTRACT_UPGRADE_GUIDE.md). It documents the
recommended upgrade workflow, prerequisites, testnet verification steps,
rollback procedures, risk checklist, and PR template for NotifyChain contract
changes.

---

## Contract API Examples

Full examples with concrete parameter values live in [`docs/contract-api.md`](docs/contract-api.md).
Quick reference below.

### subscribe — create a group

```bash
stellar contract invoke \
  --id <CONTRACT_ID> --source creator-key --network testnet \
  -- create \
  --id 0000000000000000000000000000000000000000000000000000000000000001 \
  --name "Team Alpha Plan" \
  --creator GABC1234...XYZ \
  --usage_count 100 \
  --payment_token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

Expected: group stored on-chain with `is_active = true`; `AutoshareCreated` event emitted; creator debited `100 × usage_fee` tokens.

### execute_payment — top up usages

```bash
stellar contract invoke \
  --id <CONTRACT_ID> --source payer-key --network testnet \
  -- topup_subscription \
  --id 0000000000000000000000000000000000000000000000000000000000000001 \
  --additional_usages 50 \
  --payment_token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --payer GABC1234...XYZ
```

Expected: `usage_count` increases by 50; payer debited `50 × usage_fee`; `PaymentHistory` record appended.

### cancel — deactivate a group

```bash
stellar contract invoke \
  --id <CONTRACT_ID> --source creator-key --network testnet \
  -- deactivate_group \
  --id 0000000000000000000000000000000000000000000000000000000000000001 \
  --caller GABC1234...XYZ
```

Expected: `is_active` set to `false`; `GroupDeactivated` event emitted; subsequent payment calls will fail.

---

## Freighter Troubleshooting

Common Freighter wallet issues and how to resolve them.

### Extension not detected

**Symptom:** `window.freighter` is `undefined` after page load.

**Steps:**
1. Install the [Freighter extension](https://www.freighter.app/) for Chrome or Firefox.
2. Refresh the page — Freighter injects `window.freighter` on load.
3. If still undefined, check that the extension is enabled in your browser's extension manager.
4. Disable other wallet extensions temporarily; some conflict with Freighter's injection.

### Connection request never appears

**Symptom:** Calling `freighter.requestAccess()` returns but no popup opens.

**Steps:**
1. Click the Freighter icon in the browser toolbar and unlock the wallet with your password.
2. Check that the site URL matches the allowed origins in Freighter → Settings → Connected Apps.
3. Disable popup-blocking for `localhost` or your dApp domain.
4. Try in an incognito window with only Freighter enabled.

### User rejected the connection

**Symptom:** `freighter.requestAccess()` throws or returns `{ error: "User declined" }`.

**Steps:**
1. Re-prompt the user — the rejection is not permanent.
2. If auto-rejected, go to Freighter → Connected Apps and remove the site entry, then retry.

### Signing request times out or hangs

**Symptom:** `freighter.signTransaction()` never resolves.

**Steps:**
1. Unlock Freighter and switch to the correct network (Testnet / Mainnet).
2. Check that the transaction's `networkPassphrase` matches the network selected in Freighter.
3. Ensure the transaction fee is sufficient — underfunded transactions are silently dropped.
4. Rebuild the transaction with a fresh sequence number if the account state changed.

### Wrong network selected

**Symptom:** Transaction is signed but fails with `txBAD_SEQ` or similar.

**Steps:**
1. Open Freighter and switch to the matching network (Testnet for development, Mainnet for production).
2. Verify `Networks.TESTNET` / `Networks.MAINNET` passphrase is passed to the transaction builder.

### Permission prompt appears on every page load

**Symptom:** Freighter asks for access each session.

**Steps:**
1. Call `freighter.isConnected()` before `requestAccess()`; skip the prompt when already connected.
2. Ensure your dApp is served over HTTPS (or `localhost`) — Freighter restricts persistent permissions to secure origins.

---

## Wallet UX States

The frontend (legacy Next.js analytics app under `frontend/`) models four wallet connection states. Every UI that depends on the wallet must handle all of them.

| State | Description | User-facing message |
|-------|-------------|---------------------|
| `disconnected` | No wallet connected or access not yet granted | "Connect your Freighter wallet to continue." |
| `connected` | Wallet access granted, public key available, no pending action | "Wallet connected: `G…XYZ`" |
| `waiting_for_signature` | Transaction built and sent to Freighter, awaiting user approval | "Check Freighter — please approve the transaction." |
| `error` | Connection failed, user rejected, or transaction error | "Wallet error: \<message\>. Please try again." |

### State transition diagram

```
disconnected
    │  user clicks "Connect"
    ▼
[requestAccess()]
    │ granted          │ rejected / error
    ▼                  ▼
connected           error ──► disconnected (retry)
    │  user submits form
    ▼
[signTransaction()]
    │ pending approval
    ▼
waiting_for_signature
    │ approved         │ rejected / timeout
    ▼                  ▼
connected           error
```

### Implementation reference

See [`frontend/src/components/SubscriptionForm.tsx`](frontend/src/components/SubscriptionForm.tsx) for a working example of all four states.

---

## Features

* 📡 Real-time blockchain event monitoring
* 🔗 Smart contract event emission
* ⚡ Off-chain listener service
* 🔔 Custom notification triggers
* 🌐 Webhook support for external integrations
* 📝 Event logging and processing
* 🛠️ Easy integration into existing dApps
* 🔒 Trustless and transparent event tracking

---

## Use Cases

* Task completion notifications
* Escrow payment updates
* NFT mint alerts
* DAO proposal events
* Bounty submissions
* Token transfers
* Marketplace purchases
* Governance voting updates
* DeFi protocol monitoring
* Custom application events

---

## Tech Stack

### Smart Contracts

* **Soroban** (Stellar smart contracts)
* **Rust**

### Off-chain Services

* Node.js
* TypeScript
* Stellar SDK
* React + Vite (dashboard)

### Notification Providers

* Discord (implemented)
* Email, Telegram, Slack, Webhooks, Push Notifications (planned)

---

## Developer Tools

### Configuration Drift Detection

NotifyChain includes an automated configuration drift detection tool that identifies environment variables documented in `.env.example` files but no longer used in the codebase.

**Usage:**
```bash
# Check for unused configuration variables
npm run lint:config

# With verbose output
npm run lint:config:verbose

# Using Make
make lint-config
```

**Documentation:** See [CONFIG_DRIFT_DETECTION.md](docs/CONFIG_DRIFT_DETECTION.md)

---

## Contributing

Contributions are welcome! Please follow these steps (or start with the canonical workflow guide):

- [`CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md`](CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md)
- [`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md) — branching strategy, commit conventions, and the PR process
- [`docs/CONTRIBUTOR_TROUBLESHOOTING.md`](docs/CONTRIBUTOR_TROUBLESHOOTING.md) — fixes for common build, test, and workflow problems
- [`docs/adr/README.md`](docs/adr/README.md) — architecture decision records; read these before proposing a significant design change
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — planned features and milestones

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to your branch
5. Open a Pull Request

Please follow the project's coding standards and include tests where applicable.

**Before committing:**
- Run `npm run lint:config` to check for configuration drift
- Ensure all tests pass
- Update documentation as needed

For more detailed contribution guidelines, check:
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md`](CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md)
- `Documents/Task Bounty/CONTRIBUTING.md` (TaskBounty contract-specific)

---

## License

This project is licensed under the MIT License.

---

## Acknowledgements

NotifyChain is built to simplify event-driven blockchain development by bridging smart contract events with off-chain automation and notification systems.

Built on [Stellar](https://www.stellar.org/) and [Soroban](https://soroban.stellar.org/).

## Staging Environment Instructions
To run the staging environment locally:
1. Export environment variables: `export $(cat listener/.env.staging | xargs)`
2. Build and run listener: `cd listener && npm ci && npm run build && npm start`
3. Verify the service is up: `curl http://localhost:8787/health`
