# NotifyChain - Local Development Guide

> **Complete setup guide for contributors** - Get NotifyChain running locally from scratch

## Table of Contents

1. [Prerequisites & Dependencies](#prerequisites--dependencies)
2. [Project Structure Overview](#project-structure-overview)
3. [Quick Start](#quick-start)
4. [Component-Specific Setup](#component-specific-setup)
   - [Smart Contracts (Rust/Soroban)](#smart-contracts-rustsoroban)
   - [Listener Service (Node.js/TypeScript)](#listener-service-nodejstypescript)
   - [Dashboard (React/TypeScript)](#dashboard-reacttypescript)
5. [Testing & Quality Assurance](#testing--quality-assurance)
6. [Environment Variables](#environment-variables)
7. [Troubleshooting](#troubleshooting)
8. [Development Workflows](#development-workflows)
9. [Contributing Guidelines](#contributing-guidelines)

---

## Prerequisites & Dependencies

Before starting, ensure you have the following software installed on your machine:

### Required Software

| Tool | Minimum Version | Purpose | Installation Link |
|------|----------------|---------|-------------------|
| **Node.js** | v18+ (v20 recommended for Listener) | JavaScript runtime for listener & dashboard | [nodejs.org](https://nodejs.org/) |
| **npm** | v9.0.0+ | Package manager (bundled with Node.js) | Comes with Node.js |
| **Rust** | Latest stable | Smart contract development | [rustup.rs](https://rustup.rs/) |
| **Stellar CLI** | Latest | Deploy & interact with contracts | See [installation](#installing-stellar-cli) |
| **Git** | v2.30.0+ | Version control | [git-scm.com](https://git-scm.com/) |
| **SQLite** | v3.35.0+ | Database for scheduled notifications | Usually pre-installed |

### Optional Tools

| Tool | Purpose | Installation Link |
|------|---------|-------------------|
| **Docker Desktop** | Containerized development (future) | [docker.com](https://www.docker.com/) |
| **VS Code** | Recommended IDE | [code.visualstudio.com](https://code.visualstudio.com/) |
| **Postman** | API testing | [postman.com](https://www.postman.com/) |

---

## Project Structure Overview

```
NotifyChain/
├── contract/                    # Soroban smart contracts (Rust)
│   ├── contracts/
│   │   └── hello-world/           # AutoShare contract
│   │       ├── src/
│   │       │   ├── base/          # Core types, errors, events
│   │       │   ├── interfaces/    # Contract interfaces
│   │       │   ├── tests/         # Contract unit tests
│   │       │   ├── lib.rs        # Contract entry point
│   │       │   └── autoshare_logic.rs  # Business logic
│   │       ├── Cargo.toml
│   │       └── Makefile
│   └── Cargo.toml                # Workspace configuration
│
├── listener/                    # Off-chain event listener (Node.js/TypeScript)
│   ├── src/
│   │   ├── api/                   # REST API endpoints
│   │   ├── database/              # SQLite database layer
│   │   ├── services/              # Business logic services
│   │   │   ├── discord-notification.ts
│   │   │   ├── event-subscriber.ts
│   │   │   ├── notification-scheduler.ts
│   │   │   └── scheduled-notification-repository.ts
│   │   ├── store/                 # In-memory event registry
│   │   ├── types/                 # TypeScript type definitions
│   │   ├── utils/                 # Helper utilities
│   │   ├── config.ts             # Configuration loader
│   │   └── index.ts              # Application entry point
│   ├── data/                      # SQLite database files (created on first run)
│   ├── .env.example               # Environment variable template
│   ├── package.json
│   ├── tsconfig.json
│   └── jest.config.js
│
├── dashboard/                   # React frontend dashboard
│   ├── src/
│   │   ├── components/            # React components
│   │   ├── hooks/                 # Custom React hooks
│   │   ├── pages/                 # Page components
│   │   ├── services/              # API clients
│   │   ├── store/                 # Zustand state management
│   │   ├── App.tsx               # Root component
│   │   └── main.tsx              # Application entry point
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
│
├── Documents/
│   └── Task Bounty/               # TaskBounty contract (alternative example)
│
├── .github/
│   └── workflows/                 # CI/CD pipelines
│
├── README.md                      # Project overview
├── CONTRIBUTING.md                # Contribution guidelines
└── DEVELOPMENT.md                 # This file
```

### Key Directories Explained

| Directory | Purpose |
|-----------|---------|
| `contract/` | Rust-based Soroban smart contracts for blockchain deployment |
| `listener/` | Node.js service that monitors blockchain events and sends notifications |
| `dashboard/` | React web application for viewing events and managing subscriptions |
| `Documents/Task Bounty/` | Alternative example contract demonstrating task/bounty management |

---

## Quick Start

> ⚡ **Get up and running in 5 minutes**

### 1. Clone the Repository

```bash
git clone https://github.com/Core-Foundry/Notify-Chain.git
cd Notify-Chain
```

### 2. Install Node.js Dependencies

```bash
# Install listener dependencies
cd listener
npm install

# Install dashboard dependencies
cd ../dashboard
npm install

# Return to root
cd ..
```

### 3. Set Up Listener Environment

```bash
cd listener
cp .env.example .env
# Edit .env with your configuration (see Environment Variables section)
```

### 4. Initialize Database

```bash
# From listener directory
npm run migrate
```

### 5. Start Development Servers

```bash
# Terminal 1: Start listener service
cd listener
npm run dev

# Terminal 2: Start dashboard
cd dashboard
npm run dev
```

**Access Points:**
- Listener API: http://localhost:8787
- Dashboard: http://localhost:5173

---

## Component-Specific Setup

### Smart Contracts (Rust/Soroban)

#### Installing Rust

```bash
# Install Rust using rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Load Rust environment
source $HOME/.cargo/env

# Verify installation
rustc --version
cargo --version
```

#### Installing WebAssembly Target

```bash
rustup target add wasm32-unknown-unknown
```

#### Installing Stellar CLI

```bash
# Install via cargo
cargo install --locked stellar-cli --features opt

# Verify installation
stellar --version
```

> **Note**: Stellar CLI installation may take 5-10 minutes.

#### Building the AutoShare Contract

```bash
cd contract
stellar contract build
```

**Output**: Compiled WASM file at `target/wasm32-unknown-unknown/release/hello_world.wasm`

#### Building the TaskBounty Contract

```bash
cd Documents/Task\ Bounty
stellar contract build
```

#### Running Contract Tests

```bash
# AutoShare contract tests
cd contract/contracts/hello-world
cargo test

# TaskBounty contract tests
cd ../../../Documents/Task\ Bounty
cargo test
```

#### Deploying to Stellar Testnet

1. **Generate a test identity**:
```bash
stellar keys generate test-user --network testnet
```

2. **Fund your identity** (get test XLM):
```bash
stellar keys fund test-user --network testnet
```

3. **Deploy the contract**:
```bash
cd contract/contracts/hello-world
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/hello_world.wasm \
  --source test-user \
  --network testnet
```

4. **Save the contract ID** (output from deploy command)

5. **Initialize the contract**:
```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source test-user \
  --network testnet \
  -- \
  initialize_admin \
  --admin <YOUR_ADDRESS>
```

---

### Listener Service (Node.js/TypeScript)

#### Prerequisites Check

```bash
# Verify Node.js version (must be 18+)
node --version

# Verify npm version
npm --version
```

#### Installation

```bash
cd listener
npm install
```

#### Environment Configuration

```bash
# Copy example environment file
cp .env.example .env
```

Edit `.env` with your configuration:

```bash
# Stellar Network Configuration
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443

# Contract Addresses (JSON array)
CONTRACT_ADDRESSES=[{"address":"YOUR_CONTRACT_ID","events":["*"]}]

# Polling Configuration
POLL_INTERVAL_MS=30000
MAX_RECONNECT_ATTEMPTS=5

# API Configuration
EVENTS_API_PORT=8787
EVENTS_API_CORS_ORIGIN=http://localhost:5173

# Discord Webhook (optional)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK

# Database Configuration
DATABASE_PATH=./data/notifications.db

# Scheduler Configuration
SCHEDULER_ENABLED=true
SCHEDULER_POLL_INTERVAL_MS=10000
```

#### Database Setup

```bash
# Initialize SQLite database
npm run migrate
```

**What this does:**
- Creates `./data/` directory
- Creates `notifications.db` SQLite database
- Runs schema migrations
- Creates `scheduled_notifications` and `notification_execution_log` tables

#### Running the Listener

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm run build
npm start
```

**Expected Output:**
```
info: Connected to SQLite database {"path":"./data/notifications.db"}
info: Database migration completed successfully
info: Notification scheduler started successfully
info: Events API server listening {"port":8787}
info: Starting event subscriber service
```

#### Verify Installation

```bash
# Test health endpoint
curl http://localhost:8787/health

# Test events endpoint
curl http://localhost:8787/api/events

# Test scheduler stats
curl http://localhost:8787/api/schedule/stats
```

#### HTTP Response Security Headers

The listener API and dashboard's Vite development and preview servers set `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and `Referrer-Policy: strict-origin-when-cross-origin`. The listener sends `Strict-Transport-Security` only when `NODE_ENV=production`; it is omitted during local HTTP development. The listener does not set a Content Security Policy because its policy must account for the dashboard's API and SSE deployment origins.

Check local responses with:

```bash
curl -sSI http://localhost:8787/health
curl -sSI http://localhost:5173/
```

Both should include the three baseline headers above and omit `Strict-Transport-Security`.

---

### Dashboard (React/TypeScript)

#### Prerequisites Check

```bash
# Verify Node.js version (must be 18+)
node --version
```

#### Installation

```bash
cd dashboard
npm install
```

#### Running the Dashboard

```bash
# Development mode (with hot reload)
npm run dev
```

**Access**: http://localhost:5173

**Expected Output:**
```
VITE v6.3.5  ready in 450 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
  ➜  press h + enter to show help
```

#### Building for Production

```bash
npm run build
```

**Output**: `dist/` directory with optimized static files

#### Preview Production Build

```bash
npm run preview
```

Vite preview applies the same baseline response headers as the development server. These settings do not configure a production static host; configure the equivalent headers with the selected CDN or web server.

---

## Testing & Quality Assurance

### Running All Tests

```bash
# Contracts: AutoShare
cd contract/contracts/hello-world
cargo test

# Contracts: TaskBounty
cd ../../../Documents/Task\ Bounty
cargo test

# Listener: All tests
cd ../../listener
npm test

# Listener: Specific test file
npm test notification-scheduler.test.ts

# Listener: With coverage
npm test -- --coverage

# Dashboard: All tests
cd ../dashboard
npm test

# Dashboard: Watch mode
npm test -- --watch
```

### Linting

```bash
# Listener: TypeScript linting
cd listener
npm run lint  # (if lint script exists)

# Dashboard: ESLint
cd dashboard
npm run lint

# Auto-fix linting issues
npm run lint -- --fix
```

### Code Formatting

```bash
# Contracts: Rust formatting
cd contract/contracts/hello-world
cargo fmt

# Listener: (Add prettier if needed)
cd ../../listener
npx prettier --write "src/**/*.ts"

# Dashboard: (Add prettier if needed)
cd ../dashboard
npx prettier --write "src/**/*.{ts,tsx}"
```

---

## Environment Variables

### Listener Service Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STELLAR_NETWORK` | No | `testnet` | Stellar network (`testnet`, `mainnet`) |
| `STELLAR_RPC_URL` | No | `https://soroban-testnet.stellar.org:443` | Stellar RPC endpoint |
| `CONTRACT_ADDRESSES` | Yes | `[]` | JSON array of contracts to monitor |
| `POLL_INTERVAL_MS` | No | `30000` | How often to poll for events (ms) |
| `MAX_RECONNECT_ATTEMPTS` | No | `5` | Max reconnection attempts |
| `RECONNECT_DELAY_MS` | No | `5000` | Delay between reconnections (ms) |
| `EVENTS_API_PORT` | No | `8787` | API server port |
| `EVENTS_API_CORS_ORIGIN` | No | `http://localhost:5173` | CORS origin |
| `DISCORD_WEBHOOK_URL` | No | - | Discord webhook for notifications |
| `DATABASE_PATH` | No | `./data/notifications.db` | SQLite database path |
| `SCHEDULER_ENABLED` | No | `true` | Enable notification scheduler |
| `SCHEDULER_POLL_INTERVAL_MS` | No | `10000` | Scheduler poll interval (ms) |
| `SCHEDULER_BATCH_SIZE` | No | `10` | Notifications per batch |

### Contract Address Format

```json
[
  {
    "address": "CABC123...",
    "events": ["*"]  // or ["AutoshareCreated", "AutoshareUpdated"]
  },
  {
    "address": "CDEF456...",
    "events": ["TaskCreated", "WorkSubmitted"]
  }
]
```

---

## Troubleshooting

### Common Issues

#### ❌ "Module not found: 'sqlite3'"

**Solution**: Rebuild native modules
```bash
cd listener
npm rebuild sqlite3
```

#### ❌ "Database not initialized"

**Solution**: Run migrations
```bash
cd listener
npm run migrate
```

#### ❌ Port 8787 already in use

**Solution**: Change port or kill existing process
```bash
# Find process using port
lsof -i :8787  # macOS/Linux
netstat -ano | findstr :8787  # Windows

# Change port in .env
EVENTS_API_PORT=8788
```

#### ❌ Stellar CLI not found

**Solution**: Reinstall Stellar CLI
```bash
cargo install --locked stellar-cli --features opt --force
```

#### ❌ WebAssembly target not found

**Solution**: Add wasm32 target
```bash
rustup target add wasm32-unknown-unknown
```

#### ❌ Dashboard shows "Failed to fetch events"

**Checklist**:
1. Is listener running? (`curl http://localhost:8787/health`)
2. Is CORS configured? (Check `EVENTS_API_CORS_ORIGIN`)
3. Are contract addresses configured?

**Debug Steps**:
```bash
# Check listener logs
cd listener
npm run dev

# Check API directly
curl http://localhost:8787/api/events

# Check health endpoint
curl http://localhost:8787/health
```

#### ❌ Contract deployment fails with "insufficient balance"

**Solution**: Fund your test account
```bash
stellar keys fund test-user --network testnet
```

#### ❌ TypeScript compilation errors

**Solution**: Clean and reinstall
```bash
# Listener
cd listener
rm -rf node_modules dist
npm install
npm run build

# Dashboard
cd dashboard
rm -rf node_modules dist
npm install
npm run build
```

---

## Development Workflows

### Adding a New Event Listener

1. **Update contract configuration**:
```bash
cd listener
# Edit .env
CONTRACT_ADDRESSES=[{"address":"YOUR_CONTRACT","events":["NewEvent"]}]
```

2. **Restart listener**:
```bash
npm run dev
```

3. **Verify event detection**:
```bash
curl http://localhost:8787/api/events
```

### Creating a Discord Notification

1. **Create Discord webhook**:
   - Go to Discord Server → Settings → Integrations → Webhooks
   - Create webhook and copy URL

2. **Update listener configuration**:
```bash
# Edit .env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK
```

3. **Restart listener** - notifications will be sent automatically

### Scheduling a Future Notification

```bash
curl -X POST http://localhost:8787/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {"message": "Scheduled notification"},
    "notificationType": "discord",
    "targetRecipient": "webhook-url",
    "executeAt": "2024-12-31T12:00:00Z",
    "priority": 5
  }'
```

### Hot Reload Development

All components support hot reload:

- **Contracts**: Rebuild with `stellar contract build`
- **Listener**: Automatic reload with `ts-node` in dev mode
- **Dashboard**: Vite hot module replacement (HMR)

---

## Contributing Guidelines

### Before Submitting a PR

1. **Run all tests**:
```bash
npm test  # in listener/
npm test  # in dashboard/
cargo test  # in contracts/
```

2. **Check linting**:
```bash
npm run lint  # in dashboard/
cargo fmt  # in contracts/
```

3. **Verify build**:
```bash
npm run build  # in listener/ and dashboard/
stellar contract build  # in contract/
```

4. **Update documentation** if adding features

5. **Follow commit message convention**:
```
feat: Add notification templating system
fix: Resolve race condition in scheduler
docs: Update development guide
test: Add tests for Discord service
```

### Code Style Guidelines

- **TypeScript**: Follow existing patterns, use types over `any`
- **Rust**: Follow `cargo fmt` and `cargo clippy` recommendations
- **React**: Use functional components with hooks
- **Tests**: Write tests for new features
- **Comments**: Document complex logic

### Review Process

1. Fork the repository
2. Create a feature branch (`feature/my-feature`)
3. Commit changes
4. Push to your fork
5. Open a Pull Request
6. Address review feedback
7. Merge after approval

---

## Additional Resources

### Documentation

- [README.md](./README.md) - Project overview
- [LOCAL_DEVELOPMENT.md](./LOCAL_DEVELOPMENT.md) - Quick local setup
- [CONTRIBUTOR_SETUP.md](./CONTRIBUTOR_SETUP.md) - Detailed contributor setup
- [CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md](./CONTRIBUTOR_DEVELOPMENT_WORKFLOW_GUIDE.md) - Canonical contribution workflow
- [docs/](./docs/) - Additional architecture and API docs
- [dashboard/STORYBOOK.md](./dashboard/STORYBOOK.md) - Dashboard component Storybook
- [listener/INSTALLATION.md](./listener/INSTALLATION.md) - Detailed listener setup
- [listener/README-SCHEDULER.md](./listener/README-SCHEDULER.md) - Scheduler documentation
- [listener/TEST-FIXTURE-MIGRATION-GUIDE.md](./listener/TEST-FIXTURE-MIGRATION-GUIDE.md) - Testing guide

### External Links

- [Stellar Documentation](https://developers.stellar.org/)
- [Soroban Documentation](https://soroban.stellar.org/)
- [Rust Documentation](https://doc.rust-lang.org/)
- [Node.js Documentation](https://nodejs.org/docs/)
- [React Documentation](https://react.dev/)

### Community

- [GitHub Issues](https://github.com/Core-Foundry/Notify-Chain/issues)
- [GitHub Discussions](https://github.com/Core-Foundry/Notify-Chain/discussions)

---

## Summary Checklist

Before considering your setup complete, verify:

- [ ] Rust, Node.js, and Stellar CLI installed
- [ ] All dependencies installed (`npm install` in listener/ and dashboard/)
- [ ] Environment variables configured (`.env` in listener/)
- [ ] Database initialized (`npm run migrate` in listener/)
- [ ] Contracts build successfully
- [ ] Listener starts without errors
- [ ] Dashboard loads at http://localhost:5173
- [ ] API health check passes (http://localhost:8787/health)
- [ ] All tests pass

---

**You're ready to contribute to NotifyChain!** 🚀

For questions or issues, please open a [GitHub Issue](https://github.com/Core-Foundry/Notify-Chain/issues).
