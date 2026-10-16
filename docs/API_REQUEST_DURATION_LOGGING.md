# ⏱️ API Request Duration & Latency Logging

This document details the high-precision request duration and structured access logging middleware for NotifyChain (Issue #687).

---

## 1. Overview & Low Overhead

To detect slow queries, database latency regressions, and network bottlenecks without introducing latency overhead, the request duration logger records high-resolution monotonic timestamps (`process.hrtime.bigint()`) on request entry and computes elapsed time when response streaming finishes (`res.on('finish')`).

---

## 2. Structured Log Schema

```json
{
  "level": "info",
  "message": "HTTP GET /api/v1/health 200 - 1.45ms",
  "method": "GET",
  "path": "/api/v1/health",
  "statusCode": 200,
  "durationMs": 1.45,
  "requestId": "req-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "ip": "127.0.0.1",
  "contentLength": 128
}
```

---

## 3. Redaction & Privacy

Query parameters containing secrets or private tokens (e.g. `?token=S...`) are automatically sanitized using `redactString` before emission to log transports.
