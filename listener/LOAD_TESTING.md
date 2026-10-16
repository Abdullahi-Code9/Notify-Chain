# API Load Testing Workflow

## Overview

`npm run load-test` is a repeatable workflow for measuring the throughput and
latency of NotifyChain's critical API endpoints. It exists so a change can be
measured against the same scenarios, on the same machine, and compared to a
saved baseline instead of relying on anecdotes.

The workflow covers the three things issue #860 asks for:

| Requirement | How it is met |
| --- | --- |
| Test scenarios are documented | [`load-test.config.json`](./load-test.config.json) declares each scenario; [`load-test.config.schema.md`](./load-test.config.schema.md) documents the format |
| RPS and latency are measurable | Every run reports requests/second, p50/p90/p95/p99/max latency, and error rate per scenario and in aggregate |
| Results are comparable across changes | Reports are schema-versioned JSON written to `reports/load/`; runs can be diffed against a saved baseline, and gated in CI |

It complements, rather than replaces, the existing suites:

- `npm run test:load` — unit tests for the measurement core (metric maths,
  threshold gating, baseline comparison). Fast and socket-free.
- `npm run test` — the functional suite, including the rate-limit behaviour
  tests added in issue #852 (`src/api/rate-limit-scenarios.test.ts`).
- `npm run test:stress` / `npm run stress-test` — queue/event-processing stress
  tests, which exercise the internal pipeline rather than HTTP endpoints.

## Two ways to run

| Command | Target | When to use |
| --- | --- | --- |
| `npm run load-test` | In-process `createEventsServer` on an ephemeral port | Local runs and CI, where there is no deployed listener |
| `npm run load-test:external -- --url <baseUrl>` | An already-running listener | Staging/production-like environments |

Both drive the same scenarios, the same measurement core and the same report
format — only the target differs.

> **Why the in-process run is a Jest spec.** The listener's third-party runtime
> dependencies (`@stellar/stellar-sdk`, `node-cache`, `uuid`) are not installed;
> `jest.config.js` maps them to test doubles. Jest is therefore the supported way
> to execute the API in-process, so `npm run load-test` drives
> [`src/__tests__/load-test.workflow.test.ts`](./src/__tests__/load-test.workflow.test.ts)
> with `LOAD_TEST=1`. The spec is skipped in the normal `npm test` run so the
> suite stays fast and side-effect free.

## Quick start

```bash
cd listener

# 1. In-process run of the documented scenarios (CI-friendly, no server needed).
npm run load-test

# 2. Against an already-running listener (e.g. `npm run dev`).
npm run load-test:external -- --url http://127.0.0.1:3000

# 3. Save a baseline, then compare later runs against it.
npm run load-test:external -- --url http://127.0.0.1:3000 --out reports/load/baseline.json
npm run load-test:external -- --url http://127.0.0.1:3000 --baseline reports/load/baseline.json

# 4. Gate a change in CI (non-zero exit on regression).
npm run load-test:external -- --url http://127.0.0.1:3000 --baseline reports/load/baseline.json --fail-on-regression
```

No extra tooling (`k6`, `autocannon`, …) is required, so the workflow runs in the
same environment as the rest of the test suite.

## Scenarios

Scenarios are declared in [`load-test.config.json`](./load-test.config.json) and
cover the endpoints that are hot on the read path:

| Scenario | Endpoint | Why it matters |
| --- | --- | --- |
| `status` | `GET /api/status` | Liveness/readiness probe; hit by every load balancer |
| `events` | `GET /api/events` | Event registry read; the hottest dashboard path |
| `analytics` | `GET /api/analytics` | Analytics snapshot read on every dashboard refresh |
| `rate-limit-metrics` | `GET /api/rate-limit/metrics` | Observability endpoint that must stay fast while clients are throttled |

Add a scenario by appending an entry to the `scenarios` array — see the
[schema doc](./load-test.config.schema.md) for every field. Scenario `name`s are
the keys used to match results across reports, so keep them stable.

## What is measured

For each scenario, and across the whole run:

- **Throughput (RPS)** — completed requests divided by the measured phase wall
  time.
- **Latency** — nearest-rank percentiles (p50, p90, p95, p99) plus min/mean/max.
  Sampled with `process.hrtime.bigint()`, which is monotonic and unaffected by
  wall-clock changes.
- **Error rate** — non-2xx responses divided by total responses. Client (4xx)
  and server (5xx) errors are counted separately, so a `429` from rate limiting
  is not confused with a `500`.
- **Environment** — node version, platform, CPU count and total memory, so a
  report is self-describing when compared later or on another machine.

Each scenario runs a short warm-up phase (excluded from the numbers) before the
measured phase, and scenarios run **sequentially** so they don't contend for the
same event loop or server capacity. Both choices keep runs comparable.

### Thresholds

Thresholds live in the config and are evaluated on every run:

```json
"thresholds": {
  "maxErrorRate": 0.01,
  "maxP95Ms": 250,
  "minThroughputRps": 25
}
```

A breached threshold is listed in the report's `failures` array and the CLI exits
with code `1` (the in-process workflow fails the assertion instead).

## Baseline comparison

A baseline is just a previously written report:

```bash
npm run load-test:external -- --url http://127.0.0.1:3000 --out reports/load/baseline.json
```

Comparing later runs reports, per scenario, the absolute and relative change in
p95 latency, throughput and error rate. A scenario whose p95 grows by more than
the regression tolerance (default 10%) is flagged as a regression. With
`--fail-on-regression` the workflow exits non-zero so it can be used as a gate.

For the in-process workflow, drop the report at
`reports/load/baseline.json`; the spec prints the comparison, and with
`LOAD_TEST_GATE=1` it asserts no regression.

`reports/load/*.json` is git-ignored; commit `reports/load/baseline.json`
explicitly if you want the team to share one reference point.

## CLI reference

```
npm run load-test:external -- [options]

  --config <path>          Scenario/threshold config (default: load-test.config.json)
  --url <baseUrl>          Base URL of the listener to test (default: target.baseUrl)
  --out <path>             Where to write the JSON report (default: reports/load/latest.json)
  --baseline <path>        Compare against a previously saved report
  --fail-on-regression     Exit non-zero when the baseline comparison regresses
  --concurrency <n>        Override concurrency for every scenario
  --duration <ms>          Override durationMs for every scenario
  --quiet                  Only print the report
  --help                   Show this help
```

**Exit codes**

| Code | Meaning |
| --- | --- |
| `0` | Thresholds passed (and, when gating, no baseline regression) |
| `1` | A threshold was breached, or a regression was detected while `--fail-on-regression` is set |
| `2` | The workflow could not run (bad config, bad arguments) |

## Using it in CI

```bash
cd listener
npm ci
npm run load-test                       # in-process, no external dependencies
npm run load-test:external -- --url "$LISTENER_URL" --baseline reports/load/baseline.json --fail-on-regression
```

The in-process run starts the events server on an ephemeral port, so no external
services are needed. Rate limiting is **disabled** in the default config so the
run measures raw API capacity; enable it under `target.rateLimit` to load-test
the throttling path itself (see [RATE-LIMITING-GUIDE.md](./RATE-LIMITING-GUIDE.md)).

Because absolute numbers depend on the machine, treat the baseline comparison as
the signal and absolute thresholds as a coarse sanity check. Run the baseline and
the candidate on the same runner for a meaningful diff.

## Interpreting results

- **Throughput stable, p95 flat** — no measurable regression; ship it.
- **p95 up > 10%, RPS down** — likely a hot-path change; the comparison output
  names the scenario that regressed.
- **Error rate > threshold** — inspect the report's `clientErrors`/`serverErrors`
  split before assuming a regression.

## Follow-ups

- Publish a shared, machine-independent baseline (e.g. from a dedicated CI
  runner) if the team wants absolute gating rather than relative comparison.
- Extend the scenario set to mutating endpoints (`POST /api/webhooks`) with
  authenticated fixtures, which needs request signing (#491) to be wired in.
