# 🌐 Environment Configuration & Secrets Reference Matrix

This document provides an exhaustive reference matrix of all environment variables supported across the NotifyChain platform (Issue #693).

---

## 1. Environment Configuration Matrix

| Variable Name | Component | Type | Status | Default Value | Sensitive / Secret? | Purpose & Description |
|---|---|---|---|---|:---:|---|
| `CONTRACT_ADDRESSES` | Listener | `JSON Array` | **Required** | `None` | 🌐 Public | Array of Soroban contract addresses (`C...`) to index and monitor |
| `STELLAR_NETWORK` | All | `Enum` | Optional | `testnet` | 🌐 Public | Target Stellar network (`local`, `testnet`, `mainnet`, `standalone`) |
| `STELLAR_RPC_URL` | Listener | `URL` | Optional | `https://soroban-testnet.stellar.org` | 🌐 Public | Soroban RPC endpoint for ledger simulation and event polling |
| `STELLAR_NETWORK_PASSPHRASE` | Listener | `String` | Optional | `Test SDF Network ; September 2015` | 🌐 Public | Stellar network cryptographic passphrase |
| `HORIZON_URL` | Listener | `URL` | Optional | `https://horizon-testnet.stellar.org` | 🌐 Public | Horizon API endpoint for account balance and sequence queries |
| `POLL_INTERVAL_MS` | Listener | `Integer` | Optional | `5000` (5s) | 🌐 Public | Milliseconds between consecutive ledger polling cycles |
| `PORT` | API Server | `Integer` | Optional | `3000` | 🌐 Public | HTTP service port for REST / health endpoints |
| `LOG_LEVEL` | All | `Enum` | Optional | `info` | 🌐 Public | Log verbosity level (`debug`, `info`, `warn`, `error`) |
| `NODE_ENV` | All | `Enum` | Optional | `development` | 🌐 Public | Node runtime environment (`development`, `production`, `test`) |
| `STELLAR_SECRET_KEY` | Deployer | `StrKey` | Optional | `None` | 🔒 **Sensitive** | Deployer account secret key (`S...`) used for contract installation |
| `API_KEYS` | API Server | `JSON Array` | Optional | `[]` | 🔒 **Sensitive** | Authorized API key credentials for client authentication |
| `JWT_SECRET` | API Server | `String` | Optional | `None` | 🔒 **Sensitive** | Secret passphrase for signing and validating session JWTs |
| `DISCORD_WEBHOOK_URL` | Listener | `URL` | Optional | `None` | 🔒 **Sensitive** | Discord channel incoming webhook URL with embedded auth token |
| `WEBHOOK_SECRET` | Listener | `String` | Optional | `None` | 🔒 **Sensitive** | HMAC SHA-256 secret for signing outgoing webhook payload digests |
| `DATABASE_PATH` | Listener | `Path` | Optional | `./data/notifications.db` | 🌐 Public | SQLite persistent storage database file location |
| `ENABLE_ANALYTICS` | Listener | `Boolean` | Optional | `true` | 🌐 Public | Enables aggregate delivery and indexing metrics collection |
| `ENABLE_RETRY_SCHEDULER` | Listener | `Boolean` | Optional | `true` | 🌐 Public | Activates background worker for failed notification retries |
| `ENABLE_DLQ` | Listener | `Boolean` | Optional | `true` | 🌐 Public | Enables dead-letter isolation for repeatedly failing destinations |
| `RETRY_INITIAL_DELAY_MS` | Listener | `Integer` | Optional | `1000` (1s) | 🌐 Public | Base delay for the first exponential retry attempt |
| `RETRY_MAX_DELAY_MS` | Listener | `Integer` | Optional | `300000` (5m) | 🌐 Public | Maximum upper ceiling cap for retry backoff |
| `RETRY_MULTIPLIER` | Listener | `Float` | Optional | `2.0` | 🌐 Public | Exponential multiplication factor for successive retries |
| `RETRY_JITTER_RATIO` | Listener | `Float` | Optional | `0.2` (±20%) | 🌐 Public | Random jitter ratio to eliminate thundering herd synchronization |

---

## 2. Security & Redaction Rules

1. **🔒 Sensitive Variables**: Any variable designated as **Sensitive** (`STELLAR_SECRET_KEY`, `DISCORD_WEBHOOK_URL`, `JWT_SECRET`, `API_KEYS`) must never be logged, included in build artifacts, or returned via diagnostic endpoints.
2. **Deterministic Defaults**: Non-sensitive variables have safe, documented local/testnet defaults allowing instant local execution.
