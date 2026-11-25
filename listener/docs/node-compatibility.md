# Listener Node.js support

The listener supports Node.js **22.x and 24.x** (`^22.0.0 || ^24.0.0` in
`package.json`). Node 22 remains the Docker and default CI runtime. Other majors,
including odd-numbered releases, are outside the tested support contract. Use
the latest patch in a supported major; the matrix intentionally tracks those
patches and records the resolved Node and npm versions in each artifact.

`listener-node-compatibility.yml` independently installs the frozen lockfile,
builds the listener, runs the notification pipeline/normalization/lease tests,
and exercises emitted lease JavaScript plus real Express, SQLite native bindings,
and Node fetch on each major. Matrix jobs do not cancel each other on failure.
The runtime smoke test uses loopback HTTP and in-memory SQLite, requiring no
RPC credentials, persisted database, or external notification providers. It is
a runtime compatibility check for those dependencies and modules, not a full
production startup or live Stellar integration test. Jest uses SDK doubles;
passing the unit suite alone does not establish compatibility with a live SDK.

To reproduce after installing dependencies in `listener`, run on each major:

```sh
npm ci
npm run build
npm test -- --ci --runInBand src/__tests__/smoke/notification-pipeline.smoke.test.ts src/services/event-normalization.test.ts src/services/notification-claim-lease.test.ts
npm run test:runtime
```

Runtime code uses built-in fetch/AbortSignal and a native SQLite addon; do not
assume that transpiling TypeScript makes older Node versions compatible. Native
addons must be installed separately under each runtime; do not reuse a
`node_modules` directory across majors. CI uses Linux; Windows/macOS native addon
packaging is not covered by this matrix. The TypeScript lock entry is aligned
with the existing `~5.7.2` manifest range (5.7.3); its tarball integrity comes
from the npm registry metadata, without changing the dependency range.

Build errors fail the check even if a focused unit suite passes. Existing source
or dependency failures must be resolved before claiming a green compatibility
result; this workflow does not suppress diagnostics or substitute transpilation
for a successful full build. Support-policy changes must update the manifest,
lockfile root metadata, this document and the CI matrix together.
