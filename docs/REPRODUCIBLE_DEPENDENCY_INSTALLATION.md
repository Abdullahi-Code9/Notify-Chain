# 🔒 Reproducible Dependency Installation & Lockfile Policy

This document details NotifyChain's policy for reproducible, deterministic builds and CI dependency verification (Issue #719).

---

## 1. Core Principles

To prevent supply-chain drift, build non-determinism, and upstream package discrepancies, all dependencies must be installed from committed lockfiles using **frozen/locked mode**:

| Component | Language / Toolchain | Committed Lockfile | CI Install Command |
|---|---|---|---|
| **Listener** | Node.js (TypeScript) | `listener/package-lock.json` | `npm ci` |
| **Dashboard** | Node.js (React/Vite) | `dashboard/package-lock.json` | `npm ci` |
| **Smart Contracts** | Rust / Soroban | `contract/Cargo.lock` | `cargo check --locked` |

---

## 2. Preventing Lockfile Drift

* When editing `package.json`, developers must commit the resulting `package-lock.json`.
* CI strictly executes `scripts/check-dependency-locks.sh` on every pull request touching package manifests.
* If a lockfile drifts out-of-sync with its manifest, CI fails with clear remediation instructions.

---

## 3. Local Verification

Verify all repository lockfiles locally:

```bash
./scripts/check-dependency-locks.sh
```
