# Deployment Guide

This guide covers deploying NotifyChain across three environments: **local**, **staging**, and **production**. It is the single reference for getting every component — smart contracts, listener service, and dashboard — running end-to-end.

> **Related documents**
> - Local development workflow → [`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md)
> - Smart contract deploy steps → [`DEPLOYMENT_PLAYBOOK.md`](DEPLOYMENT_PLAYBOOK.md)
> - Contract upgrade procedure → [`CONTRACT_UPGRADE_GUIDE.md`](CONTRACT_UPGRADE_GUIDE.md)
> - Troubleshooting → [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
> - Database backup and restore → [`docs/DATABASE_BACKUP_RESTORE.md`](docs/DATABASE_BACKUP_RESTORE.md)

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Repository Structure](#repository-structure)
3. [Local Deployment](#local-deployment)
4. [Staging Deployment](#staging-deployment)
5. [Production Deployment](#production-deployment)
6. [Environment Variables Reference](#environment-variables-reference)
7. [Health Checks and Verification](#health-checks-and-verification)

---

## Prerequisites

The following tools must be installed before deploying any environment.

### Required for all environments

| Tool | Minimum version | Install |
|---|---|---|
| Node.js | 18 | [nodejs.org](https://nodejs.org) |
| npm | 9 | Bundled with Node.js |
| Git | any | [git-scm.com](https://git-scm.com) |

### Required for smart contract work

| Tool | Minimum version | Install |
|---|---|---|
| Rust (stable) | 1.78 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| WebAssembly target | — | `rustup target add wasm32-unknown-unknown` |
| Stellar CLI | latest | `cargo install --locked stellar-cli --features opt` |

### Verify installations

```bash
node --version      # v18+
npm --version       # 9+
rustc --version     # 1.78+
stellar --version
```

---

## Repository Structure

```
Notify-Chain/
├── contract/          # Soroban smart contracts (Rust)
├── listener/          # Off-chain event listener and API (Node.js / TypeScript)
├── dashboard/         # React + Vite frontend dashboard
├── scripts/           # Utility shell scripts (health-check, fuzz coverage)
└── .github/workflows/ # CI/CD pipelines
```

Each component is deployed independently. The listener depends on a deployed contract address; the dashboard depends on a running listener.

---

## Local Deployment

Local deployment runs all three components on a single machine against the Stellar **testnet**.

### 1. Clone the repository

```bash
git clone https://github.com/Core-Foundry/Notify-Chain.git
cd Notify-Chain
```

### 2. Deploy the smart contracts to testnet

Generate and fund a test identity:

```bash
stellar keys generate dev-account --network testnet
stellar keys fund dev-account --network testnet
```

Build and deploy the AutoShare contract:

```bash
cd contract/contracts/hello-world
stellar contract build
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/hello_world.wasm \
  --source dev-account \
  --network testnet
# Copy the printed CONTRACT_ID
```

Initialize the contract:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source dev-account \
  --network testnet \
  -- initialize_admin \
  --admin <YOUR_PUBLIC_KEY>
```

> For TaskBounty contract steps, see [`DEPLOYMENT_PLAYBOOK.md`](DEPLOYMENT_PLAYBOOK.md).

### 3. Configure the listener

```bash
cd listener
cp .env.example .env
```

Edit `.env` with the contract ID from step 2:

```env
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

CONTRACT_ADDRESSES=[{"address":"<CONTRACT_ID>","events":["*"]}]

EVENTS_API_PORT=8787
EVENTS_API_CORS_ORIGIN=http://localhost:5173

DATABASE_PATH=./data/notifications.db
```

Install dependencies, run migrations, and start:

```bash
npm ci
mkdir -p data
npm run migrate
npm run dev
```

Verify the listener is healthy:

```bash
curl http://localhost:8787/health
# Expected: {"status":"ok",...}
```

### 4. Configure the dashboard

```bash
cd dashboard
cp .env.example .env
```

The default `.env` is ready for local use:

```env
VITE_EVENTS_API_URL=http://localhost:8787/api/events
VITE_STELLAR_NETWORK=TESTNET
```

Install dependencies and start:

```bash
npm ci
npm run dev
# Dashboard available at http://localhost:5173
```

### 5. Verify end-to-end

- Open `http://localhost:5173` in a browser.
- Events from the deployed contract should appear as they are emitted on-chain.
- Check `http://localhost:8787/health` for listener status.
- Check `http://localhost:8787/api/indexing/health` for indexing lag.

---

## Staging Deployment

Staging is triggered automatically by the `staging.yml` CI workflow when commits are pushed to the `staging` branch. It mirrors production configuration but points at testnet.

### Workflow overview

```
push to staging branch
  → check-migrations job: npm run migrate + npm run check-migrations
  → deploy job: build listener + build dashboard + health check
```

See [`.github/workflows/staging.yml`](.github/workflows/staging.yml) for the full pipeline.

### Manual staging deployment

If you need to deploy staging manually on a server:

#### 1. Set environment variables

Create `listener/.env` from the staging template:

```env
NODE_ENV=production
LOG_LEVEL=info

STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

CONTRACT_ADDRESSES=[{"address":"<STAGING_CONTRACT_ID>","events":["*"]}]

EVENTS_API_PORT=8787
EVENTS_API_CORS_ORIGIN=https://staging.your-domain.com

DATABASE_PATH=/var/data/notify-chain/notifications.db

DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/STAGING_ID/STAGING_TOKEN

RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=60
```

Create `dashboard/.env`:

```env
VITE_EVENTS_API_URL=https://staging-api.your-domain.com/api/events
VITE_STELLAR_NETWORK=TESTNET
```

#### 2. Build and start the listener

```bash
cd listener
npm ci
mkdir -p /var/data/notify-chain
npm run migrate
npm run build
node dist/index.js
```

#### 3. Build and serve the dashboard

```bash
cd dashboard
npm ci
npm run build
# Serve the dist/ folder with nginx, Caddy, or Cloudflare Pages
```

#### 4. Run the health check

```bash
curl https://staging-api.your-domain.com/health
```

---

## Production Deployment

Production deploys the listener against **Stellar mainnet** and serves the dashboard at your public domain.

### Prerequisites specific to production

- A Stellar mainnet account with sufficient XLM for contract deployment and ongoing fees.
- A server or container runtime (Linux recommended) for the listener.
- A static hosting service (Cloudflare Pages, Vercel, S3+CDN, nginx) for the dashboard.
- A SQLite-compatible persistent volume or managed database path for the listener.
- Secrets management: do **not** store private keys or webhook tokens in plain-text `.env` files. Use your platform's secrets store (GitHub Actions secrets, AWS Secrets Manager, Vault, etc.).

### 1. Deploy smart contracts to mainnet

Configure the Stellar CLI for mainnet:

```bash
stellar network add \
  --rpc-url "https://soroban-rpc.stellar.org" \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  mainnet
```

Build and optimize the contract:

```bash
cd contract/contracts/hello-world
stellar contract build
stellar contract optimize \
  --wasm target/wasm32-unknown-unknown/release/hello_world.wasm
```

Deploy:

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/hello_world.optimized.wasm \
  --source mainnet-deployer \
  --network mainnet
# Save the CONTRACT_ID
```

Initialize:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source mainnet-deployer \
  --network mainnet \
  -- initialize_admin \
  --admin <ADMIN_ADDRESS>
```

Verify deployment:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source mainnet-deployer \
  --network mainnet \
  -- version
# Expected: 1
```

### 2. Configure the listener for production

Set the following environment variables through your secrets manager or platform:

```env
NODE_ENV=production
LOG_LEVEL=info

STELLAR_NETWORK=public
STELLAR_RPC_URL=https://soroban-rpc.stellar.org
STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015

CONTRACT_ADDRESSES=[{"address":"<MAINNET_CONTRACT_ID>","events":["*"]}]

EVENTS_API_PORT=8787
EVENTS_API_CORS_ORIGIN=https://your-production-domain.com

DATABASE_PATH=/var/data/notify-chain/notifications.db

DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/PROD_ID/PROD_TOKEN

WEBHOOK_SECRETS=[{"id":"prod","secret":"<strong-random-secret>"}]

RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=60

SCHEDULER_ENABLED=true
RETRY_SCHEDULER_ENABLED=true
```

### Production HTTP response headers

With `NODE_ENV=production`, the listener includes `Strict-Transport-Security: max-age=31536000` along with its baseline security headers. Serve the API through HTTPS and configure the TLS-terminating proxy or platform to redirect HTTP to HTTPS; browsers ignore HSTS received over plain HTTP. HSTS is not enabled in local development, and the listener does not add `includeSubDomains` or `preload` because those settings require a separate domain-wide commitment.

The dashboard's Vite development and preview servers set baseline headers, but those settings do not carry over to static production hosting. Configure `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, and HSTS at the production CDN or web server. Set the dashboard's `VITE_EVENTS_API_URL` to the HTTPS API endpoint; `EVENTS_API_CORS_ORIGIN` controls CORS and is not used to determine HSTS.

### 3. Run database migrations

Migrations must be applied before starting the listener. Run this once before each deployment:

```bash
cd listener
npm run migrate
npm run check-migrations
# Should report: No pending migrations
```

### 4. Start the listener

```bash
cd listener
npm ci --omit=dev
npm run build
node dist/index.js
```

Use a process manager (systemd, PM2, Docker) to keep the process running and restart on failure.

**Example PM2 setup:**

```bash
npm install -g pm2
pm2 start dist/index.js --name notify-chain-listener
pm2 save
pm2 startup
```

**Example systemd unit** (`/etc/systemd/system/notify-chain.service`):

```ini
[Unit]
Description=NotifyChain Listener
After=network.target

[Service]
Type=simple
User=notify
WorkingDirectory=/opt/notify-chain/listener
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/notify-chain/listener/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable notify-chain
systemctl start notify-chain
```

### 5. Build and deploy the dashboard

Set `dashboard/.env` (or pass as build-time variables):

```env
VITE_EVENTS_API_URL=https://api.your-production-domain.com/api/events
VITE_STELLAR_NETWORK=PUBLIC
```

Build:

```bash
cd dashboard
npm ci --omit=dev
npm run build
# Outputs static files to dashboard/dist/
```

Deploy `dashboard/dist/` to your static hosting provider. For Cloudflare Pages, the preview workflow is already configured in [`.github/workflows/preview.yml`](.github/workflows/preview.yml).

### 6. Verify production deployment

```bash
# Listener health
curl https://api.your-production-domain.com/health

# Indexing health
curl https://api.your-production-domain.com/api/indexing/health

# Events API
curl https://api.your-production-domain.com/api/events
```

All three should return HTTP 200 with JSON bodies.

---

## Environment Variables Reference

### Listener (`listener/.env`)

#### Network

| Variable | Default | Description |
|---|---|---|
| `STELLAR_NETWORK` | `testnet` | `testnet` or `public` |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org:443` | Stellar Soroban RPC endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Network passphrase |
| `CONTRACT_ADDRESSES` | — | JSON array of `{ address, events }` objects |

#### API server

| Variable | Default | Description |
|---|---|---|
| `EVENTS_API_PORT` | `8787` | HTTP port for the events API |
| `EVENTS_API_CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin (must match dashboard URL exactly) |
| `WEBHOOK_SECRETS` | `[]` | JSON array of `{ id, secret }` pairs for webhook signature verification |

#### Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_PATH` | `./data/notifications.db` | Path to the SQLite database file |

#### Polling

| Variable | Default | Description |
|---|---|---|
| `POLL_INTERVAL_MS` | `30000` | How often to poll Stellar for new events (ms) |
| `MAX_RECONNECT_ATTEMPTS` | `5` | Max reconnect attempts before giving up |
| `RECONNECT_DELAY_MS` | `5000` | Delay between reconnect attempts (ms) |

#### Scheduler

| Variable | Default | Description |
|---|---|---|
| `SCHEDULER_ENABLED` | `true` | Enable the scheduled notification dispatcher |
| `SCHEDULER_POLL_INTERVAL_MS` | `10000` | How often the scheduler checks for due notifications (ms) |
| `SCHEDULER_BATCH_SIZE` | `10` | Max notifications dispatched per poll cycle |
| `RETRY_SCHEDULER_ENABLED` | `true` | Enable the DB-backed retry scheduler |

#### Rate limiting

| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_ENABLED` | `true` | Enable API rate limiting |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window duration (ms) |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | Max requests per window per client |

#### Discord (optional)

| Variable | Default | Description |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | — | Discord webhook URL for event notifications |

#### Logging

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | — | Set to `production` for JSON log output |

### Dashboard (`dashboard/.env`)

| Variable | Default | Description |
|---|---|---|
| `VITE_EVENTS_API_URL` | `http://localhost:8787/api/events` | Full URL to the listener's events endpoint |
| `VITE_STELLAR_NETWORK` | `TESTNET` | `TESTNET` or `PUBLIC` |

---

## Health Checks and Verification

### Listener endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Overall service health (Stellar RPC, Discord, database, event registry) |
| `GET /api/indexing/health` | Ledger sync status and indexing lag |
| `GET /api/notifications/health` | Notification pipeline health report |
| `GET /api/status` | Per-contract pause status |

A healthy deployment returns HTTP 200 from `/health` with `"status": "ok"`.

A degraded deployment returns HTTP 200 with `"status": "degraded"` — the service is running but a non-critical dependency (e.g. Discord webhook) is unreachable.

An unhealthy deployment returns HTTP 503 with `"status": "error"` — a critical dependency (Stellar RPC or database) is down.

### Manual smoke test

Run this sequence after any deployment to confirm all layers are working:

```bash
# 1. Listener health
curl -sf https://<your-api-host>/health | jq .status

# 2. Indexing lag (ledgerLag should be small, e.g. < 10)
curl -sf https://<your-api-host>/api/indexing/health | jq '{status, ledgerLag}'

# 3. Events API (returns recent on-chain events)
curl -sf https://<your-api-host>/api/events | jq '.count'

# 4. Dashboard loads (HTTP 200)
curl -sf -o /dev/null -w "%{http_code}" https://<your-dashboard-host>/
```

All four commands should complete without error.
