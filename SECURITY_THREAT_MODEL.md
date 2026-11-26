# NotifyChain — Security Threat Model

> **Audience**: Contributors, maintainers, and security reviewers.
> **Status**: Living document — update when architecture or mitigations change.
> **Companion docs**: [`ARCHITECTURE_OVERVIEW.md`](ARCHITECTURE_OVERVIEW.md),
> [`BACKEND_ARCHITECTURE.md`](BACKEND_ARCHITECTURE.md),
> [`ENVIRONMENT_VARIABLES_AND_SECRETS.md`](ENVIRONMENT_VARIABLES_AND_SECRETS.md)

---

## Table of Contents

1. [Scope](#1-scope)
2. [System Components](#2-system-components)
3. [Critical Assets](#3-critical-assets)
4. [Trust Boundaries](#4-trust-boundaries)
5. [Attack Vectors and Mitigations](#5-attack-vectors-and-mitigations)
   - [5.1 Smart Contract Layer](#51-smart-contract-layer)
   - [5.2 Listener Service (Off-Chain)](#52-listener-service-off-chain)
   - [5.3 Database Layer](#53-database-layer)
   - [5.4 Dashboard](#54-dashboard)
   - [5.5 Outbound Webhooks and Delivery Targets](#55-outbound-webhooks-and-delivery-targets)
   - [5.6 Secrets and Configuration](#56-secrets-and-configuration)
6. [External Dependencies and Trust Assumptions](#6-external-dependencies-and-trust-assumptions)
7. [Remaining Security Assumptions and Open Risks](#7-remaining-security-assumptions-and-open-risks)
8. [Threat Summary Table](#8-threat-summary-table)
9. [Review and Maintenance](#9-review-and-maintenance)

---

## 1. Scope

This document covers the security posture of the full NotifyChain stack:

- The **Soroban contracts**: AutoShare (`contract/contracts/hello-world/`) and the
  TaskBounty reference contract (`Documents/Task Bounty/`)
- The **Listener service** (`listener/`) — the off-chain Node.js backend that ingests events, persists state, and dispatches notifications
- The **SQLite / PostgreSQL database** used by the Listener
- The **React dashboard** (`dashboard/`) — read-only browser UI
- The **legacy React frontend** (`frontend/`) — wallet-driven analytics and preferences UI
- **CI/CD and deployment tooling** (`.github/`, deployment scripts, containers)
- **Outbound delivery targets**: Discord webhooks, HTTP webhooks, email

It does **not** cover:
- The underlying Stellar/Soroban network security model (delegated to Stellar Foundation)
- External wallet/browser security guarantees
- OS, container, Kubernetes, cloud IAM, or network hardening of the deployment host
- Third-party contract implementations beyond their direct integration boundary

The model uses impact levels (Low, Medium, High, Critical), STRIDE-style threat
categories (spoofing, tampering, repudiation, information disclosure, denial of
service, and elevation of privilege), and explicit open-risk tracking. A threat
is considered mitigated only when the repository or deployment documentation
provides a concrete control.

---

## 2. System Components

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              NotifyChain                                │
│                                                                         │
│  ┌─────────────┐   Soroban txns    ┌────────────────────────────────┐  │
│  │ Users/dApps │ ───────────────▶  │  AutoShare Smart Contract      │  │
│  └─────────────┘                   │  (Rust/Wasm on Stellar)        │  │
│                                    └────────────┬───────────────────┘  │
│                                                 │ emits events          │
│                                                 ▼                       │
│                             ┌───────────────────────────────────────┐  │
│                             │         Stellar RPC Node              │  │
│                             └───────────────┬───────────────────────┘  │
│                                             │ getLedgerEvents (poll)    │
│                                             ▼                           │
│                             ┌───────────────────────────────────────┐  │
│                             │       Listener Service (Node.js)      │  │
│                             │                                        │  │
│                             │  EventSubscriber → Deduplicator       │  │
│                             │  NotificationDispatcher               │  │
│                             │  REST API (:8787)                     │  │
│                             └────────┬──────────────────────────────┘  │
│                                      │                                  │
│                  ┌───────────────────┼──────────────────┐              │
│                  ▼                   ▼                   ▼              │
│          ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│          │   Database   │  │  Discord/HTTP     │  │    Dashboard     │ │
│          │  (SQLite/PG) │  │  Webhook targets  │  │  (React, r/o)   │ │
│          └──────────────┘  └──────────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

| Component | Technology | Role |
|---|---|---|
| Soroban Contracts | Rust → Wasm (Soroban) | Authoritative on-chain state: AutoShare groups/payments/audit and TaskBounty tasks/disputes/payouts |
| Listener Service | Node.js / TypeScript | Event ingestion, deduplication, DB persistence, outbound delivery, REST API |
| Database | SQLite (dev) / PostgreSQL (prod) | Off-chain event history, delivery state, rate-limit records |
| Dashboard | React / Vite | Read-only operator view of the event feed |
| Frontend | React (Create React App) | Wallet-driven UI for subscriptions, preferences, and analytics |
| CI/CD | GitHub Actions and repository scripts | Test, build, package, and deployment automation |
| Webhook targets | External HTTP / Discord API | Consumers of notification dispatches |

---

## 3. Critical Assets

The following assets are ordered by impact of compromise.

| # | Asset | Location | Impact if compromised |
|---|---|---|---|
| 1 | **Admin private key** | Operator-managed Stellar keypair | Full contract control: pause, withdraw funds, transfer ownership, reconfigure limits |
| 2 | **Contract token balances** | On-chain (Soroban persistent storage) | Drained via `withdraw`; irreversible once sent |
| 3 | **Listener API keys** (`API_KEYS` env var) | Listener process environment | Full read access to all events, notifications, and audit records |
| 4 | **Webhook HMAC secrets** (`WEBHOOK_SECRETS`) | Listener process environment | Allows forging signed webhook payloads, poisoning consumer systems |
| 5 | **Discord webhook URL** (`DISCORD_WEBHOOK_URL`) | Listener process environment | Spam / phishing posts to operator Discord channels |
| 6 | **Database contents** | SQLite file or PostgreSQL instance | Full event history, notification metadata, delivery state, operational patterns |
| 7 | **Scheduled notifications (on-chain titles)** | Soroban persistent storage | Notification `title` is plaintext and permanently public once written |
| 8 | **Stellar network passphrase** (`STELLAR_NETWORK_PASSPHRASE`) | Listener config | Transaction replay across networks (testnet ↔ mainnet) |
| 9 | **Recipient preferences (on-chain)** | Soroban persistent storage | Channel toggle state is publicly readable; reveals delivery channel usage |
| 10 | **Audit log (on-chain)** | Soroban persistent storage | Publicly readable; reveals actor addresses and all lifecycle timing |
| 11 | **Wallet private keys and browser wallet state** | User/browser wallet | Can authorize funds, notification changes, or account actions; compromise affects the wallet owner |
| 12 | **Deployment and CI secrets** | GitHub Actions, environment stores, deployment hosts | Can publish unauthorized builds or grant access to chain keys, APIs, databases, and webhooks |
| 13 | **TaskBounty escrow and submission state** | Ethereum/Solidity or deployed contract storage | Incorrect authorization or escrow loss can affect rewards and dispute outcomes |

---

## 4. Trust Boundaries

### Boundary B1 — Users/dApps → Smart Contract

**How it works:** Users call contract functions by submitting signed Soroban transactions to the Stellar network. Soroban enforces `address.require_auth()` before any state-mutating function executes. The contract cannot be invoked without a valid transaction bearing a correct signature for the stated caller address.

**What is trusted:** The Stellar network's signature validation. The contract never receives a call that hasn't passed network-level auth.

**What is NOT trusted:** The content of arguments. The contract validates all inputs explicitly (see Section 5.1).

**Threat direction:** Inbound to the contract.

---

### Boundary B2 — Smart Contract → Listener (event pull)

**How it works:** The Listener polls the Stellar RPC (`getLedgerEvents`) on a configurable interval (default 30 s). Events are public, immutable ledger data — no authentication is used or needed to read them.

**What is trusted:** Event data is treated as authentic ledger state. The Listener does not independently verify signatures on individual event fields.

**What is NOT trusted:** RPC availability; cursor state (the Listener guards against reorgs and backfill overruns). The Stellar RPC URL itself — if it is substituted by a misconfigured env var, the Listener will silently process events from the wrong network or contract.

**Threat direction:** The RPC endpoint is an external dependency; the Listener is the consumer.

---

### Boundary B3 — Listener REST API → Dashboard / External API Clients

**How it works:** The Listener exposes an HTTP REST API on `EVENTS_API_PORT` (default 8787). Access is authenticated via `X-API-Key` header. Keys are compared using `crypto.timingSafeEqual` after SHA-256 hashing both sides (`listener/src/api/api-key-auth.ts`). Scoped credentials (`nck_…` prefix) add endpoint-level scope enforcement.

**What is trusted:** A request bearing a valid API key is treated as an authorized API consumer.

**What is NOT trusted:** The source IP or the content of request bodies. Body size is bounded, CORS is validated, and rate limiting applies.

**Threat direction:** Inbound to the Listener API.

---

### Boundary B4 — Listener → Outbound Webhook / Discord Targets

**How it works:** The Listener POSTs notification events as signed JSON to configured webhook URLs. Payloads are HMAC-signed with secrets from `WEBHOOK_SECRETS`. Discord uses a separate URL/ID pair.

**What is trusted:** The receiving consumer is expected to verify the HMAC signature before acting on the payload.

**What is NOT trusted:** The webhook target URL itself — if an operator misconfigures a URL controlled by an attacker, the Listener will POST events (and secrets in HMAC headers) to that URL.

**Threat direction:** Outbound from the Listener; SSRF risk (see Section 5.5).

---

### Boundary B5 — Listener → Database

**How it works:** Listener is the sole writer and reader. No other component has direct DB access. The DB path/URL is controlled by `DATABASE_PATH` / `DATABASE_URL` env vars.

**What is trusted:** The database is a fully trusted component — Listener never re-validates data it wrote.

**What is NOT trusted:** External actors; the database is not reachable from outside the Listener process in a correctly deployed system.

**Threat direction:** Listener is the only actor; risk comes from misconfiguration or host-level access.

---

### Boundary B6 — Wallet/Frontend/Dashboard → Contracts and Listener

**How it works:** Browser users use a wallet to sign Stellar or Ethereum contract
transactions. The React dashboard and legacy frontend also call the Listener API
for event and preference data.

**What is trusted:** The wallet correctly displays transaction intent and
protects the user's private key. The Listener auth layer protects API operations
when API keys are configured.

**What is NOT trusted:** Browser JavaScript, injected wallet providers, local
storage, network responses, and user-supplied preference data. Browser code
must not be treated as an authorization mechanism.

**Threat direction:** Inbound to the contract or Listener; compromised browser
code can ask a wallet to approve malicious transactions or expose public UI data.

---

### Boundary B7 — Repository/CI/CD → Packages and Deployment Targets

**How it works:** GitHub Actions and repository scripts run tests, build artifacts,
sign or deploy contracts, publish images, and configure environments.

**What is trusted:** Maintainers and protected branches, and the trusted runner
or deployment identity while a job is executing.

**What is NOT trusted:** Pull-request code, third-party actions, package
downloads, build scripts, generated artifacts, and mutable runner images.

**Threat direction:** Supply-chain inbound to source, artifacts, credentials,
and production deployments.

---

## 5. Attack Vectors and Mitigations

### 5.1 Smart Contract Layer

#### T-C1: Unauthorized Admin Action

| | |
|---|---|
| **Description** | Attacker attempts to call `pause`, `withdraw`, `transfer_admin`, `configure_notification_limits`, or other admin-only functions without holding the admin private key. |
| **Vector** | Craft a transaction calling an admin function with an arbitrary `admin: Address` argument. |
| **Mitigation** | Every admin function calls both `admin.require_auth()` (Soroban cryptographic auth check) and `require_admin(&env, &admin)` (storage comparison against the recorded admin address). Both must pass. Without the admin private key, the transaction is rejected at the network level. |
| **Residual risk** | Low. Entirely dependent on key custody. |

#### T-C2: Admin Key Compromise / Hostile Takeover

| | |
|---|---|
| **Description** | Admin private key is leaked or social-engineered, allowing an attacker to drain funds or pause the contract. |
| **Vector** | Key extracted from compromised deployment environment, phishing, or insider threat. |
| **Mitigation** | Two-step ownership transfer (`initiate_ownership_transfer` + `accept_ownership`) prevents unilateral admin reassignment — a rogue actor can't silently hand the key to themselves. `AuthorizationFailure` events are emitted for failed auth attempts, alerting the Listener. |
| **Residual risk** | High if key custody practices are weak. Use hardware wallets or multi-sig for the admin key in production. |

#### T-C3: Duplicate Notification ID Injection

| | |
|---|---|
| **Description** | A caller re-submits a notification with an already-used `notification_id` to overwrite or replay existing state. |
| **Vector** | Call `schedule_notification` or `batch_schedule_notifications` with a known existing ID. |
| **Mitigation** | Both functions check `env.storage().persistent().has(&key)` before writing and return `Error::AlreadyExists` if the ID is taken. The batch path also detects intra-batch duplicate IDs before persisting any entry (all-or-nothing semantics). |
| **Residual risk** | Very low. |

#### T-C4: Batch Bomb (Resource Exhaustion via Large Batch)

| | |
|---|---|
| **Description** | Caller submits a single transaction containing thousands of notifications to exhaust contract ledger storage or execution budget. |
| **Vector** | Call `batch_schedule_notifications` with a very large `ids` array. |
| **Mitigation** | `MAX_BATCH_SIZE = 50` is enforced; the function returns `Error::BatchTooLarge` for oversized inputs. Per-notification TTL and title validation still apply to every entry. |
| **Residual risk** | Low. Soroban instruction limits provide an additional cap. |

#### T-C5: Notification Lifetime Manipulation

| | |
|---|---|
| **Description** | Caller sets an extremely long or zero TTL to create never-expiring or instantly-expiring notifications. |
| **Vector** | Pass `ttl_seconds = 0` or `ttl_seconds = u64::MAX` to `schedule_notification`. |
| **Mitigation** | `ttl_seconds == 0` returns `Error::InvalidExpirationDuration`. Values exceeding `MAX_NOTIFICATION_LIFETIME_SECONDS` return `Error::NotificationLifetimeTooLong`. Arithmetic overflow on `created_at + ttl_seconds` is caught with `checked_add`, returning `InvalidExpirationDuration`. |
| **Residual risk** | Low. |

#### T-C6: Payment Token Substitution

| | |
|---|---|
| **Description** | Caller passes an unsupported or malicious token address to `create` or `topup_subscription`, causing the contract to interact with an arbitrary Soroban token contract. |
| **Vector** | Provide an address not in the admin-controlled supported-token list. |
| **Mitigation** | `is_token_supported` is checked before any token interaction. Unsupported tokens return `Error::UnsupportedToken`. Only the admin can add tokens via `add_supported_token`. |
| **Residual risk** | Low for core path. If the admin adds a malicious token (rug-pull token), users paying into that group are at risk — admin key custody is again the root control. |

#### T-C7: Member Percentage Manipulation

| | |
|---|---|
| **Description** | Attacker or malicious group creator configures member payout percentages that don't sum to 100, redirecting funds. |
| **Vector** | Call `update_members` with a crafted `new_members` array. |
| **Mitigation** | `update_members` validates: percentages sum to exactly 100, no duplicate addresses, non-empty list. Returns appropriate error codes (`InvalidTotalPercentage`, `DuplicateMember`, `EmptyMembers`). |
| **Residual risk** | Low. |

#### T-C8: Audit Log Spam / False Actor Injection

| | |
|---|---|
| **Description** | Anyone can call `record_delivery_attempt`, `record_delivery_failure`, and `record_acknowledgment` with any `actor: Address` for any notification, polluting the audit trail with false records. |
| **Vector** | Craft transactions calling audit-recording functions with fabricated actor addresses or notification IDs that the caller has no relationship to. |
| **Mitigation** | **None currently.** These three functions accept any caller and any actor address without verifying the relationship between caller and notification. |
| **Residual risk** | **High.** The immutable on-chain audit log can be filled with false entries, undermining its forensic value. This is an open gap — see Section 7. |

#### T-C9: Unauthorized Notification Revocation / Recall / Delivery Confirmation

| | |
|---|---|
| **Description** | A third party revokes, recalls, or confirms delivery of a notification they did not create. |
| **Vector** | Call `revoke_notification`, `recall_notification`, or `confirm_notification_delivery` with an arbitrary `caller`. |
| **Mitigation** | All three functions check that `caller` is either the notification creator or the contract admin. They call `caller.require_auth()` and perform a creator/admin comparison. Unauthorized callers receive `Error::NotAuthorizedToRevoke` or `Error::Unauthorized`. |
| **Residual risk** | Low. |

#### T-C10: Contract Pause Griefing

| | |
|---|---|
| **Description** | Attacker with the admin key pauses the contract, blocking all notification scheduling. |
| **Vector** | Call `pause`. |
| **Mitigation** | Only admin can pause. `ContractPaused` event is emitted and observable. `unpause` is equally restricted. The two-step ownership transfer means the pause power cannot be covertly transferred. |
| **Residual risk** | Entirely depends on admin key security. |

---

### 5.2 Listener Service (Off-Chain)

#### T-L1: API Key Brute Force / Timing Oracle

| | |
|---|---|
| **Description** | Attacker sends many requests guessing API key values, or exploits a non-constant-time comparison to infer key characters. |
| **Vector** | Automated key-guessing against the `X-API-Key` endpoint. |
| **Mitigation** | `authenticateApiKey` hashes both the provided and expected keys with SHA-256 before calling `crypto.timingSafeEqual`, making comparison constant-time and length-independent (`api-key-auth.ts`). Rate limiting caps requests from any single client. |
| **Residual risk** | Low with rate limiting in place. Keys should be at least 32 bytes of random entropy. |

#### T-L2: Unauthenticated Access in Production (Misconfiguration)

| | |
|---|---|
| **Description** | Operator deploys without setting `API_KEYS`, leaving the API open to anyone. |
| **Vector** | Empty `API_KEYS` env var. |
| **Mitigation** | When `API_KEYS` is empty, the API is intentionally open (backward-compatible dev mode). The `enforced: false` flag in the auth result signals this explicitly. Config validation warns on startup. |
| **Residual risk** | **Medium.** No hard startup failure when `API_KEYS` is unset. Production deployments must explicitly set keys. This should be enforced by the deployment checklist and ideally a startup check. |

#### T-L3: Denial of Service via Oversized Requests

| | |
|---|---|
| **Description** | Attacker sends gigabyte-sized request bodies to exhaust the Listener's heap memory. |
| **Vector** | POST a very large body to any ingest endpoint. |
| **Mitigation** | `enforceBodyLimit` middleware (`middleware/body-limit.ts`) applies a dual check: reject on `Content-Length` header if over 1 MiB, then a streaming byte counter as backstop. Oversized requests receive a 413, the socket is destroyed, and no body bytes are buffered beyond the limit. |
| **Residual risk** | Low. |

#### T-L4: Denial of Service via Request Flooding

| | |
|---|---|
| **Description** | Attacker floods the API with legitimate-sized requests to saturate the event loop. |
| **Vector** | High-frequency authenticated or unauthenticated requests. |
| **Mitigation** | `RateLimiter` class limits each client (keyed by API key or IP) to a configurable request count per window (default 60/60 s). Rate limit events are logged to DB. Exceeding the limit returns 429 with a `Retry-After` header. |
| **Residual risk** | Low for client-keyed rate limiting. IP-keyed rate limiting can be evaded from multiple source IPs (requires upstream network-level controls for full mitigation). |

#### T-L5: Cross-Site Request Forgery (CSRF)

| | |
|---|---|
| **Description** | A malicious web page forces a logged-in dashboard user's browser to issue state-changing requests to the Listener API. |
| **Vector** | Embedded `<img>` or `fetch()` from an attacker-controlled page targeting the Listener. |
| **Mitigation** | CORS origin validation rejects cross-origin requests that don't match `EVENTS_API_CORS_ORIGIN`. The `X-API-Key` header is a custom header; browsers require a preflight (OPTIONS) for custom headers, which CORS validation blocks. The dashboard is strictly read-only — no write endpoints exist via the dashboard path. |
| **Residual risk** | Low. Dashboard write operations don't exist. |

#### T-L6: Clickjacking

| | |
|---|---|
| **Description** | Attacker embeds the dashboard in an iframe on a hostile page to trick operators into performing actions. |
| **Vector** | `<iframe src="https://notifychain-dashboard.example.com">` on attacker page. |
| **Mitigation** | `X-Frame-Options: SAMEORIGIN` header set by `addSecurityHeaders` (`middleware/security-headers.ts`) prevents cross-origin embedding. |
| **Residual risk** | Low. |

#### T-L7: Ledger Reorg Replay

| | |
|---|---|
| **Description** | A Stellar ledger reorganization causes the same event to be re-emitted, triggering duplicate notifications to end users. |
| **Vector** | Natural blockchain reorg, or Listener restart without cursor state. |
| **Mitigation** | Two-layer deduplication: a persistent `EventDeduplicationService` (SQLite-backed, survives restarts) and an in-memory `NotificationDeduplicator` (LRU, 60-second window). Re-emitted events during reorgs are marked `is_reorg_duplicate = true` and skipped for dispatch. |
| **Residual risk** | Low for single-instance deployments. Edge cases may exist under deep reorgs beyond the deduplication window. |

#### T-L8: RPC Endpoint Substitution

| | |
|---|---|
| **Description** | Attacker or misconfigured deployment points `STELLAR_RPC_URL` at a malicious or wrong-network RPC node, causing the Listener to process events from a different contract or network. |
| **Vector** | `STELLAR_RPC_URL` or `STELLAR_RPC_FALLBACK_URLS` set to attacker-controlled endpoint. |
| **Mitigation** | `STELLAR_NETWORK_PASSPHRASE` is validated at startup and used in transaction signing — events from a different network passphrase will not validate. Contract address(es) are explicitly configured via `CONTRACT_ADDRESSES` and validated at startup. |
| **Residual risk** | Medium. A wrong-but-valid-passphrase RPC returning events from a different contract of the same address would be difficult to detect. Operators should source RPC URLs from the Stellar Foundation or verified providers only. |

#### T-L9: DNS Rebinding

| | |
|---|---|
| **Description** | Attacker uses DNS rebinding to make the Listener API respond to requests from a hostile browser-side origin. |
| **Vector** | Craft a domain that initially resolves to a public IP then rebinds to `127.0.0.1`. |
| **Mitigation** | `dns-rebinding-guard.ts` middleware validates the `Host` header against configured allowed values and rejects requests with unexpected hostnames. |
| **Residual risk** | Low with correct configuration of allowed hosts. |

#### T-L10: Webhook Delivery Replay Attack

| | |
|---|---|
| **Description** | A consumer or eavesdropper replays a previously valid signed webhook payload to trigger duplicate actions on the receiving system. |
| **Vector** | Capture a webhook POST body and re-POST it at the target. |
| **Mitigation** | `webhook-replay-cache.ts` maintains a time-bounded cache of recently sent delivery IDs; duplicates within the cache window are rejected. HMAC signature alone does not prevent replay; the cache window is the actual control. |
| **Residual risk** | Low within the cache window; payloads replayed after cache expiry may succeed. Consumers should implement their own idempotency checks using the `notification_id`. |

---

### 5.3 Database Layer

#### T-D1: SQL Injection

| | |
|---|---|
| **Description** | Attacker injects SQL through user-controlled inputs to read or modify the database. |
| **Vector** | Malicious content in event fields processed by the Listener, or API query parameters. |
| **Mitigation** | All database operations use parameterized queries (prepared statements via the DB library). Event fields from the chain are treated as data, not SQL. |
| **Residual risk** | Low for parameterized queries. Any dynamic query construction outside ORM calls should be audited. |

#### T-D2: Unauthorized Database Access

| | |
|---|---|
| **Description** | Attacker gains direct access to the SQLite file or PostgreSQL instance. |
| **Vector** | Misconfigured file permissions (SQLite), exposed PostgreSQL port, or compromised host. |
| **Mitigation** | No direct DB access is exposed through the application layer. Database files should have OS-level read restrictions (owner: Listener process user only). PostgreSQL connections should use credentials and restrict network access to localhost or a private subnet. |
| **Residual risk** | Medium. Entirely dependent on host and network configuration. The threat model cannot enforce this — it must be part of the deployment checklist. |

#### T-D3: Data Volume Exhaustion

| | |
|---|---|
| **Description** | A high-event-rate contract fills the DB indefinitely, exhausting disk space. |
| **Vector** | Legitimate high-volume contract activity or deliberate event flooding on-chain. |
| **Mitigation** | Cleanup scheduler (`AppCleanupService`) prunes processed events, rate-limit records, and execution logs on a configurable retention schedule (`CLEANUP_RETENTION_DAYS`, default 30 days). Backfill limits (`BACKFILL_MAX_LEDGERS`, default 10,000 ledgers) prevent cold-start backfill from bulk-writing historical events. |
| **Residual risk** | Low with cleanup enabled. Operators should monitor disk usage and tune retention settings. |

---

### 5.4 Dashboard

#### T-DH1: Sensitive Data Exposure via Dashboard

| | |
|---|---|
| **Description** | Dashboard exposes API keys or secrets in browser memory or network traffic. |
| **Vector** | Dashboard rendered in an operator's browser leaks secrets to browser extensions or network observers. |
| **Mitigation** | The dashboard is strictly read-only; it never handles API keys or webhook secrets. It communicates with the Listener API over `VITE_EVENTS_API_URL` and relies on the Listener's API key enforcement for access control. TLS (HTTPS) in production is enforced by `Strict-Transport-Security` on the Listener. |
| **Residual risk** | Low. The dashboard carries no secrets of its own. |

#### T-DH2: Content Type Sniffing / MIME Confusion

| | |
|---|---|
| **Description** | Browser misinterprets a JSON response as HTML, potentially executing injected script. |
| **Vector** | Listener response without an explicit content type. |
| **Mitigation** | `X-Content-Type-Options: nosniff` header is set on all Listener responses. API responses explicitly set `Content-Type: application/json`. |
| **Residual risk** | Very low. |

#### T-DH3: Malicious Transaction or Wallet Prompt

| | |
|---|---|
| **Description** | A malicious or compromised frontend presents a misleading action or requests approval for an unintended contract transaction. |
| **Vector** | Modified UI assets, compromised dependencies, phishing, or a malicious injected wallet provider. |
| **Mitigation** | Mutating authorization is enforced on-chain by contract `require_auth()` checks, not in the frontend; the UI labels wallet state and transaction intent. |
| **Residual risk** | Medium. Users must verify recipient, amount, network, and contract address in the wallet. Treat UI transaction previews as untrusted until confirmed by the wallet. |

#### T-DH4: Frontend Dependency or Build-Supply-Chain Compromise

| | |
|---|---|
| **Description** | A package or build pipeline injects malicious JavaScript into a dashboard or frontend deployment. |
| **Vector** | Compromised npm package, unreviewed action, mutable build version, or release from an unprotected branch. |
| **Mitigation** | Lockfiles and normal CI test/build checks reduce drift. Production deployments should use protected branches and pinned dependencies/actions. |
| **Residual risk** | Medium because runtime integrity is not continuously attested. |

---

### 5.5 Outbound Webhooks and Delivery Targets

#### T-W1: Server-Side Request Forgery (SSRF) via Webhook URL

| | |
|---|---|
| **Description** | An operator (or attacker who gains config access) sets a webhook URL pointing to an internal service (e.g., `http://169.254.169.254/latest/meta-data/`) to exfiltrate cloud metadata or pivot to internal services. |
| **Vector** | Malicious `WEBHOOK_TARGET_URL` configuration value. |
| **Mitigation** | **Partial.** The Listener includes a `dns-rebinding-guard` for the inbound API but webhook *target* URL validation relies on correct operator configuration. No code-enforced allowlist for outbound webhook URLs was identified in source. |
| **Residual risk** | **Medium.** Deploy the Listener in a network environment that blocks access to internal metadata services and RFC-1918 ranges from the Listener process. An explicit webhook URL allowlist (regex or domain allowlist) would reduce this risk in-process. |

#### T-W2: Webhook Target Impersonation

| | |
|---|---|
| **Description** | Attacker intercepts webhook deliveries by substituting their server's TLS certificate for the legitimate target. |
| **Vector** | MITM attack or DNS hijacking of the webhook target domain. |
| **Mitigation** | HTTPS connections enforce TLS certificate validation (Node.js default). Consumers should verify the HMAC signature on received payloads. |
| **Residual risk** | Low for TLS-terminated endpoints. |

#### T-W3: Webhook Secret Leakage via Logs

| | |
|---|---|
| **Description** | HMAC secrets are accidentally written to logs during error handling. |
| **Vector** | Exception log that serializes the full config object including `WEBHOOK_SECRETS`. |
| **Mitigation** | The rate limiter masks API key values in log output (`clientId.slice(0, 8) + '...'`). Secret values should never be passed to `logger.*` calls. |
| **Residual risk** | Low with disciplined log hygiene; should be verified in a code audit. |

---

### 5.6 Secrets and Configuration

#### T-S1: Secrets in Environment Variables

| | |
|---|---|
| **Description** | Environment variables are readable by any process running as the same OS user, or exposed via `/proc/[pid]/environ` on Linux. |
| **Vector** | Host-level compromise or accidental logging of `process.env`. |
| **Mitigation** | Secrets should be injected via a secrets manager (AWS Secrets Manager, HashiCorp Vault, Kubernetes Secrets with encryption at rest) rather than plaintext env files in production. `.env` files are excluded from version control via `.gitignore`. `.env.example` contains only placeholder values. |
| **Residual risk** | Medium for simple env-var deployments. Use a secrets manager in production. |

#### T-S2: Schema Version / Network Mismatch

| | |
|---|---|
| **Description** | Listener processes events from the wrong network or contract version, misinterpreting payloads. |
| **Vector** | `STELLAR_NETWORK_PASSPHRASE` misconfigured to point to testnet while contract is on mainnet. |
| **Mitigation** | `STELLAR_NETWORK_PASSPHRASE` is a required config value validated at startup. Contract address list is validated for non-empty string format. The contract exposes `get_schema_version` and `is_version_supported`; the Listener should check `payload_version` on `NotificationScheduled` events and skip/warn on unsupported versions. |
| **Residual risk** | Low with startup validation. Add explicit version-check logging. |

---

## 6. External Dependencies and Trust Assumptions

| Dependency | Trust Level | Risk | Notes |
|---|---|---|---|
| **Stellar Network / Soroban** | High trust | Availability, finality, consensus security | NotifyChain's entire on-chain trust model depends on Stellar's consensus. Network outages block new notifications. |
| **Stellar RPC Node** | Medium trust | Availability, correct event delivery | A malicious or malfunctioning RPC node could withhold or delay events. Circuit breaker and fallback URLs (`STELLAR_RPC_FALLBACK_URLS`) mitigate outages. Verifying events against multiple independent RPC nodes would increase confidence. |
| **Payment Token Contracts** | Medium trust | Admin-allowlisted only; can call arbitrary Soroban contracts | An admin-added malicious token contract could have unexpected side-effects on `transfer` calls. Only add tokens from audited, known-good issuers. |
| **Discord API** | Low trust (output only) | URL/secret leakage enables spam | NotifyChain only sends to Discord; no inbound trust. |
| **Outbound HTTP webhook targets** | Low trust (output only) | SSRF, secret exposure | Operator-configured; no code-enforced validation. See T-W1. |
| **Node.js runtime and npm packages** | Medium trust | Supply chain attacks via transitive dependencies | Regular `npm audit`, lock file integrity checks, and dependency pinning reduce risk. |
| **Host OS / container runtime** | High trust (assumed) | Full compromise if host is breached | Threat model assumes the deployment host is not compromised. Use container isolation and least-privilege process users. |
| **SQLite / PostgreSQL** | High trust (assumed) | Full data exposure if DB is accessible to unauthorized actors | No network exposure assumed; OS file permissions and PG auth are the controls. |
| **Browser / wallet provider** | Medium trust | Transaction phishing, injected provider, or compromised browser state | The wallet must be the final confirmation layer. Contract and Listener authorization must never rely on browser state alone. |
| **GitHub Actions / third-party actions** | Medium trust | Workflow compromise, secret exfiltration, or unauthorized artifact publication | Use protected branches, least-privilege tokens, pinned actions, environment approvals, and artifact provenance. |
| **TaskBounty deployment environment** | Medium trust | Compromised deployer key or malicious contract bytecode | Separate development/test credentials from production; verify source, bytecode, and deployment transaction before release. |
| **Email and notification providers** | Low trust (output only) | Credential theft, provider outage, abuse, or payload disclosure | Preserve no secrets in message bodies; restrict provider credentials and monitor anomalous volume. |

---

## 7. Remaining Security Assumptions and Open Risks

The following are known gaps or unresolved assumptions that require attention before treating NotifyChain as production-hardened.

### Open Risk R1 — Audit Log Integrity (High)

**Problem:** `record_delivery_attempt`, `record_delivery_failure`, and `record_acknowledgment`
require authentication for the supplied `actor` address, but do not verify that the
authenticated actor is the notification creator, recipient, admin, or an authorized
relay. Unknown, revoked, and expired notification IDs are rejected, but any account
can still append records to an existing auditable notification.

**Recommendation:** Restrict these entry points to: the notification creator, the contract admin, or an allowlisted set of authorized reporter addresses. Add `caller.require_auth()` and a creator/admin check, consistent with the pattern used in `revoke_notification` and `confirm_notification_delivery`.

---

### Open Risk R2 — No Outbound Webhook URL Allowlist (Medium)

**Problem:** The Listener will POST to any URL in `WEBHOOK_SECRETS` / webhook config without validating the destination. This creates an SSRF vector if config is compromised or misconfigured.

**Recommendation:** Add a startup-time URL allowlist validator that rejects RFC-1918 addresses, loopback, and cloud metadata endpoints (`169.254.169.254`, `fd00::/8`, etc.). Consider a configurable regex allowlist for permitted webhook domains.

---

### Open Risk R3 — Open API in Empty-Key Deployments (Medium)

**Problem:** When `API_KEYS` is not configured, the Listener API is fully open. No startup error or hard warning prevents accidental production deployment without keys.

**Recommendation:** Add an explicit environment-aware check: if `NODE_ENV=production` and `API_KEYS` is empty, log a prominent `SECURITY WARNING` and optionally refuse to start (configurable via `REQUIRE_API_KEY_IN_PRODUCTION=true`).

---

### Open Risk R4 — Notification Title is Permanently Public On-Chain (Low / Operational)

**Problem:** The `title` field of a `ScheduledNotification` is stored in Soroban persistent storage in plaintext. Once written, it is permanently readable by anyone and cannot be deleted or redacted.

**Recommendation:** Document clearly that notification titles must not contain PII, secrets, or sensitive operational content. Consider treating `title` as a user-visible label only, with sensitive metadata passed off-chain.

---

### Open Risk R5 — `get_audit_log` is Unrestricted (Low)

**Problem:** `get_audit_log` returns the full on-chain audit history with actor addresses, action types, and timestamps to any caller, with no access control.

**Recommendation:** Acceptable for an audit system whose purpose is public accountability. If operator confidentiality is required, move detailed audit data off-chain and restrict the on-chain log to minimal identifiers. Document the current behavior explicitly.

---

### Open Risk R6 — Replay After Webhook Cache Expiry (Low)

**Problem:** The `webhook-replay-cache` only protects against replays within its configured time window. Consumers cannot distinguish a legitimate re-delivery (after Listener retry) from a replay after cache expiry.

**Recommendation:** Consumers should implement idempotency on their side using `notification_id` as a unique key. Document this expectation in the webhook consumer guide.

---

### Open Risk R7 — Listener Not Hardened Against Malicious RPC Responses (Low)

**Problem:** A compromised or malicious Stellar RPC node could return crafted event payloads. The Listener trusts event data as authentic ledger state.

**Recommendation:** Cross-validate critical events (admin transfers, withdrawals) against a secondary independent RPC endpoint when high-value actions are detected. Log and alert on `AuthorizationFailure` and `AdminTransferred` events immediately.

---

### Open Risk R8 — Browser and Wallet Compromise (High)

**Problem:** A compromised frontend, dependency, wallet extension, or phishing page
can induce a user to sign an unintended transaction or expose public account state.

**Recommendation:** Keep authorization checks on-chain and in the Listener, publish
release integrity information, and require users to verify network, contract address,
recipient, and amount in the wallet. Use strict CSP and dependency review on browser
deployments.

---

### Open Risk R9 — CI/CD Secret and Artifact Trust (High)

**Problem:** Workflow secrets and deployment artifacts are security-critical trust
inputs. An unreviewed workflow change or compromised third-party action could disclose
credentials or publish unauthorized artifacts.

**Recommendation:** Pin reviewed third-party actions, restrict workflow permissions,
protect production environments, require approvals, separate test and production
credentials, and prefer short-lived deployment identities with audit logs.

---

## 8. Threat Summary Table

| ID | Component | Threat | Severity | Mitigated? | Notes |
|---|---|---|---|---|---|
| T-C1 | Contract | Unauthorized admin action | Critical | ✅ Yes | `require_auth` + `require_admin` double check |
| T-C2 | Contract | Admin key compromise | Critical | ⚠️ Partial | Two-step transfer helps; key custody is the gap |
| T-C3 | Contract | Duplicate notification ID | Medium | ✅ Yes | `has()` check before write; all-or-nothing batch |
| T-C4 | Contract | Batch bomb (resource exhaustion) | Medium | ✅ Yes | `MAX_BATCH_SIZE = 50` enforced |
| T-C5 | Contract | Notification TTL manipulation | Medium | ✅ Yes | Zero TTL and overflow rejected; max lifetime cap |
| T-C6 | Contract | Payment token substitution | High | ✅ Yes | Admin-controlled token allowlist |
| T-C7 | Contract | Member percentage manipulation | Medium | ✅ Yes | Sum-to-100, no-duplicate, non-empty validation |
| T-C8 | Contract | Audit log false entry injection | High | ❌ Open | Anyone can append records; see R1 |
| T-C9 | Contract | Unauthorized notification state change | High | ✅ Yes | Creator/admin check on revoke/recall/deliver |
| T-C10 | Contract | Pause griefing | High | ✅ Yes | Admin-only; observable via event |
| T-L1 | Listener | API key brute force / timing oracle | High | ✅ Yes | Timing-safe comparison; rate limiting |
| T-L2 | Listener | Unauthenticated production API | High | ⚠️ Partial | No hard failure on empty `API_KEYS`; see R3 |
| T-L3 | Listener | DoS via oversized request | Medium | ✅ Yes | 1 MiB body limit; socket destroyed on reject |
| T-L4 | Listener | DoS via request flooding | Medium | ✅ Yes | Rate limiter with per-client windows |
| T-L5 | Listener | CSRF | Low | ✅ Yes | CORS + custom header preflight requirement |
| T-L6 | Listener | Clickjacking | Low | ✅ Yes | `X-Frame-Options: SAMEORIGIN` |
| T-L7 | Listener | Ledger reorg replay | Medium | ✅ Yes | Two-layer deduplication; reorg detection |
| T-L8 | Listener | RPC endpoint substitution | Medium | ⚠️ Partial | Passphrase validation; contract address filtering |
| T-L9 | Listener | DNS rebinding | Medium | ✅ Yes | `dns-rebinding-guard` middleware |
| T-L10 | Listener | Webhook delivery replay | Low | ✅ Yes | Replay cache; consumers must also check |
| T-D1 | Database | SQL injection | High | ✅ Yes | Parameterized queries throughout |
| T-D2 | Database | Direct unauthorized DB access | High | ⚠️ Partial | No application exposure; host config required |
| T-D3 | Database | Storage exhaustion | Medium | ✅ Yes | Cleanup scheduler with configurable retention |
| T-DH1 | Dashboard | Secret exposure via browser | Medium | ✅ Yes | Dashboard holds no secrets |
| T-DH2 | Dashboard | MIME type confusion | Low | ✅ Yes | `nosniff` header; explicit content types |
| T-DH3 | Dashboard / Frontend | Malicious wallet transaction | Medium | ⚠️ Partial | Wallet confirmation plus on-chain auth; UI is not authoritative |
| T-DH4 | Dashboard / Frontend | Build dependency compromise | Medium | ⚠️ Partial | Lockfiles and CI checks; runtime artifact signing not assumed |
| T-W1 | Webhooks | SSRF via target URL | Medium | ❌ Open | No outbound URL allowlist; see R2 |
| T-W2 | Webhooks | Webhook target impersonation | Medium | ✅ Yes | TLS enforcement; HMAC signing |
| T-W3 | Webhooks | Secret leakage via logs | Low | ✅ Yes | Key masking in log output |
| T-S1 | Config | Secrets in environment variables | Medium | ⚠️ Partial | `.gitignore` enforced; use secrets manager in prod |
| T-S2 | Config | Schema/network version mismatch | Low | ✅ Yes | Passphrase validation; schema version check |
| T-P1 | CI/CD | Workflow or action compromise | High | ⚠️ Partial | Protected branches and least privilege required; see R9 |
| T-P2 | TaskBounty | Unauthorized escrow or payout action | High | ✅ Contract-specific | Authorization and state transitions must be rechecked against the deployed implementation |

---

## 9. Review and Maintenance

The threat model is reviewed:

- With every new contract, Listener endpoint, database table, outbound provider,
  deployment target, or browser feature.
- Before production releases and network migrations.
- When an environment variable or credential scope changes.
- After a security incident, dependency compromise, or disclosed vulnerability.
- At least quarterly for maintained deployments.

When a component or boundary changes, update Sections 2–5, the external
dependency table, the open-risk list, and the summary table in the same change.
Security-sensitive pull requests should include a short threat delta:

1. Which assets or trust boundaries change.
2. Which STRIDE category or existing threat ID is affected.
3. The mitigation added or remaining risk.
4. Tests, monitoring, or deployment checks that verify the control.

This document should be kept alongside
[`ARCHITECTURE_OVERVIEW.md`](ARCHITECTURE_OVERVIEW.md),
[`SYSTEM_ARCHITECTURE.md`](SYSTEM_ARCHITECTURE.md), and
[`ENVIRONMENT_VARIABLES_AND_SECRETS.md`](ENVIRONMENT_VARIABLES_AND_SECRETS.md).

*Last updated: 2026-11-23. Maintained alongside architecture documentation.*
