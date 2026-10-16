# Database Backup and Restore

> Recommended backup, verification, and restoration procedures for NotifyChain's persistent data — what must be protected, how to protect it, and how to prove a restore actually works.

---

## Table of Contents

1. [Scope](#scope)
2. [Critical Data Requirements](#critical-data-requirements)
3. [Backup Strategy](#backup-strategy)
4. [Taking a Backup](#taking-a-backup)
5. [Verifying a Backup](#verifying-a-backup)
6. [Restoring from a Backup](#restoring-from-a-backup)
7. [Verified Restore Drill](#verified-restore-drill)
8. [Disaster Recovery Scenarios](#disaster-recovery-scenarios)
9. [Schedule, Retention, and Ownership](#schedule-retention-and-ownership)
10. [Limitations](#limitations)
11. [Operator Checklist](#operator-checklist)

---

## Scope

NotifyChain persists data in three different places. Only one of them is a database you back up.

| Store | Location | Backed up? | Why |
|---|---|---|---|
| **Listener SQLite database** | `DATABASE_PATH` (default `./data/notifications.db`; Docker: `/app/data/notifications.db` on the `listener_data` volume) | **Yes — this guide** | Sole durable copy of queued, failed, and audited notifications |
| **On-chain contract storage** | Stellar ledger (Soroban `persistent` / `instance` entries in `contract/`) | **No** | Replicated by the network; the ledger *is* the backup |
| **Listener in-memory state** | `listener/src/store/event-registry.ts`, preference store, retry queue | **No** | Volatile by design (ring buffer, 24 h TTL); rebuilt on restart |
| **Dashboard browser state** | `localStorage` in each client | **No** | Client-owned; re-populated from the listener API |
| **Secrets and keys** | `.env` files, wallet identities, RPC tokens | **Separate process** | Never place secrets inside a database backup — see [Limitations](#limitations) |

The listener uses an **embedded SQLite database** (see [ADR-0003](adr/0003-sqlite-for-local-persistence.md)): one file, no database server, no external infrastructure. That makes backups simple (copy a file) and makes them entirely your responsibility — there is no managed service snapshotting anything for you.

> **Schema sources:** `listener/src/database/schema.sql` (core), `archive-schema.sql` (archival), `template-schema.sql` (templates). Migrations live in `listener/src/migrations/` and run automatically on container start (`node dist/scripts/migrate-db.js && node dist/index.js`) or via `npm run migrate`.

---

## Critical Data Requirements

### Data classification

Every table in the listener database is assigned a tier. Tiers drive backup frequency and restore priority.

| Tier | Meaning | Tables |
|---|---|---|
| **Tier 1 — irreplaceable** | Cannot be reconstructed from the chain or by any replay. Loss is a business/compliance incident. | `scheduled_notifications` (especially `PENDING` / `PROCESSING` rows), `dead_letter_queue`, `notification_execution_log`, `notification_archive`, `notification_templates`, `notification_template_audit_log`, `idempotency_keys` |
| **Tier 2 — operationally critical** | Re-derivable only by re-polling the chain from an earlier ledger, which risks duplicate notifications and gaps. | `processed_events` (dedup fingerprints, reorg tracking), `polling_cursors` |
| **Tier 3 — telemetry** | Useful for dashboards and tuning; loss has no functional impact. | `rate_limit_events`, `backpressure_events`, `notification_metrics_snapshots`, `template_usage_log` |

**Rationale for Tier 1**

- `scheduled_notifications` rows are created from chain events *once*. If the row is gone and the event is outside the polling window, the notification is never delivered.
- `dead_letter_queue` holds notifications that exhausted retries and require operator action; there is no replay path.
- `notification_execution_log` is the per-attempt delivery audit trail (compliance evidence).
- `notification_archive` is append-only in application code (only `INSERT`, plus time-based retention `DELETE`) and is the surviving copy of a terminal notification once its active row is pruned — so it is only as complete as the backups taken while it was being written.
- `notification_template_audit_log` is explicitly immutable (triggers `RAISE(ABORT, 'Audit records are immutable')`).
- `idempotency_keys` prevents clients from creating duplicate notifications on retries.

**Retention shortens the live copy.** The cleanup and archive jobs continuously delete rows from the live database:

| Data | Live retention (default) | Controlled by |
|---|---|---|
| Terminal notifications (`COMPLETED` / `FAILED` / `CANCELLED`) | 7 days | `NOTIFICATION_RETENTION_MS` |
| Notifications moved to `notification_archive` | 7 days old → archived; archive rows purged after 90 days | `ARCHIVE_AFTER_MS`, `ARCHIVE_DELETE_AFTER_MS` |
| Delivery attempts (`notification_execution_log`) | 7 days after the parent notification is archived/pruned (cascade); 90 days standalone | `EXECUTION_LOG_RETENTION_MS`, `ON DELETE CASCADE` |
| `dead_letter_queue` rows | Deleted with their parent notification row (cascade) | `ON DELETE CASCADE` |
| `processed_events` | 30 days | `PROCESSED_EVENT_RETENTION_MS` |
| `rate_limit_events` | 24 hours | `RATE_LIMIT_EVENT_RETENTION_MS` |
| Metrics snapshots | 30 days | `ANALYTICS_SNAPSHOT_RETENTION_DAYS` |

> **Cascade warning:** `dead_letter_queue` and `notification_execution_log` both have `ON DELETE CASCADE` to `scheduled_notifications`, so archiving or pruning the parent row removes the child rows too, and `notification_archive` does **not** carry attempt history. **Backups are the only durable record of delivery attempts and dead letters older than the retention window.** Take a backup at least daily, and export the DLQ (`sqlite3 notifications.db .dump dead_letter_queue > dlq.sql`) before any retention-triggering deploy or cleanup run.

### Recovery objectives

| Objective | Production target | Local / staging | How it is met |
|---|---|---|---|
| **RPO** (max data loss) | ≤ 1 hour | ≤ 24 hours | Hourly (prod) / daily (staging) hot backup |
| **RTO** (max time to recover) | ≤ 30 minutes | ≤ 15 minutes | Pre-staged restore script + monthly unannounced restore drill |
| **Backup verification** | Every backup, automatically | Before every release | `PRAGMA integrity_check` + `PRAGMA foreign_key_check` + row-count comparison |
| **Restore drill** | Monthly | Before each release | [Verified Restore Drill](#verified-restore-drill) |

### What is *not* recoverable from a database backup

Record these separately — they belong in your deployment manifest, not in the database:

- Deployed contract IDs (`AUTOSHARE_CONTRACT_ID`, TaskBounty), network passphrase, and RPC URL.
- Deployer/admin identities and their secret keys (hardware wallet or secret manager).
- Application secrets: `DISCORD_WEBHOOK_URL`, API keys, HMAC keys (see [`ENVIRONMENT_VARIABLES_AND_SECRETS.md`](../ENVIRONMENT_VARIABLES_AND_SECRETS.md)).
- Any notification already delivered to a recipient — delivery is fire-and-forget and cannot be re-created by a restore.

---

## Backup Strategy

**Principle: 3-2-1.** Keep **3** copies of every backup, on **2** different media, with **1** copy off-site (object storage or an encrypted tarball in a separate region/host). A backup that lives next to the database on the same disk protects against deletion, not against disk loss.

| Situation | Method | Requires listener stopped? | Consistent? |
|---|---|---|---|
| Routine scheduled backup | `sqlite3 .backup` (online backup API) | No | Yes — snapshot taken under concurrent writes |
| Docker Compose deployment | `tar` the `listener_data` volume from a sidecar container | No for a sidecar `.backup`; yes for a raw `tar` | Yes when taken with `.backup`, or while stopped |
| Portable / inspectable backup / partial export | `sqlite3 .dump` | No | Yes (single transaction snapshot) |
| Pre-migration safety copy | File copy of `notifications.db` **plus** `-journal` / `-wal` / `-shm` | **Yes** | Only when no writer is active |
| Full config + data snapshot | Database backup + `.env` (secrets handled separately) + compose file | No | Yes |

**Rules**

1. **Never `cp` a live database.** Under concurrent writes a plain `cp`/`rsync` can capture a torn page set. Use `.backup`, `.dump`, or a filesystem snapshot taken while the process is stopped.
2. **Back up the whole file, not selected tables**, for routine backups — foreign keys (`dead_letter_queue`, `notification_execution_log`, `idempotency_keys` → `scheduled_notifications`) make partial restores easy to get wrong. Use per-table dumps only for targeted exports.
3. **Verify every backup at creation time.** An unverified backup is a hypothesis, not a backup.
4. **Compress and encrypt at rest** (`age`, `gpg`, or your object-store's server-side encryption). Backups contain recipient identifiers, webhook URLs, and notification payloads.
5. **Retain the newest verified backup on the host** so a restore does not depend on network access.

---

## Taking a Backup

### Option A — Host (non-Docker) hot backup

```bash
DB="${DATABASE_PATH:-./data/notifications.db}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BK="backups/notifications-${STAMP}.db"

mkdir -p backups
sqlite3 "$DB" ".backup '$BK'"

# Verify before trusting it (see "Verifying a Backup")
sqlite3 "$BK" 'PRAGMA integrity_check;'          # expect: ok
sqlite3 "$BK" 'PRAGMA foreign_key_check;'        # expect: no rows
gzip -9 "$BK"                                     # compress for retention
```

`.backup` uses SQLite's online backup API: it takes a transactionally consistent snapshot while the listener keeps serving reads and writes, and it follows the database if WAL mode is enabled later.

**Copy-pasteable scheduled backup script** (cron-friendly, verifies before archiving):

```bash
#!/usr/bin/env bash
set -euo pipefail

DB="${DATABASE_PATH:-/app/data/notifications.db}"
RETAIN="${BACKUP_RETAIN_DAYS:-14}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK="$(mktemp -d)"
BK="$WORK/notifications-$STAMP.db"
OUT="${BACKUP_DIR:-/var/backups/notifychain}"

mkdir -p "$OUT"
trap 'rm -rf "$WORK"' EXIT

# 1. consistent snapshot
sqlite3 "$DB" ".backup '$BK'"

# 2. verify — refuse to archive a bad file
[ "$(sqlite3 "$BK" 'PRAGMA integrity_check;')" = "ok" ] || { echo "integrity_check failed" >&2; exit 1; }
[ -z "$(sqlite3 "$BK" 'PRAGMA foreign_key_check;')" ] || { echo "foreign_key_check failed" >&2; exit 1; }

# 3. fingerprint counts for the restore ledger
{
  echo "taken_at=$STAMP"
  sqlite3 -separator ' ' "$BK" \
    "SELECT 'scheduled_notifications', COUNT(*) FROM scheduled_notifications
     UNION ALL SELECT 'dead_letter_queue', COUNT(*) FROM dead_letter_queue
     UNION ALL SELECT 'notification_execution_log', COUNT(*) FROM notification_execution_log
     UNION ALL SELECT 'processed_events', COUNT(*) FROM processed_events
     UNION ALL SELECT 'notification_archive', COUNT(*) FROM notification_archive;"
} > "$BK.meta"

# 4. ship + prune
gzip -9 -c "$BK" > "$OUT/notifications-$STAMP.db.gz"
cp "$BK.meta" "$OUT/notifications-$STAMP.db.gz.meta"
find "$OUT" -name 'notifications-*.db.gz' -mtime "+$RETAIN" -delete
find "$OUT" -name 'notifications-*.db.gz.meta' -mtime "+$RETAIN" -delete

echo "backup ok: $OUT/notifications-$STAMP.db.gz"
```

### Option B — Docker Compose named volume

`docker-compose.yml` maps the named volume `listener_data` to `/app/data`, where `DATABASE_PATH=/app/data/notifications.db`.

**Backup** (sidecar container — the listener keeps running):

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups

# Preferred: snapshot with sqlite3 inside the container, then archive the result.
docker run --rm -v listener_data:/app/data -v "$PWD/backups":/backup alpine \
  sh -c 'apk add --no-cache sqlite >/dev/null && \
         sqlite3 /app/data/notifications.db ".backup /backup/notifications.db" && \
         sqlite3 /backup/notifications.db "PRAGMA integrity_check;" && \
         tar czf /backup/listener_data-'$STAMP'.tar.gz -C /backup notifications.db && \
         rm /backup/notifications.db'

# Simpler alternative: archive the raw volume (take it while the listener is stopped).
docker compose stop listener
docker run --rm -v listener_data:/app/data -v "$PWD/backups":/backup alpine \
  tar czf /backup/listener_data-$STAMP.tar.gz -C /app/data .
docker compose start listener
```

**Verify:**

```bash
mkdir -p /tmp/volcheck && tar xzf "backups/listener_data-$STAMP.tar.gz" -C /tmp/volcheck
sqlite3 /tmp/volcheck/notifications.db 'PRAGMA integrity_check;'
```

### Option C — Logical dump (portable, diff-able, partial exports)

```bash
# full logical backup (schema + data, SQL text)
sqlite3 "$DB" ".dump" > backups/notifications-$STAMP.sql

# single table (e.g. templates only — see TEMPLATE_SYSTEM_GUIDE.md)
sqlite3 "$DB" ".dump notification_templates" > backups/templates-$STAMP.sql

# plain CSV for spreadsheet/audit hand-off
sqlite3 -header -csv "$DB" "SELECT * FROM dead_letter_queue;" > backups/dlq-$STAMP.csv
```

Dumps are the right tool when restoring into a *different* path, reviewing changes in `git diff`, or recovering a single table. They are slower and more fragile than file backups for full restores of large databases — keep both kinds.

### Option D — Cold file copy (only when the listener is stopped)

```bash
docker compose stop listener        # or: systemctl stop notifychain-listener
cp data/notifications.db            "data/notifications.db.bak-$(date +%s)"
cp -a data/notifications.db-journal "data/notifications.db-journal.bak" 2>/dev/null || true
cp -a data/notifications.db-wal     "data/notifications.db-wal.bak"     2>/dev/null || true
cp -a data/notifications.db-shm     "data/notifications.db-shm.bak"     2>/dev/null || true
docker compose start listener
```

If `-wal` / `-shm` sidecars exist (WAL mode) and are omitted while the process is stopped, the newest committed transactions are lost.

### What not to do

| Anti-pattern | Why it fails |
|---|---|
| `cp notifications.db backup.db` while the listener runs | Torn/partially flushed pages; the copy may be unrecoverable |
| Backing up only `notifications.db` while `-wal` / `-journal` exists separately | Committed transactions missing from the backup |
| Storing backups only on the database's own disk | Disk failure destroys data and backups together |
| Restoring without stopping the listener | Two writers on one file → corruption |
| Skipping verification because the file size "looks right" | Corruption is usually invisible until the next write |
| Committing backups or `.env` files to git | `.gitignore` excludes `data/`, `*.db`, `.env*` for a reason — secrets and PII must not land in history |

---

## Verifying a Backup

Run these against the **backup file**, never the live database:

```bash
BK=backups/notifications-20260930T120350Z.db

# 1. structural integrity
sqlite3 "$BK" 'PRAGMA integrity_check;'      # expect exactly: ok

# 2. referential integrity (no rows = pass)
sqlite3 "$BK" 'PRAGMA foreign_key_check;'

# 3. inventory — compare with the .meta ledger written at backup time
sqlite3 -header -column "$BK" "
SELECT 'scheduled_notifications' AS tbl, COUNT(*) AS rows FROM scheduled_notifications
UNION ALL SELECT 'dead_letter_queue',        COUNT(*) FROM dead_letter_queue
UNION ALL SELECT 'notification_execution_log',COUNT(*) FROM notification_execution_log
UNION ALL SELECT 'processed_events',         COUNT(*) FROM processed_events
UNION ALL SELECT 'polling_cursors',          COUNT(*) FROM polling_cursors
UNION ALL SELECT 'notification_templates',   COUNT(*) FROM notification_templates
UNION ALL SELECT 'notification_archive',     COUNT(*) FROM notification_archive;"

# 4. Tier 1 sanity
sqlite3 "$BK" "SELECT COUNT(*) FROM scheduled_notifications WHERE status='PENDING';"
sqlite3 "$BK" "SELECT COUNT(*) FROM dead_letter_queue;"
sqlite3 "$BK" "SELECT contract_address, ledger_number FROM polling_cursors;"

# 5. object inventory
sqlite3 "$BK" ".tables"
# if a `migrations` ledger is present (created by `npm run migrate` / the container CMD),
# confirm the generation you expect:
sqlite3 "$BK" "SELECT id, name FROM migrations ORDER BY id;"
```

**Acceptance:** step 1 returns `ok`, step 2 returns no rows, step 3 matches the `.meta` ledger recorded when the backup was taken, and step 5 shows the expected migration generation and every table you expect.

---

## Restoring from a Backup

### Host restore

```bash
# 1. Stop the writer — non-negotiable
docker compose stop listener       # or stop the systemd/unit process

# 2. Verify the backup you are about to restore
sqlite3 backups/notifications-20260930T120350Z.db 'PRAGMA integrity_check;'   # ok

# 3. Move the damaged database aside (never delete it — it may be forensically useful)
DB="${DATABASE_PATH:-./data/notifications.db}"
mv "$DB" "$DB.corrupt-$(date -u +%Y%m%dT%H%M%SZ)"
rm -f "$DB-journal" "$DB-wal" "$DB-shm"

# 4. Restore
cp backups/notifications-20260930T120350Z.db "$DB"
chmod 640 "$DB"      # match the listener user's ownership as needed

# 5. Migrations — the container CMD does this automatically; locally:
(cd listener && npm run migrate)

# 6. Start and verify
docker compose up -d listener
curl -sf http://localhost:8787/health
```

### Docker Compose volume restore

```bash
docker compose stop listener

# wipe and repopulate the named volume
docker run --rm -v listener_data:/app/data -v "$PWD/backups":/backup alpine \
  sh -c 'rm -f /app/data/* && tar xzf /backup/listener_data-20260930T120350Z.tar.gz -C /app/data'

docker compose up -d listener      # runs migrations, then starts
curl -sf http://localhost:8787/health
```

### Logical dump restore

```bash
docker compose stop listener
mv data/notifications.db data/notifications.db.bak
sqlite3 data/notifications.db < backups/notifications-20260930T120350Z.sql
docker compose up -d listener
```

### Post-restore verification

```bash
# API-level
curl -sf http://localhost:8787/health
curl -sf http://localhost:8787/api/indexing/health
curl -sf http://localhost:8787/api/notifications/health

# data-level
sqlite3 "$DB" <<'SQL'
PRAGMA integrity_check;
PRAGMA foreign_key_check;
SELECT 'pending',    COUNT(*) FROM scheduled_notifications WHERE status='PENDING';
SELECT 'stale_locks',COUNT(*) FROM scheduled_notifications
  WHERE status='PROCESSING' AND lock_expires_at < datetime('now');
SELECT 'dead_letters',COUNT(*) FROM dead_letter_queue;
SELECT 'cursor', contract_address, ledger_number FROM polling_cursors;
SELECT 'orphan_attempts', COUNT(*) FROM notification_execution_log l
  WHERE NOT EXISTS (SELECT 1 FROM scheduled_notifications s WHERE s.id = l.scheduled_notification_id);
SQL
```

**Post-restore expectations**

| Check | Expected |
|---|---|
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | no rows |
| `stale_locks` | `0` — otherwise clear them so the scheduler can re-claim (`status='PROCESSING'` rows with expired `lock_expires_at`) |
| `orphan_attempts` | `0` (orphans indicate a partial or hand-merged restore) |
| Pending notifications | Non-zero for a normal system; matches the pre-incident count |
| `/health` | `200` with `status: "ok"` |

> **After a Tier 2 loss** (missing `processed_events` / `polling_cursors`): do **not** simply reset the cursor to `0`. Rewind it to a known-safe earlier ledger and replay — dedup fingerprints must be rebuilt before reopening the API, otherwise subscribers can receive duplicates. See [`REORG-DEDUPLICATION-MONITORING.md`](../REORG-DEDUPLICATION-MONITORING.md) and [`NOTIFICATION_FAILURE_RECOVERY.md`](../NOTIFICATION_FAILURE_RECOVERY.md).

---

## Verified Restore Drill

The procedure above was executed end-to-end against the repository's real schemas (`listener/src/database/schema.sql` + `archive-schema.sql`) on **SQLite 3.53.2** and **Docker (alpine)**. The transcript below is the acceptance evidence for this guide.

### Drill setup

```bash
sqlite3 data/notifications.db < listener/src/database/schema.sql
sqlite3 data/notifications.db < listener/src/database/archive-schema.sql
# seed 2 notifications, 1 dead letter, 2 delivery attempts, 2 processed events,
# 1 polling cursor, 1 idempotency key, 1 archive row
```

### 1. Hot backup taken while a writer was running

```text
== 2. hot backup while a writer is running (sqlite3 .backup API) ==
backup file: backup/notifications-20260930T120350Z.db (286720 bytes)
-- live rows written during backup: 34
-- backup rows:                     17
```

The background writer kept inserting after the snapshot returned: the backup holds a **point-in-time consistent snapshot** (17 rows), while the live file advanced to 34. No torn state was captured.

### 2. Backup verification

```text
== 3. verify the backup before trusting it ==
integrity_check    : ok
foreign_key_check  : 0 violation(s)
scheduled_notifications        2
dead_letter_queue              1
notification_execution_log     2
processed_events               2
polling_cursors                1
idempotency_keys               1
notification_archive           1
critical_rows=5
RESULT: critical row counts match source -> backup accepted
```

### 3. Simulated corruption of the live database

```text
== 4. simulate corruption of the live database ==
integrity_check after corruption : Error in 2nd command line argument: database disk image is malformed
*** in database main ***
Tree 3 page 3: btreeInitPage() returns error code 11
```

(The live file was overwritten at offset 8192 with 2048 random bytes — the class of damage a crash or failing disk produces.)

### 4. Restore and re-verification

```text
== 5. restore from the backup (listener stopped) ==
integrity_check after restore    : ok
foreign_key_check after restore  : 0 violation(s)
critical_rows=5
RESULT: restored data matches pre-corruption state
1|discord|PENDING
2|email|COMPLETED
```

### 5. Logical dump path

```text
== 6. logical dump/restore path (.dump) ==
dump size: 17936 bytes
integrity_check (from dump)      : ok
critical_rows=5
RESULT: dump restore matches source
tables recreated: 13
```

### 6. Post-restore health checks

```text
== 7. post-restore health checks the listener relies on ==
pending_notifications|1
stale_processor_locks|0
dead_letters|1
cursor|CAAAAA @ ledger 1002

== DRILL PASSED ==
```

### 7. Docker volume backup/restore

```text
== 8. Docker named-volume backup (listener_data -> /app/data) ==
-- taking a volume backup (same command documented in the guide):
archive: -rw-rw-rw 1 root root 8266 .../backups/listener_data.tar.gz
-- restoring the volume from the archive (listener stopped):
integrity_check : ok
pending rows    : 2
processed rows  : 2

== VOLUME DRILL PASSED ==
```

### Reproduce the drill

```bash
#!/usr/bin/env bash
# Restore drill — run before releases and monthly in production-like environments.
set -euo pipefail
WORK=$(mktemp -d); cd "$WORK"; mkdir -p data backup
SCHEMA=/path/to/Notify-Chain/listener/src/database

sqlite3 data/notifications.db < "$SCHEMA/schema.sql"
sqlite3 data/notifications.db < "$SCHEMA/archive-schema.sql"
sqlite3 data/notifications.db "INSERT INTO scheduled_notifications (payload,notification_type,target_recipient,execute_at,status) VALUES ('{\"t\":\"drill\"}','email','drill@example.com','2026-10-01 09:00:00','PENDING');"
sqlite3 data/notifications.db "INSERT INTO processed_events (event_id,contract_address,fingerprint,ledger_number,event_type) VALUES ('drill-1','CDRILL','CDRILL:drill-1',1,'contract');"

BEFORE=$(sqlite3 data/notifications.db "SELECT (SELECT COUNT(*) FROM scheduled_notifications)+(SELECT COUNT(*) FROM processed_events);")

sqlite3 data/notifications.db ".backup backup/drill.db"
[ "$(sqlite3 backup/drill.db 'PRAGMA integrity_check;')" = ok ] || { echo FAIL-integrity; exit 1; }
[ -z "$(sqlite3 backup/drill.db 'PRAGMA foreign_key_check;')" ] || { echo FAIL-fk; exit 1; }

dd if=/dev/urandom of=data/notifications.db bs=1 seek=8192 count=2048 conv=notrunc status=none
mv data/notifications.db data/notifications.db.corrupt
cp backup/drill.db data/notifications.db

AFTER=$(sqlite3 data/notifications.db "SELECT (SELECT COUNT(*) FROM scheduled_notifications)+(SELECT COUNT(*) FROM processed_events);")
[ "$BEFORE" = "$AFTER" ] || { echo "FAIL-counts $BEFORE != $AFTER"; exit 1; }
echo "RESTORE DRILL PASSED ($AFTER critical rows)"
```

---

## Disaster Recovery Scenarios

| Scenario | Detect | Response | Data outcome |
|---|---|---|---|
| **Database corruption** (crash, bad disk) | `PRAGMA integrity_check` ≠ `ok`; logs show `SQLITE_CORRUPT`; API `/health` → 500 | Stop listener → restore newest verified backup → run migrations → verify → restart | Loss limited to RPO window |
| **Accidental row/table deletion** | Cleanup job logs; missing pending notifications | Stop writes → restore from the backup taken *before* the deletion → re-check DLQ | Loss limited to backup interval |
| **Lost `listener_data` volume / disk failure** | Volume missing at start; `ENOENT` on `DATABASE_PATH` | Recreate volume → restore archive → `docker compose up -d` (runs migrations) | Loss limited to RPO window |
| **Bad migration or deploy** | Listener fails after upgrade; migration errors on start | Roll back deploy → restore the pre-migration backup → redeploy with the fix | None if the pre-migration backup was verified |
| **Total environment loss** (region/host) | Everything unreachable | Provision new host → restore off-site backup → restore `.env` from the secret manager → deploy → verify | Loss limited to RPO window |
| **Backup file is bad** | Verification fails at restore time | Fall back to the previous backup generation; keep `.corrupt` files for analysis | Use the next-newest good backup |
| **Tier 2 tables lost, no backup** | Cursor/fingerprint tables empty | Re-poll from a safe earlier ledger, rebuild dedup state **before** reopening the API, suppress duplicate deliveries | Possible duplicates; no Tier 1 loss |

**Never restore Tier 1 without a plan for Tier 2.** Restoring a day-old database with a *newer* chain cursor means the listener will skip events created after the snapshot; restoring an *older* cursor with newer dedup rows means reprocessing. Restore database + cursor together from a single backup generation.

---

## Schedule, Retention, and Ownership

| Trigger | Frequency | Method | Owner |
|---|---|---|---|
| Scheduled backup (production) | Hourly | `.backup` + verify + `gzip` + off-site sync | Platform / on-call |
| Scheduled backup (staging) | Daily 02:00 UTC | `.backup` + verify | Platform |
| Pre-deploy | Before every deploy | File/volume snapshot | Deploying engineer |
| Pre-migration | Before `npm run migrate` or a schema-changing release | `.backup` + `.dump` | Release owner |
| Pre-cleanup / retention change | Before raising or lowering retention env vars | `.dump` of Tier 1 tables | Release owner |
| Restore drill | Monthly (and before each release) | [Verified Restore Drill](#verified-restore-drill) | Release owner |
| Off-site replication | Every backup | `rsync`/object storage with server-side encryption | Platform |
| Backup retention | 7 daily · 4 weekly · 12 monthly | Prune script (`BACKUP_RETAIN_DAYS`) | Platform |

Every backup directory should contain the database archive **and** its `.meta` ledger (timestamp + row counts) so restores can be matched to a point in time.

---

## Limitations

- **Single-file database.** There is no replica; the only redundancy is your backup pipeline.
- **Snapshot granularity.** Cursors and dedup fingerprints live in the same file as the notifications, so one `.backup` captures a consistent generation — but never mix a database from one generation with `.env`, contract IDs, or configuration from another.
- **In-memory state is not captured.** In-flight retry queue entries, the dashboard's 10,000-event ring buffer, and preference caches are rebuilt after restart; recent dashboard activity may appear to "rewind" after a restore.
- **Deliveries are not replayable.** A restore cannot re-send notifications that were already delivered; it only restores what was still pending or failed at snapshot time.
- **Retention deletes are permanent.** Rows purged by cleanup/archive jobs exist only in backups taken beforehand.
- **Secrets are out of scope.** Back up `.env` material through your secret manager only; never inside the database archive.
- **On-chain state is out of scope.** Contract storage lives on the Stellar ledger. Keep a deployment manifest (contract IDs, admin addresses, network passphrase) alongside your backups instead.
- **Tooling requirement.** Every host that restores must have a `sqlite3` CLI installed — add it to your base image or run the container commands shown above.
- **Encryption.** Encrypt off-site archives (`gpg -c`, `age`, or object-store SSE). Backups contain recipient identifiers and payload content.

---

## Operator Checklist

**Before you need a backup**

- [ ] `DATABASE_PATH` points at the file/volume you think it does
- [ ] Scheduled backup job is green; `.meta` files are current
- [ ] At least one copy exists off the host, encrypted
- [ ] A restore drill passed within the last 30 days
- [ ] Deployment manifest (contract IDs, admins, network) stored with the backups

**Restoring**

- [ ] Listener stopped; no writer attached to the file
- [ ] Backup passes `integrity_check` + `foreign_key_check`
- [ ] Old database moved aside, not deleted
- [ ] Migrations run (`npm run migrate` or container CMD)
- [ ] `/health`, `/api/indexing/health`, `/api/notifications/health` return healthy
- [ ] Pending counts, dead letters, and cursor match the expected generation
- [ ] No stale `PROCESSING` locks; no orphan execution-log rows
- [ ] Incident/timeline notes updated (see [`INCIDENT_RESPONSE_RUNBOOK.md`](../INCIDENT_RESPONSE_RUNBOOK.md))

---

## Related Documentation

> - Local persistence decision → [`docs/adr/0003-sqlite-for-local-persistence.md`](adr/0003-sqlite-for-local-persistence.md)
> - Query performance and index inventory → [`docs/DATABASE_QUERY_PERFORMANCE.md`](DATABASE_QUERY_PERFORMANCE.md)
> - Notification processing flow and failure/retry stages → [`docs/NOTIFICATION-FLOW.md`](NOTIFICATION-FLOW.md)
> - Failure recovery and replay guidance → [`NOTIFICATION_FAILURE_RECOVERY.md`](../NOTIFICATION_FAILURE_RECOVERY.md)
> - Reorg/dedup monitoring (cursor safety) → [`REORG-DEDUPLICATION-MONITORING.md`](../REORG-DEDUPLICATION-MONITORING.md)
> - Archival lifecycle and retention env vars → [`listener/NOTIFICATION_ARCHIVING.md`](../listener/NOTIFICATION_ARCHIVING.md)
> - Template backup (single-table export) → [`TEMPLATE_SYSTEM_GUIDE.md`](../TEMPLATE_SYSTEM_GUIDE.md)
> - Deployment and health checks → [`DEPLOYMENT_GUIDE.md`](../DEPLOYMENT_GUIDE.md)
> - Database troubleshooting → [`DEPLOYMENT_TROUBLESHOOTING.md`](../DEPLOYMENT_TROUBLESHOOTING.md)
> - Secrets handling → [`ENVIRONMENT_VARIABLES_AND_SECRETS.md`](../ENVIRONMENT_VARIABLES_AND_SECRETS.md)
> - Incident severity, roles, and timeline → [`INCIDENT_RESPONSE_RUNBOOK.md`](../INCIDENT_RESPONSE_RUNBOOK.md)
> - Environment variables reference → [`docs/LISTENER-CONFIGURATION.md`](LISTENER-CONFIGURATION.md)
