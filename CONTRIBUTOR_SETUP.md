# Contributor Environment Setup Guide

> **Canonical setup guide:** [`docs/ENVIRONMENT_SETUP.md`](docs/ENVIRONMENT_SETUP.md)

This guide walks you through setting up a local development environment for
NotifyChain. By the end, you will have the listener service, the dashboard,
the frontend analytics app, and the smart contracts building and running on
your machine.

For the canonical contribution workflow, start with
[`CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md`](CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md).
For a shorter setup path, see [`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md).
That document contains step-by-step instructions to install required tools,
clone the repository, configure the listener and dashboard, build contracts, and
verify your installation (including CI-parity checks).

For day-to-day development after setup, see [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md).
For Git workflow (fork, branch, PR), see
[CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md](CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md).
> Goal: a new contributor should be able to set up NotifyChain from scratch on a clean machine without asking maintainers for help.

---

## Table of Contents

1. [Required Dependencies](#1-required-dependencies)
2. [Clone the Repository](#2-clone-the-repository)
3. [Listener Service Setup](#3-listener-service-setup)
4. [Dashboard Setup](#4-dashboard-setup)
5. [Frontend (Next.js Analytics) Setup](#5-frontend-nextjs-analytics-setup)
6. [Smart Contracts Setup](#6-smart-contracts-setup)
7. [Environment Variables Reference](#7-environment-variables-reference)
8. [Full-Stack Verification Checklist](#8-full-stack-verification-checklist)
9. [Running Tests](#9-running-tests)
10. [VS Code Setup (Recommended)](#10-vs-code-setup-recommended)
11. [Troubleshooting & FAQ](#11-troubleshooting--faq)
5. [Smart Contracts Setup](#5-smart-contracts-setup)
6. [Environment Variables Reference](#6-environment-variables-reference)
7. [Running Tests](#7-running-tests)
8. [VS Code Setup](#8-vs-code-setup)
9. [Troubleshooting & FAQ](#9-troubleshooting--faq)

---

## 1. Required Dependencies

| Dependency | Minimum Version | Install | Used By |
|---|---|---|---|
| Rust | **1.86.0** (`contract/rust-toolchain.toml`) | [rustup.rs](https://rustup.rs) | Smart contracts |
| `wasm32v1-none` | — | Installed by the contract toolchain configuration | Soroban contract build |
| Stellar CLI | latest | `cargo install --locked stellar-cli --features opt` | Contract build/deploy |
| Node.js | **22** | [nodejs.org](https://nodejs.org) or `nvm` | Listener, Dashboard |
| Git | — | your package manager | Version control |

| Dependency     | Minimum Version | Install Method                          | Used By            |
|----------------|-----------------|-----------------------------------------|--------------------|
| Rust           | **1.86.0** (`contract/rust-toolchain.toml`) | [rustup.rs](https://rustup.rs) | Smart contracts    |
| `wasm32v1-none` | —       | Installed by the contract toolchain configuration | Soroban contract build |
| Stellar CLI    | latest          | `cargo install --locked stellar-cli --features opt`             | Contract build/deploy |
| Node.js        | **18** (dashboard), **20** (listener) | [nodejs.org](https://nodejs.org) or `nvm` | Listener, Dashboard |
| npm            | comes with Node  | —                                       | Package management |
| Git            | —               | Your package manager or [git-scm.com](https://git-scm.com) | Version control |
### Platform notes

- **macOS**: Install Xcode Command Line Tools first: `xcode-select --install`
- **Linux**: Install build tools first: `sudo apt install build-essential`
- **Windows**: Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) with the "C++ build tools" workload (needed for native `sqlite3` bindings)

### Quick install (Rust + Stellar CLI)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup toolchain install 1.86.0 --component rustfmt --target wasm32v1-none
cargo install --locked stellar-cli --features opt

# Verify
rustc --version && cargo --version && stellar --version
```

The `contract/` workspace pins Rust 1.86.0 and declares Soroban SDK 23, with
the exact SDK release recorded in `contract/Cargo.lock`. Run Cargo commands
from `contract/` to select the pinned toolchain automatically. CI runs the
contract tests and Wasm build before changes merge.

---

## Docker Setup (Recommended)

Docker removes the need to install Node.js or manage per-service env files. All you need is [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose on Linux).

### Start everything

```bash
# 1. Copy the root env file (only needed once)
cp .env.example .env

# 2. Edit .env — at minimum set CONTRACT_ADDRESSES to your deployed contract ID

# 3. Build images and start listener + dashboard
docker compose up --build
```

| Service | URL |
|---|---|
| Dashboard (Vite HMR) | http://localhost:5173 |
| Listener API | http://localhost:8787 |
| Listener health check | http://localhost:8787/health |

The SQLite database is stored in a named Docker volume (`listener_data`) and persists across container restarts.

### Common commands

```bash
docker compose up --build        # rebuild images and start (needed after code changes)
docker compose up                # start with existing images
docker compose down              # stop and remove containers
docker compose down -v           # stop and delete the database volume (full reset)
docker compose logs -f listener  # tail listener logs
docker compose logs -f dashboard # tail dashboard logs
docker compose restart listener  # restart one service after env change
```

### Change configuration

Edit `.env` at the repo root, then:

```bash
git clone https://github.com/Core-Foundry/Notify-Chain.git
cd Notify-Chain
docker compose restart listener        # for most listener settings
docker compose up --build dashboard    # required if VITE_* vars changed (baked in at build time)
```

### Reset the database

```bash
docker compose down -v   # removes listener_data volume
docker compose up        # fresh start — migrations run automatically on boot
```

### What doesn't run in Docker

The **Rust/Soroban contract** is a build-only component — no runtime container exists for it. Build and test it locally following [Smart Contracts Setup](#5-smart-contracts-setup).

---

## Manual Setup (Without Docker)

Follow sections 2–9 below to set up each component directly on your machine.

---

## 2. Clone the Repository

Fork the repo on GitHub first, then:

```bash
git clone https://github.com/YOUR-USERNAME/Notify-Chain.git
cd Notify-Chain
git remote add upstream https://github.com/Core-Foundry/Notify-Chain.git
```

Verify remotes:
```bash
git remote -v
# origin    https://github.com/YOUR-USERNAME/Notify-Chain.git (fetch)
# upstream  https://github.com/Core-Foundry/Notify-Chain.git (fetch)
```

---

## 3. Listener Service Setup

The listener is the core off-chain service that polls the Stellar network, processes contract events, and delivers notifications.

### 3.1 Install dependencies

```bash
cd listener
npm install
```

> If `npm install` fails with `node-gyp` or `sqlite3` errors, see [Troubleshooting](#9-troubleshooting--faq).

### 3.2 Configure environment

```bash
cp .env.example .env
```

Minimum required values in `listener/.env`:

```bash
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
CONTRACT_ADDRESSES=[{"address":"YOUR_CONTRACT_ID","events":["*"]}]
```

For Discord notifications, also add:

```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_TOKEN
DISCORD_WEBHOOK_ID=YOUR_WEBHOOK_ID
```

Full variable reference: [Environment Variables Reference](#6-environment-variables-reference).

### 3.3 Initialize the database

```bash
npm run migrate
```

This creates `listener/data/notifications.db` and runs all schema migrations.

### 3.4 Run the listener

```bash
npm run dev
```

Verify it's working:

```bash
curl http://localhost:8787/health
curl http://localhost:8787/api/events
```

### 3.5 Listener commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start in dev mode (ts-node, hot reload) |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled production build |
| `npm test` | Run all tests |
| `npm run typecheck` | TypeScript type check (no emit) |
| `npm run lint` | ESLint |
| `npm run migrate` | Initialize or update SQLite schema |

---

## 4. Dashboard Setup

The dashboard is a React + Vite app that visualizes events from the listener's API.

### 4.1 Install dependencies

```bash
cd dashboard
npm install
```

### 4.2 Configure environment

```bash
cp .env.example .env
```

Default `.env.example` works for local development:

```bash
VITE_EVENTS_API_URL=http://localhost:8787/api/events
VITE_STELLAR_NETWORK=TESTNET
```

### 4.3 Run the dashboard

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The dashboard fetches from the listener API.

### 4.4 Dashboard commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start Vite dev server |
| `npm run build` | TypeScript check + Vite production build |
| `npm test` | Run all tests |
| `npm run lint` | ESLint (zero warnings) |
| `npm run preview` | Preview production build locally |
| `npm run benchmark` | Run rendering performance benchmarks |

---

## 5. Smart Contracts Setup

Only needed if you're modifying or deploying contracts.

### 5.1 Build

```bash
cd contract
stellar contract build
```

Output goes to `contract/target/wasm32v1-none/release/`.

### 5.2 Run tests

```bash
cd contract/contracts/hello-world
cargo test
```

### 5.3 Deploy to testnet (optional)

```bash
# Generate and fund a testnet identity
stellar keys generate my-identity --network testnet
stellar keys fund my-identity --network testnet

# Deploy
cd contract
stellar contract deploy \
  --wasm target/wasm32v1-none/release/hello_world.wasm \
  --source my-identity \
  --network testnet
# Contract ID is printed on success
```

### 5.4 Contract commands

| Command | Purpose |
|---|---|
| `stellar contract build` | Build all contracts |
| `cargo test` | Run contract unit tests |
| `cargo fmt --all` | Format Rust code |
| `cargo fmt --all -- --check` | Verify formatting (used in CI) |
| `stellar contract deploy ...` | Deploy to testnet |
| `stellar contract invoke ...` | Call a contract function |

---

## 6. Environment Variables Reference

### Listener (`listener/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `STELLAR_RPC_URL` | Yes | `https://soroban-testnet.stellar.org:443` | Soroban RPC endpoint |
| `CONTRACT_ADDRESSES` | Yes | `[]` | JSON array: `[{"address":"C...","events":["*"]}]` |
| `STELLAR_NETWORK` | No | `testnet` | Network passphrase |
| `POLL_INTERVAL_MS` | No | `30000` | Time between RPC polls (ms) |
| `MAX_RECONNECT_ATTEMPTS` | No | `5` | Max RPC failures before stopping |
| `RECONNECT_DELAY_MS` | No | `5000` | Base delay between reconnect attempts |
| `EVENTS_API_PORT` | No | `8787` | HTTP server port |
| `EVENTS_API_CORS_ORIGIN` | No | `http://localhost:5173` | Allowed CORS origin |
| `DATABASE_PATH` | No | `./data/notifications.db` | SQLite file path |
| `DISCORD_WEBHOOK_URL` | No | — | Discord webhook URL |
| `DISCORD_WEBHOOK_ID` | No | — | Discord webhook ID (required with URL) |
| `RETRY_BASE_DELAY_MS` | No | `5000` | Base delay for notification retry backoff |
| `RETRY_MAX_RETRIES` | No | `5` | Max retry attempts for failed notifications |
| `SCHEDULER_ENABLED` | No | `true` | Enable notification scheduler |
| `SCHEDULER_POLL_INTERVAL_MS` | No | `10000` | Scheduler poll frequency (ms) |
| `SCHEDULER_BATCH_SIZE` | No | `10` | Max notifications per scheduler cycle |
| `RATE_LIMIT_ENABLED` | No | `true` | Enable HTTP API rate limiting |
| `RATE_LIMIT_MAX_REQUESTS` | No | `60` | Max requests per window per client |
| `LOG_LEVEL` | No | `info` | Winston log level (`error`,`warn`,`info`,`debug`) |
| `NODE_ENV` | No | — | Set to `production` for JSON log output |

### Dashboard (`dashboard/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_EVENTS_API_URL` | No | `http://localhost:8787/api/events` | Listener API endpoint |
| `VITE_STELLAR_NETWORK` | No | `TESTNET` | Stellar network (`TESTNET` or `MAINNET`) |

### Minimum viable listener config

```bash
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
CONTRACT_ADDRESSES=[{"address":"C...","events":["*"]}]
EVENTS_API_PORT=8787
EVENTS_API_CORS_ORIGIN=http://localhost:5173
DATABASE_PATH=./data/notifications.db
```

---

## 7. Running Tests

Run these before opening any PR.

### Contracts

```bash
cd contract/contracts/hello-world
cargo fmt --all -- --check   # must be clean
cargo test
```

### Listener

```bash
cd listener
npm run typecheck
npm run lint
npm test
```

### Dashboard

```bash
cd dashboard
npm run lint
npm run build
npm test
```

### What CI runs on every PR

```bash
# Dashboard
npm run lint && npm run build && npm test

# Listener
npm run lint && npm run typecheck && npm test

# Contracts
cargo fmt --all -- --check
cargo test --workspace --all-features --verbose
cargo test fuzz_ --verbose -- --nocapture
```

---

## 8. VS Code Setup

### Recommended extensions

1. [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
2. [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) — Rust debugger
3. [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)
4. [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
5. [Better TOML](https://marketplace.visualstudio.com/items?itemName=bungcip.better-toml)

### `.vscode/settings.json`

The repo includes this already:

```json
{
  "rust-analyzer.cargo.target": "wasm32v1-none",
  "rust-analyzer.checkOnSave.allTargets": false
}
```

This prevents false-positive errors from non-Wasm platform checks.

---

## 9. Troubleshooting & FAQ

### `npm install` fails with `node-gyp` / `sqlite3` errors

Native `sqlite3` bindings must be compiled for your platform:

```bash
npm rebuild sqlite3
# If that fails:
npm uninstall sqlite3 && npm install
```

On Windows, ensure Visual Studio Build Tools are installed with the "C++ build tools" workload.

---

### No events appear in the listener

1. Confirm the contract ID in `CONTRACT_ADDRESSES` is deployed on the same network as `STELLAR_RPC_URL`.
2. Check the RPC is reachable:
   ```bash
   curl -X POST https://soroban-testnet.stellar.org:443 \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```
3. Check listener logs for poll output — look for `"Received events"`.

---

### `stellar: command not found`

```bash
source "$HOME/.cargo/env"
# Or reinstall:
cargo install --locked stellar-cli --features opt
```

---

### `SQLITE_ERROR: no such table` or `Database not initialized`

```bash
cd listener
mkdir -p data
npm run migrate
```

---

### Port conflict: `EADDRINUSE :::8787`

```bash
# macOS/Linux — find and kill the process
lsof -i :8787
kill -9 <PID>

# Or change the port in listener/.env
EVENTS_API_PORT=8788
```

---

### Dashboard shows blank page or "Failed to fetch"

1. Is the listener running? (`npm run dev` in `listener/`)
2. Does `VITE_EVENTS_API_URL` in `dashboard/.env` match the listener port?
3. Restart the Vite dev server after editing `.env`.

---

### Rust reports that the contract target is not installed

```bash
rustup toolchain install 1.86.0 --target wasm32v1-none
```

---

### After `git pull` things stop working

```bash
cd listener  && npm install && npm run migrate
cd dashboard && npm install
cd contract  && stellar contract build
```

With Docker, rebuild after pulling:

```bash
docker compose up --build
```

---

### Docker: dashboard shows "Failed to fetch" or blank page

`VITE_EVENTS_API_URL` is baked in at image build time. If you changed it in `.env`, you need to rebuild:

```bash
docker compose up --build dashboard
```

Also confirm the listener is healthy before the dashboard starts:

```bash
docker compose ps          # check listener status shows "healthy"
docker compose logs listener
```

---

### Docker: `listener_data` volume has stale schema

```bash
docker compose down -v     # removes the volume
docker compose up --build  # fresh start, migrations run automatically
```

---

### Still stuck?

1. Search [open issues](https://github.com/Core-Foundry/Notify-Chain/issues) — your problem may already be reported.
1. Search [open issues](https://github.com/Core-Foundry/Notify-Chain/issues) — your problem may already be reported.
2. Read the detailed [Troubleshooting Guide](TROUBLESHOOTING.md).
3. Open a new issue with:
   - Your OS and version
   - Output of `rustc --version`, `node --version`, `stellar --version`
   - The full error message and stack trace
   - Steps you have already tried
1. Search [open issues](https://github.com/Core-Foundry/Notify-Chain/issues).
2. Open a new issue with: your OS, output of `rustc --version && node --version && stellar --version`, the full error and stack trace, and steps already tried.

---

## Project Map

```
Notify-Chain/
├── contract/                        # Soroban smart contract workspace
│   ├── contracts/hello-world/       # AutoShare notification contract
│   │   └── src/                     # Rust source + tests
│   └── Cargo.toml                   # Workspace config
│
├── listener/                        # Off-chain listener service (Node.js/TypeScript)
│   ├── Dockerfile                   # Multi-stage Docker image
│   ├── .dockerignore
│   ├── src/
│   │   ├── api/                     # HTTP API (events, health, schedule)
│   │   ├── services/                # Core: subscriber, dedup, notifier, scheduler
│   │   ├── store/                   # SQLite repositories + in-memory registry
│   │   ├── database/                # Schema and client
│   │   ├── types/                   # TypeScript type definitions
│   │   └── index.ts                 # Entry point
│   └── src/__tests__/               # Integration tests
│
├── dashboard/                       # React + Vite event dashboard
│   ├── Dockerfile                   # Multi-stage Docker image (dev + production)
│   ├── .dockerignore
│   └── src/
│       ├── components/              # UI components
│       ├── services/                # API client
│       ├── store/                   # Zustand state
│       └── pages/                   # Page components
│
├── docker-compose.yml               # Orchestrates listener + dashboard
├── .env.example                     # Root env template for Docker Compose
├── .dockerignore                    # Root-level build context exclusions
│
├── .github/
│   ├── workflows/ci.yml             # CI pipeline
│   ├── dependabot.yml               # Automated dependency updates
│   └── pull_request_template.md     # PR description template
│
├── CONTRIBUTING.md                  # Workflow, standards, PR guidelines ← start here
├── CONTRIBUTOR_SETUP.md             # This file — local environment setup
├── CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md
├── CONTRIBUTOR_ARCHITECTURE_DEEP_DIVE.md
└── ARCHITECTURE_OVERVIEW.md
```
