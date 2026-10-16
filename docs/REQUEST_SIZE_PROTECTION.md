# 🛡️ API Request Body Size Protection

This document details the request payload size protection middleware for NotifyChain HTTP services (Issue #688).

---

## 1. Motivation & Threat Mitigation

To protect API servers against memory exhaustion attacks, slowloris buffer flooding, and DoS from arbitrarily large JSON payloads, strict size limits are enforced before requests reach downstream controllers.

---

## 2. Protection Mechanics

1. **Header Inspection**: If `Content-Length` exceeds `maxSizeBytes` (default: 1MB / 1,048,576 bytes), the request is rejected immediately with HTTP `413 Payload Too Large` without reading the body.
2. **Streaming Termination**: For chunked transfers without pre-declared lengths, incoming stream data chunks are counted in real-time. If the threshold is passed, the stream is paused, event listeners are cleaned up, and HTTP `413` is returned immediately.

---

## 3. Response Format

```json
{
  "error": "PAYLOAD_TOO_LARGE",
  "message": "Request body exceeds maximum allowed size of 1048576 bytes.",
  "maxSizeBytes": 1048576,
  "declaredSizeBytes": 5242880
}
```
