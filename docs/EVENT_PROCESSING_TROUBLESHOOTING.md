# NotifyChain Troubleshooting Guide: Event Processing

A single place to diagnose missing or delayed events, stuck ledger cursors, RPC failures and
database problems in the listener (issue #1251). Each problem lists the log lines to look for,
diagnostic steps, and a recovery procedure. Read the safety warnings before changing anything.

Relevant code: `listener/src/services/event-subscriber.ts` (poll loop, cursors, backfill),
`listener/src/services/event-deduplication-service.ts` (`processed_events`, `polling_cursors`),
`listener/src/services/stellar-rpc-manager.ts` (RPC failover) and `listener/src/config.ts`.

> **Safety first.** The listener keeps its state in SQLite (`DATABASE_PATH`, default
> `./data/notifications.db`). Before editing cursors or deleting rows:
> 1. stop the listener (`SIGTERM`, so it shuts down cleanly);
> 2. back up the database: `sqlite3 "$DATABASE_PATH" ".backup notifications.backup.db"`;
> 3. run only read-only `SELECT` queries until you know what to change.
>
> Moving a cursor **backwards** replays events. Deduplication (`processed_events`) normally
> suppresses repeat notifications, but only for events it has already recorded. Moving a cursor
> **forwards** permanently skips events.

---

## 1. Quick health check

| Check | How | Healthy result |
| --- | --- | --- |
| Service health | `curl -s localhost:${EVENTS_API_PORT:-8787}/health` | HTTP 200 (503 means an error status) |
| Poll loop running | Logs contain `Poll cycle complete` every `POLL_INTERVAL_MS` (default 30 s) | Regular entries |
| Cursor advancing | `SELECT contract_address, ledger_number, updated_at FROM polling_cursors;` | `updated_at` recent, `ledger_number` increasing |
| Events recorded | `SELECT status, COUNT(*) FROM processed_events WHERE processed_at > datetime('now','-1 hour') GROUP BY status;` | Mostly `PROCESSED` |
| Contracts configured | Startup log `Starting event subscriber service`; `CONTRACT_ADDRESSES` | Every contract you expect is listed |

---

## 2. No events at all

**Log lines:** only `Starting event subscriber service`, with no `Received events`; or
`Error polling for events` / `Error fetching events for contract`.

**Diagnose:**

1. Confirm the contract and event filter: each `CONTRACT_ADDRESSES` entry needs the right `address`
   and an `events` list that matches the emitted topics (`["*"]` for all).
2. Check the network: `STELLAR_NETWORK_PASSPHRASE` and `STELLAR_RPC_URL` must point at the network
   the contract is deployed on. A testnet contract polled through a mainnet RPC returns nothing.
3. Check that the cold-start window covers the events: with no stored cursor, the listener begins
   at `max(1, tip − BACKFILL_MAX_LEDGERS)` (default 10 000 ledgers, about 14 h). Older events are
   outside the window (`Backfill safety limit applied: starting historical replay from ledger`).
4. Check that the RPC actually returns events. See `docs/STELLAR_RPC_PROVIDER_GUIDE.md` §6.

**Recover:** fix the configuration and restart. To replay further back on a fresh database, raise
`BACKFILL_MAX_LEDGERS` (or set `0` for unlimited, which can be slow) before the first start.

---

## 3. Events are delayed

**Log lines:** `Poll cycle complete` appears, but with long gaps; repeated
`RPC service rate limit exceeded (HTTP 429 …)`; `Stellar RPC failover triggered`.

**Diagnose:**

- Delay is at least `POLL_INTERVAL_MS` plus processing time. Check the configured value.
- Client-side throttling: with `RPC_RATE_LIMIT_ENABLED=true`, each `getEvents` call waits for a
  token (`RPC_RATE_LIMIT_MAX_REQUESTS_PER_SECOND`, `RPC_RATE_LIMIT_BURST_SIZE`). With many contracts
  and a low rate, cycles take longer.
- Provider throttling (429) and timeouts (`RPC_REQUEST_TIMEOUT_MS`) count as failures and can
  cause failover. Look for `Stellar RPC endpoint cooled down` / `failback` entries.
- Event queue: `EVENT_QUEUE_MAX_CONCURRENCY` (default 1) processes events one at a time. Slow
  delivery providers (Discord retries) add latency. Watch for
  `Discord notification failed, adding to retry queue`.

**Recover:** lower `POLL_INTERVAL_MS` (minimum 1000 ms), raise the RPC rate within the provider's
quota, add `STELLAR_RPC_FALLBACK_URLS`, or raise `EVENT_QUEUE_MAX_CONCURRENCY` if delivery is the
bottleneck.

---

## 4. Some events are missing

Work through the possible causes in order. Each one has its own log line.

| Log line (`warn`) | Meaning | What to check |
| --- | --- | --- |
| `Skipping event: already processed (persistent deduplication)` | The event's `contract_address:event_id` fingerprint is already in `processed_events` | Usually correct (replay or restart). If the first attempt failed to notify, see §7. |
| `Skipping quarantined event` | The event failed validation repeatedly and was quarantined | Inspect the payload; fix the decoder or contract schema. |
| `Skipping malformed event` / `Skipping invalid event payload` / `Skipping event that failed normalization` | Payload didn't match the expected schema | Compare with `EVENT_CATALOG.md`; check the contract version. |
| `Rejecting invalid RPC response, skipping contract` | The RPC returned an unexpected shape for that contract this cycle | Usually transient; persistent → switch provider. |
| `Skipping expired notification` | The notification's TTL had passed before delivery | Expected for expired items; see `NOTIFICATION_EXPIRATION_GUIDE.md`. |
| `Skipping Discord notification: category disabled by user preferences` | Recipient opted out | Expected. |
| `Event processing failed; continuing batch` | One event errored; the rest of the batch continued | `SELECT * FROM processed_events WHERE status='ERROR' ORDER BY processed_at DESC LIMIT 20;` and the `error_reason` column. |

If none of these appear for the missing event, check whether it falls outside the RPC retention
window (§5) or was emitted by a contract or event type not in `CONTRACT_ADDRESSES`.

---

## 5. Ledger cursor problems

The listener stores one cursor per contract in `polling_cursors` (`cursor`, `ledger_number`,
`updated_at`, `reorg_detected`, `reorg_detection_count`). On startup each cursor is restored
(`Checkpoint restored`, then `Checkpoint restore complete`), so polling resumes where it stopped.

| Symptom | Log line | Cause and fix |
| --- | --- | --- |
| Cursor not advancing | No `Poll cycle complete`, or errors every cycle | RPC failing (§6) or the database is read-only or locked (§8). |
| Restart replays from the beginning | `Failed to restore checkpoint for contract; starting from beginning` | The cursor row could not be read. Check DB permissions and integrity (§8). Deduplication prevents duplicate notifications for events already recorded. |
| Old events can't be fetched | `Error fetching events for contract` mentioning start ledger or range | The cursor points before the provider's retention window (often about 7 days). See the recovery below. |
| Reorg warnings | `Potential blockchain reorg detected` | Events at a ledger the cursor had already passed were returned again. They are flagged in `processed_events.is_reorg_duplicate` and counted in `polling_cursors.reorg_detection_count`. Occasional ones are harmless; frequent ones point to an unstable RPC node, so switch provider. |

**Recovery: cursor older than RPC retention.** ⚠️ This skips the events in between.

```bash
# 1. Stop the listener and back up the database (see the safety box at the top).
# 2. Inspect the cursor:
sqlite3 "$DATABASE_PATH" "SELECT contract_address, ledger_number, updated_at FROM polling_cursors;"
# 3. Remove the cursor for the affected contract only. On restart the listener cold-starts at
#    tip − BACKFILL_MAX_LEDGERS for that contract:
sqlite3 "$DATABASE_PATH" "DELETE FROM polling_cursors WHERE contract_address = 'C…';"
# 4. Restart and confirm 'Backfill safety limit applied' and then 'Poll cycle complete'.
```

Record the gap (old `ledger_number` → new start ledger) in your incident notes. Events in it have
to be recovered from another source, such as an archive RPC or Horizon history, if they matter.

---

## 6. RPC connectivity failures

| Log line | Meaning | Action |
| --- | --- | --- |
| `Network connection error: ECONNREFUSED / ENOTFOUND / EAI_AGAIN …` | Cannot reach the endpoint | Check DNS, firewall and proxy; `curl` the URL from the host. |
| `RPC request timed out (…)` | No answer within `RPC_REQUEST_TIMEOUT_MS` | Raise the timeout slightly, or add a fallback. |
| `RPC service rate limit exceeded (HTTP 429 …)` | Provider quota hit | Lower `RPC_RATE_LIMIT_*`, raise `POLL_INTERVAL_MS`. |
| `Stellar RPC node unready/unsynced` | Provider node lagging | Fail over, or wait. |
| `Stellar RPC failover triggered but no fallback endpoints configured` | Single endpoint and it is failing | Add `STELLAR_RPC_FALLBACK_URLS`. |
| `Attempting to reconnect` → `Max reconnection attempts exceeded, stopping service` | The poll loop gave up after `MAX_RECONNECT_ATTEMPTS` (delay grows by `RECONNECT_DELAY_MS` per attempt) | Fix connectivity, then **restart**. Cursors make it resume without loss (within retention). |

Configuration details: `docs/STELLAR_RPC_PROVIDER_GUIDE.md`.

---

## 7. An event was recorded but no notification was sent

```sql
SELECT event_id, ledger_number, status, notification_sent, error_reason, processed_at
FROM processed_events
WHERE contract_address = 'C…' AND ledger_number BETWEEN <from> AND <to>
ORDER BY ledger_number;
```

- `status = 'PROCESSED'`, `notification_sent = 0`: delivery failed or is waiting in the retry
  queue. Check `dead_letter_queue` and the retry logs (`Discord notification failed, adding to
  retry queue`). See `NOTIFICATION_FAILURE_RECOVERY.md`.
- `status = 'ERROR'`: read `error_reason`.

**Replay a single event** through the normal pipeline:

```bash
cd listener && npm run replay-event -- <event_id>
```

The replay uses the same processing path, and deduplication stops it creating duplicate records.
⚠️ Confirm the recipient really did not receive the original notification before replaying it.

---

## 8. Database problems

| Symptom | Diagnose | Recover |
| --- | --- | --- |
| `SQLITE_BUSY` / `database is locked` | Another process (backup, a manual `sqlite3` session) holds a write lock | Close other sessions; only one listener should write to a database file. |
| `SQLITE_READONLY` / `SQLITE_CANTOPEN` | `ls -l "$DATABASE_PATH"` and the directory's permissions; disk full (`df -h`) | Fix ownership and permissions or free disk space, then restart. |
| Suspected corruption | `sqlite3 "$DATABASE_PATH" "PRAGMA integrity_check;"` | Restore the latest backup (`DATABASE_BACKUP_RESTORE.md`). ⚠️ Never edit a corrupt database in place. |
| Schema errors after an upgrade | `cd listener && npm run check-migrations` | `npm run migrate` (and `npm run rollback` if needed). Back up first. |

---

## 9. Collecting information for a bug report

- Listener version (`git rev-parse HEAD`) and Node version.
- Redacted configuration: `STELLAR_NETWORK`, the RPC host names (not keys), `POLL_INTERVAL_MS`,
  `BACKFILL_MAX_LEDGERS` and the `RPC_*` values.
- `SELECT * FROM polling_cursors;`
- 15 minutes of logs around the problem (`LOG_FORMAT=json` is easiest to search).
- The output of `/health` and `/api/status`.

See also: `TROUBLESHOOTING.md` (general), `FAILURE_RECOVERY_RUNBOOK.md`,
`docs/LISTENER-CONFIGURATION.md`, `docs/STELLAR_RPC_PROVIDER_GUIDE.md`.
