# 🎚️ Configurable Log Level Specification

This document details the log level configuration policy and fallback rules for NotifyChain (Issue #684).

---

## 1. Supported Log Levels

| Level | Severity | Production Recommended | Description |
|---|---|:---:|---|
| `debug` | Lowest | ❌ | Diagnostic debug traces, payload schemas, and fine-grained loops |
| `info` | Normal | ✅ | Routine operations, batch polling status, and startup notices |
| `warn` | Elevated | ✅ | Degraded endpoints, retry attempts, and fallback notices |
| `error` | High | ✅ | Unhandled exceptions, dead-letter isolations, and fatal events |
| `silent` | None | ❌ | Mutes all log output (used primarily in automated unit tests) |

---

## 2. Configuration & Fallback Rules

Set `LOG_LEVEL` in `.env` or system environment:

```bash
LOG_LEVEL=warn
```

* **Production Fallback**: If unset, defaults to `info`.
* **Development Fallback**: If unset, defaults to `debug`.
* **Invalid Inputs**: Unknown values (e.g. `verbose`) emit a warning and fall back safely to the environment default.
