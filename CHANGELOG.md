## Unreleased

- Add version-checked modification for pending scheduled notifications.
- Add configurable overdue schedule recovery policies: execute, expire, or require operator intervention.
- Add explicit contract event schema versioning (`get_event_schema_version`, `_v<N>` event names) and listener version handling (#1122). See `docs/EVENT_SCHEMA_VERSIONING.md`.
- Add database-level event integrity constraints, migration 008 and serialised/nested (savepoint) transactions (#1121).
- Add per-stage event processing latency breakdown and `GET /api/internal/diagnostics/event-latency` (#1120).
- Add `Idempotency-Key` support to schedule cancellation and webhooks, with TTL-based key reuse (#1114). See `listener/docs/API_IDEMPOTENCY.md`.

# Changelog

All notable changes to this project are documented here.
This log is auto-generated from [Conventional Commits](https://www.conventionalcommits.org/).

<!-- semantic-release will prepend new release sections above this line -->

## [Unreleased]

### Added

- Add recurring notification schedules with UTC recurrence rules and a configurable maximum scheduling horizon.
