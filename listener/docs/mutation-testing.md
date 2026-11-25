# Critical event mutation testing

From `listener`, install the committed dependencies with `npm ci`, then run
`node scripts/mutation/run.cjs` (Node 22.22.0 is the CI reference runtime).
No additional mutation dependencies are needed. The dedicated runner uses the
locked Jest 30 and SWC transformer directly, avoiding a Jest-version-specific
mutation adapter and the repository's legacy ts-jest setup.

The checked-in defect catalog in `scripts/mutation/mutants.cjs` covers:

| Production module | Behaviors mutated |
| --- | --- |
| `services/event-normalization.ts` | Contract whitespace removal, transaction hash preservation, payload version preservation |
| `utils/event-utils.ts` | Empty and wildcard allow-lists, membership decisions, processing versus skipping |
| `services/event-deduplication-service.ts` | Claim acquisition, terminal completion delivery flags, missing-claim insertion, equal-ledger reorg boundary |

The normalization and event-utils unit suites run alongside focused state
transition tests in `src/mutation/critical-events.test.ts`. State tests use a
database double to exercise public service decisions; they do not validate SQL
execution, transaction isolation, or real RPC encoding. Existing integration
tests remain necessary for those properties.

Every invocation first validates that each mutation anchor occurs exactly once
and runs an unmodified baseline. It then injects each defect independently into
a disposable source copy, starts a fresh Jest process with caching disabled,
and restores the copy before the next defect. The working source is never
rewritten. The catalog, dependency lock, UTC environment, serial test execution,
and recorded Node version make the selected experiment reproducible.

`reports/mutation/results.json` contains each mutation and outcome;
`summary.md` lists survivors in the CI job summary. Per-mutation Jest JSON and
console logs are uploaded as a workflow artifact even when the job fails.
Any survivor fails CI. Timeouts, import/syntax errors, empty test runs, failed
baseline runs, and stale anchors fail CI as infrastructure errors; they never
count as killed mutations. The score is killed / (killed + survived), excluding
infrastructure errors. Inspect the assertion failures before adding assertions
for survivors. Document any equivalent mutation explicitly rather than silently
crediting it as a kill.

This is a curated defect model, not exhaustive AST mutation coverage. Add new
reviewed catalog entries when new critical behavior appears. Its score only
describes these selected defects and must not be presented as total listener
coverage. Reports and disposable `.mutation-*` folders are generated artifacts.
