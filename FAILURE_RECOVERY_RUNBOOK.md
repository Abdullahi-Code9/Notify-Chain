# Failure Recovery Runbook — NotifyChain

Practical, step-by-step recovery procedures for common NotifyChain production failures.
This runbook is intended for on-call maintainers and operators. For severity classification
and communication templates see [INCIDENT_RESPONSE_RUNBOOK.md](INCIDENT_RESPONSE_RUNBOOK.md).

---

## Table of Contents

1. [Listener Interruption](#1-listener-interruption)
2. [RPC Failures](#2-rpc-failures)
3. [Database Downtime](#3-database-downtime)
4. [Stuck Notification Jobs](#4-stuck-notification-jobs)
5. [Failed Notification Delivery](#5-failed-notification-delivery)
6. [Event Backfill](#6-event-backfill)

---

## 1. Listener Interruption

The listener is the core polling process that ingests Stellar/Soroban contract events and
dispatches notifications. An interruption can be a crash, OOM kill, deliberate restart,
or container eviction.

### 1.1 Detect

| Signal | How to check |
|--------|--------------|
| No `Received events` log lines for > 2× `POLL_INTERVAL_MS` | `grep "Received events" listener.log \| tail -5` |
| Health endpoint not responding | `curl -sf http://localhost:8787/health` |
| Process not running | `ps aux \| grep "node.*index"` or check your process manager |
| Container in `CrashLoopBackOff` | `docker ps -a` / `kubectl get pods` |

### 1.2 Immediate Actions

```bash
# 1. Check the last lines of the listener log for the crash reason
tail -100 listener.log

# 2. Look for OOM or unhandled exception signals
grep -E "(FATAL|uncaughtException|ENOMEM|heap out of memory)" listener.log | tail -20

# 3. Confirm the data directory and database file are intact
ls -lh listener/data/notifications.db
```

### 1.3 Safe Restart Procedure

The listener is designed to resume safely after a restart. The scheduler uses database-backed
locks, and the event deduplication table (`processed_events`) prevents duplicate processing
of already-seen events.

```bash
# Docker Compose
docker compose restart listener

# PM2
pm2 restart notifychain-listener

# Bare Node.js (from the listener directory)
cd listener
npm run start

# Kubernetes
kubectl rollout restart deployment/notifychain-listener
```

After restart, verify recovery within two poll cycles:

```bash
# Should return HTTP 200 with {"status":"ok"} within ~30 s
curl http://localhost:8787/health

# Confirm events are flowing again
tail -f listener.log | grep -E "(Received events|Error polling)"
```

### 1.4 Stale Scheduler Locks After a Crash

If the listener crashed while processing scheduled notifications, rows may be stuck in
`PROCESSING` status with expired locks. The scheduler's stale-lock recovery runs
automatically on the next poll, but you can confirm it is working:

```sql
-- Rows still in PROCESSING with a lock older than SCHEDULER_LOCK_TIMEOUT_MS (default 60 s)
SELECT id, execute_at, retry_count, last_error
FROM scheduled_notifications
WHERE status = 'PROCESSING'
  AND updated_at < datetime('now', '-60 seconds');
```

If rows persist after two poll cycles (check `updated_at`), force recovery manually:

```sql
UPDATE scheduled_notifications
SET status = 'PENDING',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'PROCESSING'
  AND updated_at < datetime('now', '-60 seconds');
```

### 1.5 Prevention

- Set `MAX_RECONNECT_ATTEMPTS` high enough for transient RPC blips (e.g. `10`).
- Configure your process manager to restart automatically on non-zero exit (`restart: always`
  in Docker Compose, `autorestart: true` in PM2).
- Add a liveness probe on `/health` in Kubernetes.

---

## 2. RPC Failures

RPC failures occur when the listener cannot reach the Stellar RPC endpoint or when all
configured contract addresses fail to return events within a poll cycle.

### 2.1 Detect

```bash
# Active reconnection attempts
grep "Attempting to reconnect" listener.log | tail -10

# Service has stopped after exhausting retries
grep "Max reconnection attempts exceeded" listener.log

# Partial failures (one contract failing, others succeeding)
grep "Error fetching events for contract" listener.log | tail -20
```

The backoff schedule with default settings (`RECONNECT_DELAY_MS=5000`,
`MAX_RECONNECT_ATTEMPTS=5`):

| Attempt | Wait before retry |
|---------|-------------------|
| 1 | 5 s |
| 2 | 10 s |
| 3 | 15 s |
| 4 | 20 s |
| 5 | 25 s |
| — | Service stops |

### 2.2 Diagnose

```bash
# 1. Is the RPC endpoint reachable from the listener host?
curl -sf https://soroban-testnet.stellar.org:443 | head -c 200

# 2. Check current STELLAR_RPC_URL value in the running environment
grep STELLAR_RPC_URL listener/.env

# 3. Confirm DNS resolves
nslookup soroban-testnet.stellar.org

# 4. Check for rate-limiting (HTTP 429)
grep "429" listener.log | tail -10

# 5. Test a raw event query against the RPC
curl -s -X POST https://soroban-testnet.stellar.org:443 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getEvents","params":{"startLedger":"1"}}' \
  | head -c 500
```

### 2.3 Recovery Steps

**Scenario A — Transient outage, service still running:**

The listener retries automatically. Monitor logs until you see `Received events` again.
No manual action required unless retries are exhausted.

**Scenario B — Service stopped after max retries:**

```bash
# 1. Verify the RPC is back online
curl -sf https://soroban-testnet.stellar.org:443

# 2. Restart the listener
cd listener && npm run start
# or: docker compose restart listener
```

**Scenario C — Persistent RPC degradation, switch to a fallback:**

```bash
# 1. Update STELLAR_RPC_URL in listener/.env to a backup endpoint
#    Example backup: https://rpc.stellar.org (mainnet) or a private node
vi listener/.env  # change STELLAR_RPC_URL

# 2. Restart the listener to pick up the new URL
npm run start

# 3. Revert once the primary RPC recovers
```

**Scenario D — Partial contract failure (one address keeps erroring):**

```bash
# Validate the failing contract address on the target network
stellar contract invoke \
  --id <FAILING_CONTRACT_ADDRESS> \
  --network testnet \
  -- --help

# If the address is wrong or the contract no longer exists, remove it
# from CONTRACT_ADDRESSES in listener/.env and restart
```

### 2.4 Increase Resilience

```env
# listener/.env — more tolerant settings for flaky RPC nodes
MAX_RECONNECT_ATTEMPTS=10
RECONNECT_DELAY_MS=3000
POLL_INTERVAL_MS=15000
```

---

## 3. Database Downtime

NotifyChain uses SQLite (file-based) for the scheduler and event deduplication store.
Downtime can range from a missing file to a corrupted database.

### 3.1 Detect

```bash
# Common error messages in listener logs
grep -E "(SQLITE_ERROR|database disk image is malformed|no such table|Database not initialized)" \
  listener.log | tail -20
```

### 3.2 Check Database Health

```bash
# Quick integrity check (returns "ok" if healthy)
sqlite3 listener/data/notifications.db "PRAGMA integrity_check;"

# Check file exists and has a non-zero size
ls -lh listener/data/notifications.db

# Verify expected tables exist
sqlite3 listener/data/notifications.db ".tables"
# Expected tables: scheduled_notifications  notification_execution_log
#                  processed_events         polling_cursors
```

### 3.3 Recovery Procedures

**Scenario A — Missing database file (never created or accidentally deleted):**

```bash
# Run migrations to create a fresh database
cd listener
npm run migrate

# Restart the listener
npm run start
```

> Note: A fresh database has no scheduling history. Pending scheduled notifications
> that were only in memory are lost. Review your schedule source and re-queue any
> missed notifications.

**Scenario B — Missing tables (partial migration):**

```bash
# Force a fresh migration
cd listener
NODE_ENV=development npm run migrate

# If migration fails, ensure the data directory exists
mkdir -p listener/data
npm run migrate
```

**Scenario C — Corrupt database (PRAGMA integrity_check returns errors):**

```bash
# 1. Stop the listener immediately to prevent further writes
# 2. Back up the corrupt file
cp listener/data/notifications.db listener/data/notifications.db.corrupt.$(date +%s)

# 3. Attempt SQLite's built-in recovery
sqlite3 listener/data/notifications.db ".recover" | sqlite3 listener/data/notifications_recovered.db
# Verify the recovered DB passes integrity check
sqlite3 listener/data/notifications_recovered.db "PRAGMA integrity_check;"

# 4. If recovery succeeded, swap the file and remigrate if needed
mv listener/data/notifications_recovered.db listener/data/notifications.db
npm run migrate

# 5. Restart the listener
npm run start
```

**Scenario D — Restore from backup:**

```bash
# Stop the listener
# Restore from your last known-good backup
cp /backups/notifications.db.YYYYMMDD listener/data/notifications.db

# Verify integrity
sqlite3 listener/data/notifications.db "PRAGMA integrity_check;"

# Run migrations to apply any schema changes since the backup
cd listener && npm run migrate

# Restart
npm run start
```

### 3.4 Database Maintenance to Prevent Future Issues

```bash
# Weekly: reclaim space from deleted rows
sqlite3 listener/data/notifications.db "VACUUM;"

# Monthly: archive old processed events (> 30 days, non-reorg)
sqlite3 listener/data/notifications.db <<'SQL'
DELETE FROM processed_events
WHERE processed_at < datetime('now', '-30 days')
  AND is_reorg_duplicate = 0;
VACUUM;
SQL

# Verify file size after maintenance
ls -lh listener/data/notifications.db
```

---

## 4. Stuck Notification Jobs

Scheduled notifications can get stuck in `PROCESSING` or remain `PENDING` well past their
`execute_at` time. This section covers diagnosing and unblocking them.

### 4.1 Detect

```bash
# Check for overdue PENDING rows (should have fired by now)
sqlite3 listener/data/notifications.db <<'SQL'
SELECT id, execute_at, retry_count, max_retries, last_error
FROM scheduled_notifications
WHERE status = 'PENDING'
  AND execute_at < datetime('now')
ORDER BY execute_at ASC
LIMIT 20;
SQL

# Check for PROCESSING rows with expired locks
sqlite3 listener/data/notifications.db <<'SQL'
SELECT id, execute_at, retry_count, last_error, updated_at
FROM scheduled_notifications
WHERE status = 'PROCESSING'
  AND updated_at < datetime('now', '-60 seconds')
ORDER BY updated_at ASC
LIMIT 20;
SQL
```

### 4.2 Diagnose the Root Cause

| Symptom | Likely cause |
|---------|-------------|
| Many overdue `PENDING` rows, scheduler not running | `SCHEDULER_ENABLED` is `false` or listener is down |
| `PROCESSING` rows with expired locks | Listener crashed mid-dispatch |
| `PENDING` rows exist but nothing dispatches | `SCHEDULER_POLL_INTERVAL_MS` too high, or worker deadlock |
| Rows rapidly exhaust retries and hit `FAILED` | Permanent delivery error (bad webhook URL, invalid template) |

```bash
# Confirm scheduler is enabled
grep SCHEDULER_ENABLED listener/.env

# Check scheduler poll interval
grep SCHEDULER_POLL_INTERVAL_MS listener/.env

# Look at the last execution log entries for failed jobs
sqlite3 listener/data/notifications.db <<'SQL'
SELECT scheduled_notification_id, execution_attempt, status, error_message, execution_time
FROM notification_execution_log
ORDER BY execution_time DESC
LIMIT 30;
SQL
```

### 4.3 Recovery Steps

**Release stuck PROCESSING locks:**

```bash
sqlite3 listener/data/notifications.db <<'SQL'
UPDATE scheduled_notifications
SET status    = 'PENDING',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'PROCESSING'
  AND updated_at < datetime('now', '-60 seconds');
SQL
```

**Re-enable scheduler if accidentally disabled:**

```bash
# Edit listener/.env
SCHEDULER_ENABLED=true

# Restart the listener
cd listener && npm run start
```

**Manually re-queue a specific stuck notification:**

```bash
# Replace <ID> with the row id from the query above
sqlite3 listener/data/notifications.db <<'SQL'
UPDATE scheduled_notifications
SET status     = 'PENDING',
    retry_count = 0,
    updated_at  = CURRENT_TIMESTAMP
WHERE id = '<ID>';
SQL
```

**Bulk re-queue all FAILED notifications for retry (use with caution):**

```bash
# First review the count
sqlite3 listener/data/notifications.db \
  "SELECT COUNT(*) FROM scheduled_notifications WHERE status = 'FAILED';"

# Re-queue only if the failure reason was transient (e.g. RPC was down)
sqlite3 listener/data/notifications.db <<'SQL'
UPDATE scheduled_notifications
SET status      = 'PENDING',
    retry_count  = 0,
    next_retry_at = CURRENT_TIMESTAMP,
    updated_at   = CURRENT_TIMESTAMP
WHERE status = 'FAILED'
  AND last_error NOT LIKE '%invalid template%'
  AND last_error NOT LIKE '%validation%';
SQL
```

### 4.4 Prevent Future Stalls

- Keep `SCHEDULER_LOCK_TIMEOUT_MS` at or below `60000` ms to ensure prompt lock expiry.
- Configure `SCHEDULER_BATCH_SIZE` to a value the worker can finish within one lock window.
- Set `SCHEDULER_TIMING_BUFFER_MS` to account for clock skew between hosts.

```env
# Balanced scheduler configuration
SCHEDULER_ENABLED=true
SCHEDULER_POLL_INTERVAL_MS=10000
SCHEDULER_LOCK_TIMEOUT_MS=60000
SCHEDULER_BATCH_SIZE=10
SCHEDULER_TIMING_BUFFER_MS=60000
```

---

## 5. Failed Notification Delivery

Delivery failures fall into two categories: Discord webhook errors (fire-and-forget, no
automatic retry) and scheduled notification delivery errors (retried with backoff).

### 5.1 Detect

```bash
# Discord webhook delivery failures
grep "Discord webhook failed" listener.log | tail -20

# Scheduled notification delivery failures with error details
sqlite3 listener/data/notifications.db <<'SQL'
SELECT id, execute_at, retry_count, max_retries, last_error, next_retry_at
FROM scheduled_notifications
WHERE status IN ('FAILED', 'PENDING')
  AND retry_count > 0
ORDER BY execute_at DESC
LIMIT 20;
SQL
```

### 5.2 Discord Webhook Failures

Discord notifications are fire-and-forget. A failure is logged but does not block event
indexing. Events are always stored in `eventRegistry` before any Discord call.

**Step 1 — Confirm the webhook is still valid:**

```bash
# Test the webhook directly
curl -sf -X POST \
  -H "Content-Type: application/json" \
  -d '{"content": "NotifyChain health check"}' \
  "$DISCORD_WEBHOOK_URL"

# Expected: HTTP 204 No Content
# HTTP 404 → webhook was deleted; HTTP 401 → token is wrong
```

**Step 2 — Review the failure details in logs:**

```bash
# Logs include: status, statusText, error body, webhookId
grep "Discord webhook failed" listener.log | tail -20
```

**Step 3 — Fix the configuration:**

```bash
# If the webhook was deleted, create a new one in Discord, then update .env:
vi listener/.env
# DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<new_id>/<new_token>
# DISCORD_WEBHOOK_ID=<new_id>

# Restart the listener
npm run start
```

**Step 4 — Re-send missed Discord notifications:**

Discord delivery is currently fire-and-forget; missed deliveries cannot be automatically
replayed. To re-send:

```bash
# 1. Query the events that should have been notified during the outage window
curl "http://localhost:8787/api/events?since=<ISO_TIMESTAMP>"

# 2. Post them to the webhook manually, or restart the listener so that
#    new incoming events resume delivery.
```

### 5.3 Scheduled Notification Delivery Failures

Scheduled notifications are retried automatically according to the backoff configuration.
Check their current retry state:

```sql
SELECT id, execute_at, retry_count, max_retries, next_retry_at, last_error
FROM scheduled_notifications
WHERE status = 'PENDING'
  AND retry_count > 0
ORDER BY next_retry_at ASC
LIMIT 20;
```

**Permanent failures (hit max_retries):**

```sql
-- Inspect error reasons
SELECT last_error, COUNT(*) AS count
FROM scheduled_notifications
WHERE status = 'FAILED'
GROUP BY last_error
ORDER BY count DESC;
```

Common permanent error causes and fixes:

| Error | Fix |
|-------|-----|
| `invalid template` | Correct or remove the broken template; see [Template System Guide](TEMPLATE_SYSTEM_GUIDE.md) |
| `webhook URL missing` | Set `DISCORD_WEBHOOK_URL` in `.env` and restart |
| `rate limited` | Reduce `SCHEDULER_BATCH_SIZE` or add delivery spacing |
| `network timeout` | Check connectivity; increase `MAX_RECONNECT_ATTEMPTS` |

**Adjust retry backoff if retries are too aggressive:**

```env
# listener/.env
# Retry backoff (ms): delay = baseDelayMs × multiplier^attempt (capped at maxDelayMs)
RETRY_BASE_DELAY_MS=1000
RETRY_MULTIPLIER=2
RETRY_MAX_DELAY_MS=30000
RETRY_JITTER=true
```

---

## 6. Event Backfill

Event backfill is needed when the listener was down or misconfigured and missed a range of
on-chain events that must now be processed retroactively.

### 6.1 When to Backfill

- Listener was offline for an extended period and events were not indexed.
- `CONTRACT_ADDRESSES` was misconfigured and events from a contract were silently skipped.
- The cursor advanced past available ledger history and new ledgers were missed.
- A reorg caused events to be skipped rather than reprocessed.

### 6.2 Determine the Gap

```bash
# 1. Find the last successfully processed event ledger in the database
sqlite3 listener/data/notifications.db <<'SQL'
SELECT contract_address, ledger_number, updated_at
FROM polling_cursors
ORDER BY updated_at DESC;
SQL

# 2. Compare with the current tip ledger from the RPC
curl -s -X POST https://soroban-testnet.stellar.org:443 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":{}}' \
  | grep -o '"sequence":[0-9]*'

# Gap = (current tip ledger) - (last processed ledger)
```

### 6.3 Reset the Cursor for Full Backfill

> **Warning:** Resetting the cursor causes the listener to replay all historical events from
> ledger 1. This will re-trigger notifications for every event ever emitted by the contract.
> Use deduplication records to suppress duplicate Discord messages (see step 6.4).

```bash
# 1. Stop the listener
# 2. Reset the cursor for a specific contract (or all contracts)
sqlite3 listener/data/notifications.db <<'SQL'
UPDATE polling_cursors
SET cursor          = NULL,
    ledger_number   = 0,
    updated_at      = CURRENT_TIMESTAMP
WHERE contract_address = '<CONTRACT_ADDRESS>';
-- Remove the WHERE clause to reset ALL contracts
SQL

# 3. Restart the listener — it will poll from startLedger: 1
npm run start
```

### 6.4 Selective Backfill (Specific Ledger Range)

If you need to backfill only a specific ledger window without replaying everything:

```bash
# Query the RPC directly for events in a specific ledger range
curl -s -X POST https://soroban-testnet.stellar.org:443 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"getEvents",
    "params":{
      "startLedger": "<START_LEDGER>",
      "filters":[{
        "type":"contract",
        "contractIds":["<CONTRACT_ADDRESS>"]
      }],
      "pagination":{"limit":100}
    }
  }' | jq '.result.events'
```

Process the returned events through the listener's Events API or insert them directly into
the `processed_events` table, then dispatch notifications manually.

### 6.5 Mark Already-Processed Events to Avoid Duplicate Notifications

Before starting a backfill, confirm which events are already recorded to prevent duplicate
Discord messages:

```sql
-- Count events already in the deduplication table for the affected contract
SELECT COUNT(*) AS already_processed
FROM processed_events
WHERE contract_address = '<CONTRACT_ADDRESS>'
  AND ledger_number BETWEEN <START_LEDGER> AND <END_LEDGER>;
```

The `EventDeduplicationService` automatically skips events whose `fingerprint`
(`contract_address:event_id`) is already in `processed_events`. No extra action is needed
if the deduplication table is intact.

### 6.6 Verify Backfill Completion

```bash
# 1. Confirm cursor has advanced past the backfill range
sqlite3 listener/data/notifications.db <<'SQL'
SELECT contract_address, ledger_number, updated_at
FROM polling_cursors;
SQL

# 2. Confirm events were stored
curl "http://localhost:8787/api/events" | jq 'length'

# 3. Confirm no new ERROR rows appeared during backfill
sqlite3 listener/data/notifications.db <<'SQL'
SELECT error_reason, COUNT(*) AS count
FROM processed_events
WHERE status = 'ERROR'
  AND processed_at > datetime('now', '-1 hour')
GROUP BY error_reason;
SQL

# 4. Check listener logs are clean
tail -50 listener.log | grep -v "Received events" | grep -iE "(error|warn|fail)"
```

---

## Quick Reference Decision Tree

```
Is the listener process running?
│
├─ NO  → Section 1 (Listener Interruption) — restart the service
│
└─ YES
   │
   ├─ Logs show "reconnect" or RPC errors?
   │   └─ YES → Section 2 (RPC Failures)
   │
   ├─ Logs show SQLITE_ERROR or database errors?
   │   └─ YES → Section 3 (Database Downtime)
   │
   ├─ Scheduled jobs overdue or stuck in PROCESSING?
   │   └─ YES → Section 4 (Stuck Notification Jobs)
   │
   ├─ Notifications not arriving in Discord?
   │   └─ YES → Section 5 (Failed Notification Delivery)
   │
   └─ Events missing from API for a historical period?
       └─ YES → Section 6 (Event Backfill)
```

---

## Related Documentation

| Document | Purpose |
|----------|---------|
| [INCIDENT_RESPONSE_RUNBOOK.md](INCIDENT_RESPONSE_RUNBOOK.md) | Severity levels, roles, communication templates |
| [NOTIFICATION_FAILURE_RECOVERY.md](NOTIFICATION_FAILURE_RECOVERY.md) | Deep-dive on retry lifecycle and architecture |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Local development setup issues |
| [REORG-DEDUPLICATION-MONITORING.md](REORG-DEDUPLICATION-MONITORING.md) | Event deduplication and reorg handling |
| [DEPLOYMENT_PLAYBOOK.md](DEPLOYMENT_PLAYBOOK.md) | Contract deployment and verification |
| [listener/.env.example](listener/.env.example) | Full environment variable reference |
