# Contributor Environment Setup

Step-by-step instructions to set up NotifyChain on a clean machine. When you
finish the [verification checklist](#verification-checklist), contracts build,
the listener responds on its health endpoint, and component tests run the same
commands as [CI](../.github/workflows/ci.yml).

Related guides (deeper detail, not required for first setup):

- [LOCAL_DEVELOPMENT.md](../LOCAL_DEVELOPMENT.md) — running the full stack day to day
- [CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md](../CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md) — fork, branch, and PR workflow
- [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) — common errors

---

## 1. Required tools

| Tool | Version (CI) | Purpose |
|------|----------------|---------|
| Git | 2.30+ | Clone and contribute |
| Rust | **1.86.0** (`contract/rust-toolchain.toml`) | Soroban contract workspace |
| `wasm32v1-none` | — | Contract WASM target |
| Stellar CLI | latest | Build and deploy contracts |
| Node.js | **22** | Listener and dashboard (see `.github/workflows/ci.yml`) |
| npm | bundled with Node | Install dependencies |

### Install Rust, WASM target, and Stellar CLI

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup toolchain install 1.86.0 --component rustfmt --target wasm32v1-none
cargo install --locked stellar-cli --features opt
```

The contract workspace declares Rust 1.86 and Soroban SDK 23, with the exact
SDK release recorded in `contract/Cargo.lock`. Running Cargo commands from
`contract/` selects the pinned toolchain automatically. CI checks the locked
SDK dependency graph, runs all workspace tests, and builds the Wasm target on
pull requests.

### Install Node.js 22

Use [nodejs.org](https://nodejs.org/) or [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install 22
nvm use 22
```

### Verify installations

```bash
git --version
rustc --version && cargo --version
stellar --version
node --version   # expect v22.x in CI
npm --version
```

All commands above should print a version without errors.

---

## 2. Clone the repository

For contributions, fork [Core-Foundry/Notify-Chain](https://github.com/Core-Foundry/Notify-Chain) on GitHub, then:

```bash
git clone https://github.com/YOUR-USERNAME/Notify-Chain.git
cd Notify-Chain
git remote add upstream https://github.com/Core-Foundry/Notify-Chain.git
git fetch upstream
git checkout main
git merge upstream/main
```

Read-only clone (no fork):

```bash
git clone https://github.com/Core-Foundry/Notify-Chain.git
cd Notify-Chain
```

---

## 3. Listener service

The listener polls Stellar, processes events, and exposes the events HTTP API.

```bash
cd listener
npm ci
cp .env.example .env
```

Edit `listener/.env`. Minimum for local development:

```bash
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
CONTRACT_ADDRESSES=[{"address":"YOUR_CONTRACT_ID","events":["*"]}]
```

Initialize the database and start the service:

```bash
npm run migrate
npm run dev
```

In another terminal, confirm the service is up:

```bash
curl -s http://localhost:8787/health
curl -s http://localhost:8787/api/events
```

---

## 4. Dashboard

```bash
cd dashboard
npm ci
```

Optional: create `dashboard/.env` if the listener is not on the default URL:

```bash
# Example — adjust port if EVENTS_API_PORT differs in listener/.env
VITE_EVENTS_API_URL=http://localhost:8787
```

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The UI should load without CORS errors when the listener is running.

---

## 5. End-to-end environment (Docker)

Docker Compose can start an isolated local scenario with the contract test suite,
the listener and its SQLite database, a local Stellar RPC stub, and the dashboard.
It does not require a root `.env` file, deployed contracts, Stellar credentials,
or production service credentials.

From the repository root, run:

```bash
docker compose -f docker-compose.yml -f docker-compose.e2e.yml up --build -d
```

Compose runs `cargo test --workspace --all-features` in the contract workspace
before starting the listener. The listener stores its database in its own named
volume; the dashboard waits for the listener health check.

| Service | URL / behavior |
|---------|----------------|
| Dashboard | http://localhost:5173 |
| Listener API | http://localhost:8787 |
| Listener health | http://localhost:8787/health |
| Local Stellar RPC stub | Internal to the Compose network; returns an empty event page |

Check the stack and contract test output:

```bash
docker compose -f docker-compose.yml -f docker-compose.e2e.yml ps
docker compose -f docker-compose.yml -f docker-compose.e2e.yml logs contract-tests
```

Stop the scenario and remove its containers, network, and test database/cache
volumes:

```bash
docker compose -f docker-compose.yml -f docker-compose.e2e.yml down --volumes --remove-orphans
```

This stack is intended for local integration and UI development. Soroban
contracts are initialized in-process by their test suite; no contract is
deployed to the stub. The stub returns no chain events, so it verifies service
connectivity and dashboard/API startup rather than live contract event delivery.
For a real testnet integration, follow [Listener service](#3-listener-service)
and configure a deployed test contract separately.

---

## 6. Smart contracts

### AutoShare (`contract/`)

```bash
cd contract
stellar contract build
cd contracts/hello-world
cargo test
```

### TaskBounty (`Documents/Task Bounty/`)

```bash
cd "Documents/Task Bounty"
stellar contract build
cargo test
```

---

## 7. Optional: frontend analytics app

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) when you work on analytics UI.

---

## 8. Environment variables

- Listener: see `listener/.env.example` and [ENVIRONMENT_VARIABLES_AND_SECRETS.md](../ENVIRONMENT_VARIABLES_AND_SECRETS.md)
- Dashboard: `VITE_EVENTS_API_URL` (events API base URL)

---

## Verification checklist

Complete these steps to confirm your environment is ready for development.

### Toolchain

- [ ] `rustc`, `cargo`, `stellar`, `node`, and `npm` versions print successfully
- [ ] `rustup toolchain list` includes Rust 1.86.0 and
      `rustup target list --toolchain 1.86.0 --installed` includes `wasm32v1-none`

### Listener

- [ ] `cd listener && npm ci` completes without errors
- [ ] `npm run migrate` creates `listener/data/notifications.db`
- [ ] `npm run dev` starts without crashing
- [ ] `curl http://localhost:8787/health` returns HTTP 200 with `"status":"ok"`
- [ ] `npm test -- --runInBand src/migrations/migration-upgrade.test.ts src/database/database-transaction.test.ts`
      passes the prior-schema upgrade and rollback checks (fixtures cover
      pre-004 and pre-005 databases)

### Dashboard

- [ ] `cd dashboard && npm ci` completes
- [ ] `npm run dev` serves the app on port 5173
- [ ] Browser loads the dashboard with the listener running

### Contracts

- [ ] `stellar contract build` succeeds under `contract/`
- [ ] `cargo test` passes in `contract/contracts/hello-world` (when the workspace builds)
- [ ] `cargo test` passes under `Documents/Task Bounty/`

### CI parity (run before opening a PR)

```bash
# Listener
cd listener && npm ci && npm run lint && npm run typecheck && npm test --silent

# Dashboard
cd dashboard && npm ci && npm run lint && npm run build && npm test --silent && npm run test:wallet --silent

# Contracts
cd contract && cargo test --workspace --all-features --locked && cargo build --workspace --release --locked --target wasm32v1-none
```

- [ ] All commands above succeed on your machine (or note pre-existing upstream failures in your PR)

---

## 9. VS Code (recommended)

Install [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) and [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint). Configure rust-analyzer to use `wasm32v1-none` when working on Soroban contracts.

---

## 10. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `sqlite3` / `node-gyp` install errors | `npm rebuild sqlite3`; install platform build tools (see [TROUBLESHOOTING.md](../TROUBLESHOOTING.md)) |
| `SQLITE_ERROR: no such table` | `cd listener && npm run migrate` |
| Dashboard cannot reach API | Match `VITE_EVENTS_API_URL` to listener `EVENTS_API_PORT` |
| Port 8787 in use | Change `EVENTS_API_PORT` in `listener/.env` or stop the conflicting process |

For more detail, see [TROUBLESHOOTING.md](../TROUBLESHOOTING.md).
