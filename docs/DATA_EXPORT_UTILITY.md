# Data Export Utility (#850)

The Data Export Utility is an administrative utility for querying, extracting, and exporting selected notification and event records from NotifyChain for debugging, migration, compliance, and analytical workflows.

## Overview & Acceptance Criteria

- **Filterable records**: Export notifications and blockchain events using granular filters (status, channels, date ranges, contract addresses, recipient identifiers, priorities, pagination).
- **Documented data formats**: Standardized JSON structure with envelope metadata and RFC 4180 compliant CSV formatting.
- **Sensitive data protection**: Built-in redaction engine automatically masks secrets, API keys, webhook signing tokens, passwords, and recipient credentials unless explicit administrative unmasking is permitted.

---

## 1. CLI Usage

The export CLI is located at `src/scripts/export-data.ts` and can be invoked directly with `ts-node` or via `npm run export:data`.

### Commands & Options

```bash
# Basic syntax
npm run export:data -- [options]

# Or with ts-node
ts-node src/scripts/export-data.ts [options]
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--type` | `string` | `'all'` | Records to export: `notifications`, `events`, or `all` |
| `--format` | `string` | `'json'` | Output format: `json` or `csv` |
| `--status` | `string` | - | Filter by status (`PENDING`, `COMPLETED`, `FAILED`, `PROCESSED`) |
| `--channel` | `string` | - | Filter notifications by channel (`discord`, `webhook`, `email`, `sms`) |
| `--recipient` | `string` | - | Filter notifications by recipient match |
| `--contract` | `string` | - | Filter by Stellar contract address |
| `--event-type` | `string` | - | Filter events by event type |
| `--from` | `ISO Date` | - | Records created/processed on or after this timestamp |
| `--to` | `ISO Date` | - | Records created/processed on or before this timestamp |
| `--limit` | `number` | `1000` | Maximum records per category (1-10,000) |
| `--offset` | `number` | `0` | Pagination offset |
| `--output` | `path` | stdout | File destination path |
| `--include-sensitive` | `boolean` | `false` | Disable redaction and export raw credentials |
| `--db-path` | `path` | `DATABASE_PATH` | Path to SQLite database |

### CLI Examples

```bash
# 1. Export all failed notifications to a JSON file for debugging
npm run export:data -- --type notifications --status FAILED --output failed-notifications.json

# 2. Export discord notifications as CSV
npm run export:data -- --type notifications --channel discord --format csv --output discord-notifications.csv

# 3. Export processed events for a specific contract over a date range
npm run export:data -- --type events --contract CDNJ3YJ5F4U5... --from 2026-08-01T00:00:00Z --to 2026-08-31T23:59:59Z --output events-august.json

# 4. Export all records with sensitive values unmasked (for offline airgapped migration)
npm run export:data -- --type all --include-sensitive --output migration-full-backup.json
```

---

## 2. Administrative REST API Endpoint

The listener exposes an administrative export endpoint:

```http
GET /api/admin/export
```

### Request Headers

- `X-API-Key` *(optional/required when API keys are configured)*: Admin API key.
- `Accept`: `application/json` or `text/csv`.

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | string | `all` | `notifications`, `events`, or `all` |
| `format` | string | `json` | `json` or `csv` |
| `status` | string | - | Filter by record status |
| `notificationType` | string | - | Filter notifications by channel/type |
| `targetRecipient` | string | - | Filter notifications by recipient substring |
| `contractAddress` | string | - | Filter by contract address |
| `eventType` | string | - | Filter events by type |
| `fromDate` | string | - | ISO 8601 start timestamp |
| `toDate` | string | - | ISO 8601 end timestamp |
| `limit` | number | `1000` | Max records (up to 10,000) |
| `offset` | number | `0` | Offset for pagination |
| `includeSensitive` | boolean | `false` | Whether to unmask credentials |

---

## 3. Documented Export Formats

### JSON Export Format

When exporting with `format=json`, the output envelope has the following documented structure:

```json
{
  "metadata": {
    "exportedAt": "2026-09-29T18:00:00.000Z",
    "version": "1.0.0",
    "type": "all",
    "format": "json",
    "redacted": true,
    "totalNotifications": 1,
    "totalEvents": 1,
    "filtersApplied": {
      "status": "COMPLETED"
    }
  },
  "notifications": [
    {
      "id": 104,
      "notification_type": "discord",
      "target_recipient": "https://discord.com/api/webhooks/123/[REDACTED]",
      "status": "COMPLETED",
      "execute_at": "2026-08-30T10:00:00.000Z",
      "created_at": "2026-08-30T09:55:00.000Z",
      "updated_at": "2026-08-30T10:00:02.000Z",
      "retry_count": 0,
      "max_retries": 3,
      "priority": 5,
      "event_id": "evt_456",
      "contract_address": "CDNJ3YJ5F4U5YF4O5U6Y7I8U9Y0U1I2O3P4I5U6Y7I8",
      "payload": {
        "message": "Task completed successfully",
        "apiKey": "[REDACTED]"
      },
      "metadata": {
        "source": "cron"
      },
      "last_error": null
    }
  ],
  "events": [
    {
      "id": 52,
      "event_id": "evt_456",
      "contract_address": "CDNJ3YJ5F4U5YF4O5U6Y7I8U9Y0U1I2O3P4I5U6Y7I8",
      "fingerprint": "CDNJ3YJ5F4U5YF4O5U6Y7I8U9Y0U1I2O3P4I5U6Y7I8:evt_456",
      "ledger_number": 128940,
      "tx_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "event_type": "contract",
      "processed_at": "2026-08-30T09:54:55.000Z",
      "status": "PROCESSED",
      "notification_sent": 1,
      "is_reorg_duplicate": 0,
      "reorg_detection_count": 0,
      "last_redetected_at": null,
      "error_reason": null
    }
  ],
  "durationMs": 42
}
```

### CSV Export Format

When exporting with `format=csv`, the columns adhere to RFC 4180 standard escaping:

#### Notification Columns:
- `id`: Unique identifier in database
- `notification_type`: Delivery channel (`discord`, `webhook`, `email`, etc.)
- `target_recipient`: Destination address or redacted URL
- `status`: Execution state (`PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `CANCELLED`)
- `execute_at`: Scheduled target execution time
- `created_at`: Creation timestamp
- `updated_at`: Last modification timestamp
- `retry_count`: Number of retry attempts made
- `max_retries`: Maximum retry ceiling
- `priority`: Priority level (1-10)
- `event_id`: Correlated blockchain event ID (if applicable)
- `contract_address`: Originating Stellar contract address
- `payload`: Sanitized JSON payload
- `metadata`: Sanitized JSON metadata
- `last_error`: Failure reason if failed

#### Event Columns:
- `id`: Internal sequence ID
- `event_id`: Unique blockchain RPC event identifier
- `contract_address`: Emitting contract address
- `ledger_number`: Ledger sequence
- `tx_hash`: Transaction hash
- `event_type`: Event category
- `processed_at`: Ingestion timestamp
- `status`: Ingestion status (`PROCESSED`, `SKIPPED`, `ERROR`)
- `notification_sent`: Boolean (1 or 0)
- `is_reorg_duplicate`: Boolean indicating reorg redetection
- `reorg_detection_count`: Redetection count
- `error_reason`: Ingestion failure details

---

## 4. Sensitive Information Handling

The export utility is secure by default:

1. **Automatic Credential Redaction**: All sensitive key patterns (`password`, `token`, `secret`, `apiKey`, `privateKey`, `authorization`, `whsec`, etc.) inside `payload` and `metadata` are recursively replaced with `"[REDACTED]"`.
2. **Webhook URL Sanitization**: URLs with embedded tokens (such as Discord webhook URLs `/api/webhooks/<id>/<token>`) have their token segments replaced with `[REDACTED]`.
3. **Recipient Masking**: Email addresses in target recipient fields have their local parts masked (e.g. `us***@example.com`).
4. **Explicit Administrative Unmasking**: Raw, unredacted data can only be extracted when the caller provides the explicit `--include-sensitive` CLI flag or `includeSensitive=true` API parameter. When unmasked, a security warning is recorded in the application logs.
