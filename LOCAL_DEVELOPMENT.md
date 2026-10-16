# Local Development Guide

This guide walks you through configuring and running every component of NotifyChain on your local machine: the Soroban smart contracts (Rust), the off-chain listener service (Node.js/TypeScript), and the React dashboard.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Repository Setup](#repository-setup)
3. [Environment Variables](#environment-variables)
4. [Database Setup](#database-setup)
5. [Local Services](#local-services)
6. [Running the Applications](#running-the-applications)
7. [Running Tests](#running-tests)
8. [Common Development Commands](#common-development-commands)
9. [IDE Setup (VS Code)](#ide-setup-vs-code)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Install the following tools before continuing.

| Tool | Version | Install |
|------|---------|---------|
| [Node.js](https://nodejs.org) | ≥ 18 (20 recommended) | [nodejs.org](https://nodejs.org) |
| npm | ≥ 9 | Bundled with Node.js |
| [Rust](https://rustup.rs) | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/stellar-cli) | latest | `cargo install --locked stellar-cli --features opt` |
| [Freighter Wallet](https://www.freighter.app/) | latest | Browser extension for signing Stellar transactions |

### Verify installations

```bash
node --version    # v18+
npm --version     # 9+
rustc --version
cargo --version
stellar --version
```

### WebAssembly target (required for contracts)

```bash
rustup target add wasm32-unknown-unknown
```

---

## Repository Setup

```bash
git clone https://github.com/Core-Foundry/Notify-Chain.git
cd Notify-Chain
```

Install dependencies for each package:

```bash
# Listener
cd listener && npm ci && cd ..

# Dashboard
cd dashboard && npm ci && cd ..
```

---

## Environment Variables

Each package has its own `.env` file. Copy the examples and fill in values before starting any service.

### Listener — `listener/.env`

```bash
cp listener/.env.example listener/.env
```

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `STELLAR_NETWORK` | `testnet` | Yes | Network name (`testnet` or `mainnet`) |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org:443` | Yes | Stellar RPC endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Yes | Network passphrase |
| `CONTRACT_ADDRESSES` | — | Yes | JSON array of `{ address, events }` objects |
| `EVENTS_API_PORT` | `8787` | No | Port for the HTTP events API |
| `EVENTS_API_CORS_ORIGIN` | `http://localhost:5173` | No | Allowed CORS origin for the dashboard |
| `DATABASE_PATH` | `./data/notifications.db` | No | Path to the SQLite database file |
| `DISCORD_WEBHOOK_URL` | — | No | Discord webhook URL for notifications |
| `WEBHOOK_SECRETS` | `[]` | No | JSON array of `{ id, secret }` for webhook verification |
| `POLL_INTERVAL_MS` | `30000` | No | How often to poll for new events (ms) |
| `MAX_RECONNECT_ATTEMPTS` | `5` | No | Max reconnect attempts on RPC failure |
| `RECONNECT_DELAY_MS` | `5000` | No | Delay between reconnect attempts (ms) |
| `SCHEDULER_ENABLED` | `true` | No | Enable the scheduled notifications scheduler |
| `SCHEDULER_POLL_INTERVAL_MS` | `10000` | No | How often the scheduler checks for due notifications |
| `SCHEDULER_BATCH_SIZE` | `10` | No | Max notifications processed per scheduler cycle |
| `RATE_LIMIT_ENABLED` | `true` | No | Enable API rate limiting |
| `RATE_LIMIT_WINDOW_MS` | `60000` | No | Rate limit time window (ms) |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | No | Max requests per window per client |

### Dashboard — `dashboard/.env`

```bash
cp dashboard/.env.example dashboard/.env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_EVENTS_API_URL` | `http://localhost:8787/api/events` | Listener API endpoint |
| `VITE_STELLAR_NETWORK` | `TESTNET` | Stellar network (`TESTNET` or `PUBLIC`) |

### Minimal working configuration

**`listener/.env`:**

```env
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
CONTRACT_ADDRESSES=[{"address":"<YOUR_CONTRACT_ID>","events":["*"]}]
EVENTS_API_PORT=8787
EVENTS_API_CORS_ORIGIN=http://localhost:5173
DATABASE_PATH=./data/notifications.db
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
```

**`dashboard/.env`:**

```env
VITE_EVENTS_API_URL=http://localhost:8787/api/events
VITE_STELLAR_NETWORK=TESTNET
```

---

## Database Setup

The listener uses **SQLite** — no external database server is required.

### Initialize the database

```bash
cd listener
npm run migrate
```

This creates the `data/` directory (if it doesn't exist) and applies all pending migrations.

### Reset the database

```bash
rm -f listener/data/notifications.db
cd listener && npm run migrate
```

### Apply template migrations (if applicable)

```bash
cd listener
npm run migrate:templates
```

### Check migration status

```bash
cd listener
npm run check-migrations
```

> The listener tests use an in-memory SQLite database (`:memory:`) so they do not require a migrated local database.

---

## Local Services

NotifyChain has no Docker dependencies — all services run as local Node.js processes.

| Service | Directory | Port | Command |
|---------|-----------|------|---------|
| Listener (events API) | `listener/` | `8787` | `npm run dev` |
| Dashboard (React + Vite) | `dashboard/` | `5173` | `npm run dev` |

### Smart contracts (Rust / Soroban)

Contracts run on the Stellar testnet — there is no local chain to start.

Build the AutoShare contract:

```bash
cd contract
stellar contract build
```

Build the TaskBounty contract:

```bash
cd "Documents/Task Bounty"
stellar contract build
```

Deploy to testnet (one-time setup):

```bash
# Generate and fund a test identity
stellar keys generate dev-account --network testnet
stellar keys fund dev-account --network testnet

# Deploy and note the printed CONTRACT_ID
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/hello_world.wasm \
  --source dev-account \
  --network testnet

# Initialize admin
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source dev-account \
  --network testnet \
  -- initialize_admin \
  --admin <YOUR_PUBLIC_KEY>
```

---

## Running the Applications

Open two terminal tabs from the repo root.

### Listener

```bash
cd listener
npm run dev
```

The listener starts on `http://localhost:8787`. Verify it is running:

```bash
curl http://localhost:8787/health
# {"status":"ok","timestamp":"...","services":{...}}
```

### Dashboard

```bash
cd dashboard
npm run dev
```

The dashboard is available at `http://localhost:5173`.

### Run both together (three tabs)

```bash
# Tab 1 — listener
cd listener && npm run dev

# Tab 2 — dashboard
cd dashboard && npm run dev

# Tab 3 — verify health
curl http://localhost:8787/health
```

---

## Running Tests

### Listener tests (Jest)

```bash
cd listener

# Run all tests
npm test

# Run in watch mode
npm test -- --watch

# Run a specific test file
npm test -- src/store/event-registry.test.ts

# Run with coverage
npm test -- --coverage

# Run stress tests (long-running)
npm run test:stress
```

### Dashboard tests (Jest + Testing Library)

```bash
cd dashboard

# Run all tests
npm test

# Run wallet integration tests only
npm run test:wallet
```

### Contract tests (Rust)

```bash
# AutoShare contract
cd contract
cargo test

# TaskBounty contract
cd "Documents/Task Bounty"
cargo test
```

---

## Common Development Commands

### Install dependencies

```bash
# Listener
cd listener && npm ci

# Dashboard
cd dashboard && npm ci
```

### Build

```bash
# Listener — compiles TypeScript to dist/
cd listener && npm run build

# Dashboard — Vite production build
cd dashboard && npm run build

# Contracts
cd contract && stellar contract build
```

### Lint

```bash
cd listener && npm run lint
cd dashboard && npm run lint
```

### Format check

```bash
cd listener && npm run format:check
cd dashboard && npm run format:check
```

### Typecheck (without emitting files)

```bash
cd listener && npm run typecheck
```

### Database migrations

```bash
cd listener
npm run migrate               # Apply pending migrations
npm run migrate:templates     # Apply template-specific migrations
npm run check-migrations      # Show current migration status
```

### Generate and fund a Stellar test account

```bash
stellar keys generate dev-account --network testnet
stellar keys fund dev-account --network testnet
```

### Check Stellar contract info

```bash
stellar contract info --id <CONTRACT_ID> --network testnet
```

---

## IDE Setup (VS Code)

### Recommended extensions

| Extension | ID | Purpose |
|-----------|-----|---------|
| **rust-analyzer** | `rust-lang.rust-analyzer` | Rust language support |
| **CodeLLDB** | `vadimcn.vscode-lldb` | Native debugger for Rust |
| **Better TOML** | `bungcip.better-toml` | Syntax highlighting for `Cargo.toml` |
| **ESLint** | `dbaeumer.vscode-eslint` | TypeScript/JavaScript linting |

Install all at once:

```bash
code --install-extension rust-lang.rust-analyzer
code --install-extension vadimcn.vscode-lldb
code --install-extension bungcip.better-toml
code --install-extension dbaeumer.vscode-eslint
```

### Recommended `.vscode/settings.json`

```json
{
  "rust-analyzer.cargo.target": "wasm32-unknown-unknown",
  "rust-analyzer.checkOnSave.allTargets": false,
  "editor.formatOnSave": true
}
```

---

## Troubleshooting

### Listener fails to start: `ConfigError`

`STELLAR_RPC_URL` and `CONTRACT_ADDRESSES` are required. The service exits on startup if they are missing from `listener/.env`.

### `DATABASE_PATH` directory does not exist

```bash
mkdir -p listener/data
```

### No events appearing in the dashboard

1. Check the listener is healthy: `curl http://localhost:8787/health`
2. Confirm `VITE_EVENTS_API_URL` in `dashboard/.env` matches the listener port.
3. Confirm `EVENTS_API_CORS_ORIGIN` in `listener/.env` matches the dashboard origin (`http://localhost:5173` by default).
4. Confirm `CONTRACT_ADDRESSES` contains the correct deployed contract ID.

### Dashboard shows CORS error

`EVENTS_API_CORS_ORIGIN` in `listener/.env` must exactly match the origin in the browser address bar (including protocol and port, no trailing slash):

```env
EVENTS_API_CORS_ORIGIN=http://localhost:5173
```

Restart the listener after editing `.env`.

### Port already in use

Change `EVENTS_API_PORT` in `listener/.env` and update `VITE_EVENTS_API_URL` in `dashboard/.env` to match.

### `wasm32-unknown-unknown` target not found

```bash
rustup target add wasm32-unknown-unknown
```

### `cargo install --locked stellar-cli --features opt` fails

Ensure Rust is up-to-date:

```bash
rustup update stable
```

### `npm run dev` fails with ts-node ESM errors

Compile first, then run:

```bash
cd listener
npm run build
npm start
```

### SQLite `database is locked` error

Only one listener process should write to the database at a time:

```bash
# Check for existing processes
lsof listener/data/notifications.db
# Kill stale processes
pkill -f "node.*listener"
```

### Freighter not detecting local testnet

In the Freighter extension: **Settings → Network → Testnet**. `VITE_STELLAR_NETWORK` in `dashboard/.env` must match.

### Stellar RPC timeouts

Switch to a different RPC endpoint from the [Stellar Developer docs](https://developers.stellar.org/docs/tools/developer-tools/rpc-providers) or increase `POLL_INTERVAL_MS` to reduce request frequency.

### Contract invoke returns "simulation failed"

1. Confirm the contract was initialized: re-run `initialize_admin` if needed.
2. Confirm `--network` matches where the contract was deployed.
3. Confirm the contract ID is correct: `stellar contract info --id <CONTRACT_ID> --network testnet`
