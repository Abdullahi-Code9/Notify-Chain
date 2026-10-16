/**
 * In-process API load-testing workflow (issue #860)
 *
 * This is the `npm run load-test` entry point: it boots the real
 * `createEventsServer` on an ephemeral port and runs the scenarios documented
 * in `load-test.config.json` through a real HTTP probe, then writes a
 * schema-versioned report to `reports/load/latest.json` that can be compared
 * against a committed baseline.
 *
 * It lives under Jest deliberately. The listener's third-party runtime
 * dependencies (`@stellar/stellar-sdk`, `node-cache`, `uuid`) are not installed
 * — they are mapped to test doubles by `jest.config.js` — so Jest is the
 * supported way to execute the API in-process. The external CLI
 * (`npm run load-test:external`) covers the "already-running server" case.
 *
 * Gated behind `LOAD_TEST=1` so the regular `npm test` suite stays fast and
 * side-effect free.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import http from 'http';

import { createEventsServer } from '../api/events-server';
import type { RateLimitConfig } from '../types';
import { loadLoadTestConfig } from '../utils/load-test-config';
import { makeHttpProbe } from '../utils/load-test-http-probe';
import {
  DEFAULT_BASELINE_PATH,
  DEFAULT_REPORT_PATH,
  readLoadReport,
  writeLoadReport,
} from '../utils/load-test-reports';
import {
  LOAD_REPORT_SCHEMA_VERSION,
  compareLoadReports,
  formatComparison,
  formatLoadReport,
  runLoadTest,
  type LoadReport,
} from '../utils/load-test-runner';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.setTimeout(120_000);

/** Rate limiting is off for a capacity run; the config can override this. */
const DISABLED_RATE_LIMIT: RateLimitConfig = {
  enabled: false,
  windowMs: 60_000,
  maxRequests: 1_000_000,
  clientOverrides: {},
};

const describeWorkflow = process.env.LOAD_TEST === '1' ? describe : describe.skip;

describeWorkflow('API load-testing workflow (#860)', () => {
  let server: http.Server | undefined;
  let baseUrl = '';
  let report: LoadReport;

  beforeAll(async () => {
    const config = loadLoadTestConfig();

    server = createEventsServer({
      port: 0,
      stellarRpcUrl: process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
      stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
      contractAddresses: [],
      rateLimit: config.target?.rateLimit ?? DISABLED_RATE_LIMIT,
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;

    report = await runLoadTest(config, makeHttpProbe(baseUrl));
    writeLoadReport(DEFAULT_REPORT_PATH, report);
    process.stdout.write(`\n${formatLoadReport(report)}\n`);
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('executes every documented scenario and stays within thresholds', () => {
    const { scenarios } = loadLoadTestConfig();

    expect(report.schemaVersion).toBe(LOAD_REPORT_SCHEMA_VERSION);
    expect(report.scenarios.map((scenario) => scenario.name)).toEqual(
      scenarios.map((scenario) => scenario.name),
    );
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('measures throughput and latency for the critical endpoints', () => {
    for (const scenario of report.scenarios) {
      expect(scenario.requests).toBeGreaterThan(0);
      expect(scenario.throughputRps).toBeGreaterThan(0);
      expect(scenario.latencyMs.p95).toBeGreaterThanOrEqual(0);
      // Rate limiting is disabled, so nothing should be throttled.
      expect(scenario.clientErrors).toBe(0);
      expect(scenario.serverErrors).toBe(0);
    }
    expect(report.totals.requests).toBeGreaterThan(0);
    expect(report.totals.throughputRps).toBeGreaterThan(0);
  });

  it('can be compared against a committed baseline', () => {
    if (!fs.existsSync(DEFAULT_BASELINE_PATH)) {
      // No baseline committed yet: write this run as one to start comparing.
      process.stdout.write(`\nNo baseline at ${DEFAULT_BASELINE_PATH}; skipping comparison.\n`);
      return;
    }

    const baseline = readLoadReport(DEFAULT_BASELINE_PATH);
    const comparison = compareLoadReports(baseline, report);
    process.stdout.write(`\n${formatComparison(comparison)}\n`);

    if (process.env.LOAD_TEST_GATE === '1') {
      expect(comparison.passed).toBe(true);
    }
  });
});
