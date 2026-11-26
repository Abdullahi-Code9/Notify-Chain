# Event Integrity Constraints and Processing Latency

Issues: #1121 (database integrity), #1120 (latency breakdown)

## Database-level integrity (#1121)

### Constraints on event tables

| Table                       | Constraint                                                        |
| --------------------------- | ----------------------------------------------------------------- |
| `processed_events`          | `UNIQUE (fingerprint)` (existing)                                 |
| `processed_events`          | `UNIQUE (contract_address, event_id)` via `ux_processed_events_contract_event` |
| `polling_cursors`           | `UNIQUE (contract_address)` (existing)                            |
| `event_processing_timings`  | `FOREIGN KEY (processed_event_id) → processed_events(id) ON DELETE CASCADE`, `UNIQUE (processed_event_id)`, non-negative `CHECK`s |
| `api_idempotency_keys`      | `UNIQUE (scope, idempotency_key)`; completed rows must carry a response |

Foreign keys are enforced: the connection always runs
`PRAGMA foreign_keys = ON`.

### Migration safety

* **New databases** get every object from `schema.sql`.
* **Existing databases:** `schema.sql` creates the new tables
  (`IF NOT EXISTS`). The `processed_events` unique index is applied by
  `Database.applyEventIntegrityConstraints()`, which first audits for
  duplicate `(contract_address, event_id)` rows. A clean table gets the
  constraint. A table with legacy duplicates keeps every row and logs an
  error, so startup is never blocked and no data is deleted.
* **Migration 008** (`008-event-integrity-constraints.ts`) applies the same
  objects through the migration runner. It is additive only (no table rebuild,
  no row changes), runs inside a transaction, is idempotent, and **aborts**
  with a count if duplicates exist. To resolve duplicates, keep one row per
  `(contract_address, event_id)` and re-run. `down` removes only the objects
  008 created.

### Transaction boundaries

`Database.transaction(callback)`:

* commits all writes in `callback`, or rolls all of them back and rethrows;
* **serialises** top-level transactions. All callers share one SQLite
  connection, so overlapping `BEGIN`s used to fail with "cannot start a
  transaction within a transaction";
* turns a nested `transaction()` call into a **SAVEPOINT**. A failing inner
  step rolls back only its own writes, and if the outer callback does not
  catch the error, the whole unit rolls back;
* returns the callback's result.

Event persistence uses single atomic statements wherever possible:
`claimEvent`, `completeEvent` (now one upsert instead of an UPDATE followed by
a separate INSERT), `recordRedetection` and `recordStageTimings`.

## Event processing latency breakdown (#1120)

Each processed event gets four independently measured stages:

| Stage              | What is timed                                                            |
| ------------------ | ------------------------------------------------------------------------ |
| `retrieval`        | RPC `getEvents` call for the event's batch (attributed to each event)     |
| `decodeValidation` | Pre-filter validation, normalization/decoding, schema-version and provenance checks |
| `persistence`      | Deduplication lookup, registry write and the final `processed_events` upsert |
| `notificationPrep` | Preference checks, building/sending the notification, retry-queue hand-off |

### Where timings live

* **In memory:** a bounded store of the last 500 records (`eventLatencyStore`)
  that is always populated.
* **Persisted:** `event_processing_timings`, one row per `processed_events`
  record (written when the deduplication service is configured and the run is
  not a dry run).

### Missing timings

A stage that never started or ended (an early skip, a duplicate, an
exception) is reported as `null` and listed in `missingStages`. Recording runs
in a `finally` block, never throws, and never changes the processing result.

### Diagnostics endpoint

```http
GET /api/internal/diagnostics/event-latency?limit=50
GET /api/internal/diagnostics/event-latency?eventId=<id>&contractAddress=<addr>
X-API-Key: <key>
```

* Requires an API key when API keys are configured.
* Returns `summary` (count, missing, avg, p50, p95, max per stage) and recent
  `records`. A lookup by `eventId` falls back to persisted timings when
  `contractAddress` is given.
* Responses contain only event id, contract address, outcome, timestamps and
  durations. Topics, values and other event payload data are never included.
  `Cache-Control: no-store` is set.
