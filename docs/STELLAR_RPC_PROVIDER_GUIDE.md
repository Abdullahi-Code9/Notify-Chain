# Stellar RPC Integration and Provider Configuration Guide

How the NotifyChain listener connects to Stellar (Soroban) RPC, how to configure one or more
providers, and how to diagnose connectivity and rate-limit problems (issue #1249).

Source of truth: `listener/src/config.ts` (loading and validation),
`listener/src/services/stellar-rpc-manager.ts` (failover) and
`listener/src/services/event-subscriber.ts` (polling and rate limiting). Defaults below are the
values in that code.

---

## 1. What the listener uses RPC for

| Call | When | Notes |
| --- | --- | --- |
| `getEvents` | Every poll cycle (`POLL_INTERVAL_MS`), once per configured contract | Resumes from the stored cursor in `polling_cursors`. |
| `getLatestLedger` | Once on a cold start (no stored cursor) | Used to cap the historical backfill (`BACKFILL_MAX_LEDGERS`). |

Every call goes through `StellarRpcManager.executeWithFallback`, which applies the timeout, the
failover rules and the per-endpoint health tracking described below.

---

## 2. Environment variables

### Required

| Variable | Description | Example |
| --- | --- | --- |
| `CONTRACT_ADDRESSES` | JSON array of contracts to watch. Each entry needs a non-empty `address` and an `events` array of event names (`"*"` for all). Startup fails if it is missing or empty. | `[{"address":"CABC…","events":["TaskCreated","WorkSubmitted"]}]` |

### Provider endpoints

| Variable | Default | Description |
| --- | --- | --- |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org:443` | Primary RPC endpoint. Must be `http://` or `https://`. |
| `STELLAR_RPC_URLS` | — | Comma-separated list. The first entry is the primary when `STELLAR_RPC_URL` is not set; the rest become fallbacks. |
| `STELLAR_RPC_FALLBACK_URLS` | — | Comma-separated fallback endpoints, tried in order. Duplicates and the primary URL are removed. |
| `STELLAR_NETWORK` | `testnet` | Network name used in logs and diagnostics. |
| `STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Must match the network the RPC serves (mainnet: `Public Global Stellar Network ; September 2015`). |

### Failover and timeouts

| Variable | Default | Valid range | Description |
| --- | --- | --- | --- |
| `RPC_REQUEST_TIMEOUT_MS` | `10000` | ≥ 500 | Per-request timeout. A timeout counts as a failure. |
| `RPC_FAILURE_THRESHOLD` | `3` | ≥ 1 | Consecutive failures before an endpoint is marked unhealthy and the listener fails over. |
| `RPC_COOLDOWN_MS` | `60000` | ≥ 0 | How long an unhealthy endpoint is left alone before it is probed again. |
| `RPC_MAX_RETRIES` | number of configured URLs | — | Attempts per call across endpoints. |
| `RPC_FAILBACK_ENABLED` | `true` | `true`/`false` | Return to a higher-priority endpoint once it has recovered. |

### Rate limiting (client side)

| Variable | Default | Valid range | Description |
| --- | --- | --- | --- |
| `RPC_RATE_LIMIT_ENABLED` | `true` | `true`/`false` | Token-bucket limiter in front of every `getEvents` call. |
| `RPC_RATE_LIMIT_MAX_REQUESTS_PER_SECOND` | `10` | ≥ 1 | Sustained request rate. |
| `RPC_RATE_LIMIT_BURST_SIZE` | `20` | ≥ 1 | Requests allowed in a burst before throttling. |
| `RPC_RATE_LIMIT_THROTTLE_DELAY_MS` | `1000` | ≥ 0 | Wait applied when the bucket is empty. |

### Polling and backfill

| Variable | Default | Valid range | Description |
| --- | --- | --- | --- |
| `POLL_INTERVAL_MS` | `30000` | ≥ 1000 | Delay between poll cycles. Lower values raise RPC load linearly. |
| `EVENT_BATCH_SIZE` | `100` | ≥ 1 | Events requested per `getEvents` page. |
| `BACKFILL_MAX_LEDGERS` | `10000` | ≥ 0 (`0` = unlimited) | On a cold start, begin at `max(1, tip − BACKFILL_MAX_LEDGERS)` instead of ledger 1. |
| `MAX_RECONNECT_ATTEMPTS` | `5` | — | Poll-loop reconnect attempts before the subscriber stops. |
| `RECONNECT_DELAY_MS` | `5000` | — | Base reconnect delay, multiplied by the attempt number. |

Invalid values are reported together at startup by `validateConfig`, for example
`RPC_REQUEST_TIMEOUT_MS must be at least 500 ms (received: 100).`

---

## 3. Configuration examples

**Local development (testnet, single public endpoint)**

```dotenv
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
CONTRACT_ADDRESSES=[{"address":"CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX","events":["*"]}]
POLL_INTERVAL_MS=30000
```

**Staging (testnet, primary plus fallback, quicker failover)**

```dotenv
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://rpc.staging-provider.example:443
STELLAR_RPC_FALLBACK_URLS=https://soroban-testnet.stellar.org:443
RPC_FAILURE_THRESHOLD=2
RPC_COOLDOWN_MS=30000
RPC_REQUEST_TIMEOUT_MS=8000
```

**Production (mainnet, paid provider plus two fallbacks, conservative rate)**

```dotenv
STELLAR_NETWORK=mainnet
STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
STELLAR_RPC_URLS=https://mainnet.provider-a.example,https://mainnet.provider-b.example,https://mainnet.provider-c.example
RPC_FAILBACK_ENABLED=true
RPC_RATE_LIMIT_MAX_REQUESTS_PER_SECOND=5
RPC_RATE_LIMIT_BURST_SIZE=10
POLL_INTERVAL_MS=15000
BACKFILL_MAX_LEDGERS=17280   # about 24 h of ledgers on a cold start
```

Keep provider API keys out of committed files. Inject the full URL (including any key) from your
secret store, as described in `ENVIRONMENT_VARIABLES_AND_SECRETS.md`.

---

## 4. Provider requirements

- **Soroban RPC, not Horizon.** The listener calls `getEvents` and `getLatestLedger`, which only
  Soroban RPC servers expose.
- **Event retention.** RPC servers keep events for a limited window (commonly about 7 days on
  public infrastructure). If the listener is down longer than that, events older than the window
  cannot be fetched again. Choose a provider with longer retention, or a self-hosted node, if
  outages can last longer.
- **Matching network.** `STELLAR_NETWORK_PASSPHRASE` must match the endpoint's network.
- **Rate limits.** Size `RPC_RATE_LIMIT_*` below the provider's published quota, leaving headroom
  for one `getEvents` call per contract per poll.

---

## 5. How responses are handled

`isRpcFailureCondition` in `stellar-rpc-manager.ts` decides whether an error counts against the
endpoint's health and can trigger failover:

| Response | Counts as failure? | Log reason |
| --- | --- | --- |
| Timeout (`RPC_REQUEST_TIMEOUT_MS`) | Yes | `RPC request timed out (…)` |
| Network errors (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, …) | Yes | `Network connection error: <code>` |
| HTTP 5xx / `bad gateway` / `service unavailable` | Yes | `HTTP <status> server error from RPC endpoint` |
| HTTP 429 / `rate limit` / `too many requests` | Yes | `RPC service rate limit exceeded (HTTP 429 / Rate Limited)` |
| JSON-RPC server errors (`-32603`, `-32000`…`-32099`) | Yes | `JSON-RPC server error code <n>` |
| Node syncing / behind ledger | Yes | `Stellar RPC node unready/unsynced` |
| JSON-RPC client errors (`-32600`, `-32601`, `-32602`) | No | `Client JSON-RPC error code <n>` (fix the request instead) |

After `RPC_FAILURE_THRESHOLD` consecutive failures the endpoint is marked unhealthy and the next
configured endpoint becomes active (`Stellar RPC failover triggered: switching active endpoint`).
After `RPC_COOLDOWN_MS` the unhealthy endpoint is marked degraded and probed again
(`Stellar RPC endpoint cooled down, marked degraded for probing`). With `RPC_FAILBACK_ENABLED`,
traffic returns to it once it succeeds (`Stellar RPC failback: returning to higher-priority endpoint`).

---

## 6. Troubleshooting connectivity and rate limits

| Symptom / log line | Likely cause | What to do |
| --- | --- | --- |
| Startup error `Missing required environment variable(s): CONTRACT_ADDRESSES` | Variable not set | Set `CONTRACT_ADDRESSES` (see §2). |
| `STELLAR_RPC_URL must use HTTP or HTTPS protocol` / `is not a valid URL` | Typo or missing scheme | Use a full `https://host:port` URL. |
| `Network connection error: ENOTFOUND` | DNS name wrong, or no outbound DNS | `nslookup <host>` from the listener host or container. |
| `Network connection error: ECONNREFUSED` / timeouts | Firewall, proxy, or wrong port | `curl -sS -X POST <url> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'` |
| `RPC service rate limit exceeded (HTTP 429 …)` repeatedly | Quota too low for the poll rate | Lower `RPC_RATE_LIMIT_MAX_REQUESTS_PER_SECOND`, raise `POLL_INTERVAL_MS`, or add a fallback provider. |
| `Stellar RPC failover triggered but no fallback endpoints configured` | Single endpoint and it is failing | Add `STELLAR_RPC_FALLBACK_URLS`. |
| `Stellar RPC node unready/unsynced` | Provider node behind the network | Wait, or fail over to another provider. |
| `Max reconnection attempts exceeded, stopping service` | RPC unreachable for `MAX_RECONNECT_ATTEMPTS` cycles | Fix connectivity, then restart. The cursor in `polling_cursors` makes it resume where it stopped. |
| Events missing after a long outage | Outage longer than the provider's retention | See `docs/EVENT_PROCESSING_TROUBLESHOOTING.md` §5. |

`GET /health` on the events API (`EVENTS_API_PORT`, default `8787`) returns `503` when the service
reports an error status. Use it to confirm recovery after changing the configuration.

See also: `docs/LISTENER-CONFIGURATION.md`, `docs/EVENT_PROCESSING_TROUBLESHOOTING.md`.
