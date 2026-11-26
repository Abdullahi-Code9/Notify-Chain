# Data Recovery and Event Reconciliation Guide

This guide helps operators investigate differences between Stellar/Soroban
events and NotifyChain's local listener state without modifying production
records during diagnosis. It complements the
[failure recovery runbook](FAILURE_RECOVERY_RUNBOOK.md) and
[database backup and restore guide](docs/DATABASE_BACKUP_RESTORE.md).

## 1. Understand which records are durable

The listener stores two different kinds of event state:

- `processed_events` and `polling_cursors` are durable SQLite tables. The
  former records event IDs and processing outcomes; the latter stores the
  opaque RPC cursor and ledger checkpoint per configured contract.
  `processed_events` is not a raw event archive and is subject to retention
  (30 days by default); an older missing row may have expired normally.
- `GET /api/events` and `GET /api/events/history` read the in-process event
  registry, not a complete durable event archive. The registry is bounded
  (10,000 events by default), expires events after 24 hours by default, and is
  rebuilt after a restart.

Consequently, a missing event from the API response is not by itself evidence
that an event was lost. Use RPC history as the source for on-chain event
existence, and use the database tables to inspect listener processing state.
Keep databases and exports separated by Stellar network; the local event
fingerprint does not include a network identifier.

## 2. Identify a possible gap

Record the network, contract address, and suspected ledger interval before
comparing data. Check:

1. Listener health and logs for RPC failures, invalid responses, normalization
   failures, or per-event processing errors.
2. The persisted checkpoint for the affected contract:

   ```sql
   SELECT contract_address, cursor, ledger_number, updated_at
   FROM polling_cursors
   WHERE contract_address = '<CONTRACT_ADDRESS>';
   ```

3. Processed event records and outcomes for the same contract and ledger
   interval:

   ```sql
   SELECT event_id, ledger_number, tx_hash, event_type, status,
          notification_sent, error_reason, is_reorg_duplicate,
          reorg_detection_count
   FROM processed_events
   WHERE contract_address = '<CONTRACT_ADDRESS>'
     AND ledger_number >= <START_LEDGER>
     AND ledger_number < <END_LEDGER>
   ORDER BY ledger_number, event_id;
   ```

Run local database inspection in read-only mode:

```bash
sqlite3 -readonly listener/data/notifications.db
```

Look for ledgers present on RPC but absent from `processed_events`, `ERROR`
outcomes, and an unexpectedly advanced checkpoint. Check the listener's
configured network and contract address as well: comparing the wrong network
or deployment can look like a gap.

## 3. Retrieve historical events from Stellar RPC

Use the RPC `getEvents` method with an inclusive `startLedger`, an exclusive
`endLedger`, and a contract filter. Replace the sample ledger values and
contract address with the affected deployment:

```bash
curl --fail -sS -X POST "$STELLAR_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getEvents",
    "params": {
      "startLedger": 123456,
      "endLedger": 123900,
      "filters": [{
        "type": "contract",
        "contractIds": ["<CONTRACT_ADDRESS>"]
      }],
      "pagination": {"limit": 1000}
    }
  }' > rpc-events.json

jq -e '.error == null and (.result.events | type == "array")' rpc-events.json > /dev/null
```

Keep the returned JSON as an evidence snapshot. To inspect event identity,
ledger, and transaction without decoding the payload:

```bash
jq -r '.result.events[] | [.id, .ledger, .contractId, .txHash] | @tsv' rpc-events.json
```

`getEvents` pages are limited to at most 10,000 events. For additional pages,
use the last returned event's `cursor` as the next request's `cursor`, and omit
`startLedger` and `endLedger` from that request. Since the continued request is
not range-bounded, exclude any returned event whose ledger is at or beyond the
requested exclusive `endLedger`, then stop. The cursor is opaque; do not edit
or calculate it. Check the RPC response's `oldestLedger` and
`latestLedger` (or `getHealth`) before investigating older intervals. RPC
history is bounded by the provider's retention configuration; the stock
default is 120,960 ledgers, but providers may configure a different window.
See Stellar's [`getEvents` reference](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents).

## 4. Compare RPC and local event identities

For a single contract and network, compare the RPC event IDs to the IDs in
`processed_events`. The RPC export above is already filtered by contract and
ledger range:

```bash
jq -r '.result.events[].id' rpc-events.json | sort -u > rpc-event-ids.txt

sqlite3 -readonly listener/data/notifications.db > local-event-ids.txt <<'SQL'
SELECT event_id
FROM processed_events
WHERE contract_address = '<CONTRACT_ADDRESS>'
  AND ledger_number >= <START_LEDGER>
  AND ledger_number < <END_LEDGER>
ORDER BY event_id;
SQL
sort -u -o local-event-ids.txt local-event-ids.txt

# Events returned by RPC that have no matching local processed_events row
comm -23 rpc-event-ids.txt local-event-ids.txt
```

This comparison identifies a potential persistence gap; it does not prove a
notification was delivered or that every event was valid for this listener.
Investigate `status`, `error_reason`, listener logs, and the contract's event
payload before taking action.

## 5. Handle duplicates safely

NotifyChain's persistent deduplication key is the contract address plus the
RPC event ID (`fingerprint`). The RPC documents the event `id` as unique, and
overlapping ledger queries or cursor retries can return an event already seen.
Multiple events may share a transaction hash.

- Deduplicate comparison exports by event ID only after filtering to one
  network and contract.
- Treat a repeated ID as a candidate duplicate, not a second notification to
  dispatch.
- Keep the original `processed_events` row and its outcome. Re-detection is
  tracked by `is_reorg_duplicate` and `reorg_detection_count`.
- Do not delete rows, alter fingerprints, or clear the cursor to "make room"
  for replay. Those changes can discard deduplication evidence or trigger
  repeated side effects.

## 6. Safe recovery procedure

1. Preserve the evidence: record network, contract, ledger interval, RPC URL,
   retrieval time, and the RPC JSON response.
2. Before any database operation that could write, take and verify a SQLite
   backup using the documented
   [backup procedure](docs/DATABASE_BACKUP_RESTORE.md).
3. If the checkpoint is still before the suspected gap and the RPC retains
   the events, keep the configured listener running and monitor its normal
   cursor-based catch-up. Confirm the event IDs and outcomes afterwards.
4. If the checkpoint has passed an event that is absent locally, stop before
   changing the production cursor or writing rows by hand. Preserve the
   comparison and escalate for a reviewed recovery path that reprocesses the
   original RPC event through the normal application logic.
5. After an approved recovery, repeat the read-only comparison and verify
   processing outcomes. Separately verify delivery with the delivery service
   or provider; an on-chain event and a `processed_events` row do not prove
   recipient delivery.

**Current limitation:** the listener does not provide a supported import
command for an RPC event missing from `processed_events`. Its
[`replay-event` script](listener/src/scripts/replay-event.ts) first looks up
an existing database row, so it cannot recover an event whose row is missing;
the normal deduplicator also skips IDs already recorded. Do not treat direct
SQL inserts or manual cursor rewinds as a supported recovery method. The
listener can advance its RPC cursor after attempting a page even when an
individual event fails processing, so a restart alone may not revisit that
event. A code-reviewed recovery implementation is required for that case.

## 7. Recovery limits and escalation

- Events older than the RPC node's `oldestLedger` are unavailable from that
  node. Use an archival RPC/provider if available; otherwise the original
  event may not be recoverable.
- Restoring an older database backup also restores an older cursor and
  deduplication state. Replaying from it can repeat external side effects.
  Follow the backup guide's restore procedure in an isolated environment
  before considering production restoration.
- The in-memory `/api/events` and `/api/events/history` endpoints are bounded
  views, not authoritative historical archives.
- A database row records listener processing status, not proof of on-chain
  finality or recipient delivery.
- Keep raw event snapshots and database backups under the organization's
  retention and access controls. Validate any event-derived operational
  action against the correct network and contract.

Escalate with the network, contract ID, ledger range, checkpoint value, RPC
provider/retention window, relevant event IDs, query output, and listener logs.
Do not include secret keys or RPC credentials in the incident record.
