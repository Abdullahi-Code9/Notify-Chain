# 🔗 Documentation Link Validation Policy & Workflow

This document describes the automated documentation link checking system implemented for NotifyChain (Issue #720).

---

## 1. Motivation

NotifyChain has a rich documentation tree across smart contracts, listener services, and dashboard components. When files are moved or refactored, relative links in markdown documentation can silently break, degrading contributor experience.

---

## 2. Automated Validation in CI

The workflow [`.github/workflows/doc-link-validation.yml`](../.github/workflows/doc-link-validation.yml) automatically triggers whenever pull requests modify `.md` files or documentation scripts.

### Link Verification Policy:
1. **Internal Relative Links**: Checked against the repository filesystem.
2. **Anchor Links (`#section`)**: Base paths are verified.
3. **External URLs (`http://`, `https://`, `mailto:`)**: Safely ignored by default to prevent flaky CI failures caused by external site downtimes or network rate limits.
4. **Code Blocks**: Fenced code blocks and backtick expressions are stripped to avoid false positive matches on code syntax.

---

## 3. Running Locally

Developers can run the validator locally before submitting a PR:

```bash
# Run standard link check
python3 scripts/check-doc-links.py

# Run in warn-only mode (non-zero exit on warnings suppressed)
python3 scripts/check-doc-links.py --warn-only
```
