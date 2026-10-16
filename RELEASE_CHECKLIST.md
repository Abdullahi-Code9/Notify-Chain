# Release Checklist

This document provides a repeatable release checklist to ensure all necessary steps are completed before, during, and after a release. Maintainers should copy this checklist into the release issue or PR for each new release.

## Pre-Release Preparation

### 1. Dependency Updates
- [ ] Review and update out-of-date dependencies (frontend, backend, smart contracts).
- [ ] Check for any security vulnerabilities reported in dependencies (`npm audit`, etc.).
- [ ] Verify licenses of any newly added dependencies.

### 2. Code & Tests Verification
- [ ] Ensure all pull requests intended for this release are merged.
- [ ] Run the full test suite (unit, integration, e2e) and ensure all tests pass.
- [ ] Check test coverage to ensure it has not degraded.
- [ ] Verify that static analysis, linting, and formatting checks pass.

### 3. Migrations & Smart Contracts
- [ ] Review database migrations and ensure they can safely run against production data.
- [ ] Review smart contract upgrades or deployments.
- [ ] Ensure migration and deployment scripts are tested on a testnet or local environment.

### 4. Configuration Changes
- [ ] Document any new or modified environment variables in `ENVIRONMENT_VARIABLES_AND_SECRETS.md`.
- [ ] Ensure sample configuration files (`.env.example`, `docker-compose.yml`) are updated.
- [ ] Review configuration changes for production constraints.

### 5. Documentation
- [ ] Update `CHANGELOG.md` with new features, bug fixes, and breaking changes.
- [ ] Update API documentation, schemas, and API sequence diagrams if changed.
- [ ] Update user-facing documentation and guides for any new features.
- [ ] Review and update deployment guides if deployment processes have changed.

## Deployment Steps

### 1. Staging / Testnet Deployment
- [ ] Deploy the release candidate to the staging environment or testnet.
- [ ] Run database migrations on the staging environment.
- [ ] Verify the application works correctly in staging.

### 2. Production Deployment
- [ ] Take a snapshot/backup of the production database.
- [ ] Deploy smart contracts to mainnet (if applicable) and verify addresses.
- [ ] Apply database migrations to the production environment.
- [ ] Deploy backend and frontend applications to production.

## Deployment Verification (Post-Release)

- [ ] Verify the application is accessible and functioning correctly in production.
- [ ] Perform a health check of critical APIs and endpoints.
- [ ] Verify telemetry, metrics, and error tracking are working (monitor logs for unusual errors).
- [ ] Confirm scheduled tasks and background workers are operating normally.

## Sign-off

- **Release Version:** `vX.Y.Z`
- **Release Date:** `YYYY-MM-DD`
- **Prepared By:** @username
- **Approved By:** @username
