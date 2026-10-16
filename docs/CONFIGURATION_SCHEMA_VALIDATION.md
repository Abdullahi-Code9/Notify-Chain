# 🛡️ Configuration Schema Validation

This document details the deterministic schema validation engine implemented for NotifyChain application configuration (Issue #694).

---

## 1. Schema Specifications

| Variable | Type | Required | Allowed Values / Bounds | Description |
|---|---|---|---|---|
| `CONTRACT_ADDRESSES` | `JSON Array` | **Yes** | Array of `C...` StrKey addresses | Soroban contracts to monitor |
| `STELLAR_NETWORK` | `Enum` | No | `local`, `testnet`, `mainnet`, `standalone` | Target Stellar network |
| `STELLAR_RPC_URL` | `URL` | No | Valid `http://` or `https://` URL | Soroban RPC endpoint |
| `POLL_INTERVAL_MS` | `Integer` | No | `100 .. 3600000` | Ledger poll cycle interval |
| `LOG_LEVEL` | `Enum` | No | `debug`, `info`, `warn`, `error` | Winston log severity level |
| `PORT` | `Integer` | No | `1 .. 65535` | HTTP server port |

---

## 2. Actionable Error Reporting

Validation errors collect all schema violations simultaneously and pinpoint the exact failing field:

```
ConfigSchemaValidationError: Configuration schema validation failed: [Field: CONTRACT_ADDRESSES] Required environment variable is missing; [Field: STELLAR_NETWORK] Invalid network. Allowed values: local, testnet, mainnet, standalone.
```
