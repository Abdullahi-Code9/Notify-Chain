# 🌐 CORS Configuration & Origin Validation Policy

This document details the Cross-Origin Resource Sharing (CORS) validation and security hardening policies for NotifyChain (Issue #689).

---

## 1. Allowed Origin Configuration

Allowed origins are defined via `CORS_ALLOWED_ORIGINS` as either a comma-separated list or a JSON array:

```bash
# Comma-separated
CORS_ALLOWED_ORIGINS="https://app.notifychain.io, https://dashboard.notifychain.io"

# JSON Array format
CORS_ALLOWED_ORIGINS='["https://app.notifychain.io", "https://dashboard.notifychain.io"]'
```

---

## 2. Production Security Hardening

1. **Explicit Origins Required**: In `NODE_ENV=production`, `CORS_ALLOWED_ORIGINS` must be explicitly configured. Starting a production server without explicit origins throws a startup error.
2. **Wildcard (`*`) Blocked**: The permissive wildcard origin `*` is strictly forbidden in production unless explicitly opted in via `ALLOW_PROD_CORS_WILDCARD=true`.
3. **Origin URL Validation**: Protocols must strictly be `http://` (dev) or `https://` (prod), and origins must not include path suffixes.
