# 📊 Structured JSON Logging Configuration

This document details the machine-readable JSON logging format supported across NotifyChain (Issue #685).

---

## 1. Enabling Structured JSON Logging

Structured JSON logging can be activated via environment variables:

```bash
# Enable explicitly
STRUCTURED_LOGGING=true

# Alternative format selector
LOG_FORMAT=json
```

*(Note: Structured JSON format is automatically active by default in `NODE_ENV=production`)*.

---

## 2. Standard JSON Schema

Each log record is emitted as a single newline-delimited JSON (NDJSON) string:

```json
{
  "timestamp": "2026-08-29T12:00:00.000Z",
  "level": "info",
  "message": "Notification dispatched to Discord endpoint",
  "service": "notify-chain",
  "environment": "production",
  "requestId": "req-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "durationMs": 45.2,
  "provider": "Discord",
  "notificationId": "notif-12345"
}
```

---

## 3. Redaction & Invariant Security

All metadata fields and nested error structures are continuously filtered through the centralized redaction engine (`listener/src/utils/redact.ts`) before serialization, ensuring private keys, webhook tokens, and credentials are never ingested into log aggregators.
