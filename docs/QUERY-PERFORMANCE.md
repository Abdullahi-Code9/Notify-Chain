# Query Performance Regression Tests

## Important queries
| Query | Why it matters |
|---|---|
| events: latest page | Dashboard polls this continuously |
| events: filter by contract | Used by per-contract views |
| events: lookup by id | Hot path for deduplication and ack |
| (add the rest you tested) | |

## Baselines
Measured with 10,000 seeded events, median of 30 runs after 5 warmups (GitHub Codespaces, Node <your version>).

| Query | Baseline median (ms) |
|---|---|
| events: latest page | 0.00 |

## How regressions are detected
`listener/src/__tests__/query-performance.test.ts` re-measures each query and fails if the median exceeds
`max(baseline x tolerance, 2ms)`. Tolerance defaults to 3x to absorb CI/machine variance.
Baselines live in `listener/perf/query-baselines.json`.

## Commands (run in `listener/`)
- `npm run test:perf`: run the regression check
- `npm run perf:baseline`: regenerate baselines after an intentional change (commit the JSON and explain why in the PR)
- `PERF_DATASET_SIZE=50000 npm run test:perf`: stress with a larger dataset