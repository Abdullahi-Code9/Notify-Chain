# 🧹 Automated Stale Configuration Detection

This document specifies the automated stale configuration detection utility for NotifyChain (Issue #722).

---

## 1. Overview

Over time, environment variables change or get deprecated during refactoring. Undetected stale settings in `.env.example` or documentation create confusion for developers and operators.

The scanner `scripts/detect-stale-config.py` automatically compares all variables documented in `.env.example` against actual references across:
- Off-chain Listener service (`listener/src/`)
- Dashboard frontend (`dashboard/src/`)
- Soroban Smart Contracts (`contract/src/`)
- Multi-container orchestration (`docker-compose.yml`)
- Automation scripts (`scripts/`)

---

## 2. Usage

### Local Execution:
```bash
# Run stale config audit
python3 scripts/detect-stale-config.py

# Run in non-failing warn mode
python3 scripts/detect-stale-config.py --warn-only
```

---

## 3. False Positive Handling & Allowlist

Certain variables are intended for external CI/CD runners, third-party webhook integrations, or deployment platform secrets. These are explicitly defined in the script's `ALLOWLIST`:
- `DISCORD_WEBHOOK_URL`, `DISCORD_WEBHOOK_ID`
- `GITHUB_TOKEN`, `NPM_TOKEN`, `CF_API_TOKEN`
- `STELLAR_SECRET_KEY`
