# `load-test.config.json` schema

Human-readable reference for the config consumed by
[`src/scripts/load-test.ts`](./src/scripts/load-test.ts) (issue #860). Types live
in [`src/utils/load-test-runner.ts`](./src/utils/load-test-runner.ts)
(`LoadTestConfig`, `LoadTestScenario`, `LoadTestThresholds`).

## Top level

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `$schema` | string | no | Point at this document for editor hints |
| `target` | object | no | Defaults for the target server |
| `scenarios` | object[] | **yes** | One or more scenarios to execute |
| `thresholds` | object | **yes** | Pass/fail gates evaluated on every run |

## `target`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `baseUrl` | string | `http://127.0.0.1:3000` | Default base URL for the external CLI when `--url` is omitted |
| `rateLimit` | object | disabled | `RateLimitConfig` applied to the in-process server by the Jest workflow (`enabled`, `windowMs`, `maxRequests`, `clientOverrides`) |

Rate limiting is disabled by default so the workflow measures raw API capacity.
Enable it to load-test the throttling path.

## `scenarios[]`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | **yes** | Stable identifier; the key used to match scenarios across reports |
| `description` | string | no | Human-readable note on which critical path the scenario covers |
| `method` | `GET` \| `POST` \| `PUT` \| `DELETE` | **yes** | HTTP method |
| `path` | string | **yes** | Request path, e.g. `/api/status` |
| `headers` | object | no | Extra request headers |
| `body` | string | no | Already-serialized request body |
| `concurrency` | number | **yes** | In-flight requests during the phase |
| `durationMs` | number | **yes** | Length of the measured phase, in milliseconds |
| `warmupMs` | number | no | Warm-up phase, executed but excluded from the report |
| `maxRequests` | number | no | Hard cap on measured requests (AND-ed with `durationMs`); useful for bounded/CI runs |

## `thresholds`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxErrorRate` | number | **yes** | Maximum tolerated fraction of non-2xx responses (`0.01` = 1%) |
| `maxP95Ms` | number | **yes** | Maximum tolerated p95 latency per scenario, in ms |
| `minThroughputRps` | number | no | Minimum aggregate throughput, in requests/second |

## Example

```json
{
  "$schema": "./load-test.config.schema.md",
  "target": {
    "baseUrl": "http://127.0.0.1:3000",
    "rateLimit": { "enabled": false, "windowMs": 60000, "maxRequests": 1000000, "clientOverrides": {} }
  },
  "scenarios": [
    {
      "name": "status",
      "description": "Liveness/readiness probe used by load balancers.",
      "method": "GET",
      "path": "/api/status",
      "concurrency": 10,
      "durationMs": 3000,
      "warmupMs": 500,
      "maxRequests": 3000
    }
  ],
  "thresholds": { "maxErrorRate": 0.01, "maxP95Ms": 250, "minThroughputRps": 25 }
}
```
