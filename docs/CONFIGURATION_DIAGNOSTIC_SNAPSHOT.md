# 🔍 Configuration Diagnostic Snapshot Specification

This document details the sanitized configuration diagnostic representation for NotifyChain (Issue #695).

---

## 1. Overview & Security Guarantee

When diagnosing operational failures or inspecting runtime health, operators require visibility into runtime parameters, network endpoints, contract bindings, and enabled feature flags without exposing API keys, private keys, or webhook tokens.

### Security Guarantees:
* **Zero Secret Leakage**: Passwords, private keys (`S...`), and webhook authorization tokens are never included.
* **Redacted Sanitization**: URLs with embedded tokens are masked automatically.

---

## 2. Snapshot Schema

```json
{
  "system": {
    "nodeEnv": "production",
    "nodeVersion": "v20.x",
    "uptimeSeconds": 3600,
    "timestamp": "2026-08-29T12:00:00.000Z"
  },
  "network": {
    "networkPassphrase": "Test SDF Network ; September 2015",
    "rpcUrl": "https://soroban-testnet.stellar.org",
    "pollIntervalMs": 5000
  },
  "contracts": {
    "configuredCount": 2,
    "addresses": ["CA7...", "CB8..."]
  },
  "features": {
    "analyticsEnabled": true,
    "retrySchedulerEnabled": true,
    "cleanupEnabled": true,
    "deadLetterQueueEnabled": true
  },
  "providers": {
    "discordEnabled": true,
    "webhookEnabled": true
  },
  "security": {
    "credentialsRedacted": true,
    "secretsPresent": true
  }
}
```
