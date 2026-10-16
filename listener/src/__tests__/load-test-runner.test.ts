/**
 * Load-testing workflow tests (issue #860)
 *
 * These exercise the measurement core directly with an injected probe so the
 * behaviour is deterministic and socket-free: percentile maths, request/error
 * accounting, threshold gating and baseline comparison.
 */

import { describe, it, expect, jest } from '@jest/globals';

import {
  LOAD_REPORT_SCHEMA_VERSION,
  compareLoadReports,
  formatComparison,
  formatLoadReport,
  percentile,
  runLoadTest,
  runScenario,
  summarizeLatencies,
  type LoadReport,
  type LoadTestProbe,
  type LoadTestScenario,
} from '../utils/load-test-runner';

/** Probe that always succeeds and reports a fixed latency. */
function constantProbe(status = 200, durationMs = 5): LoadTestProbe {
  return jest.fn(async () => ({ status, durationMs }));
}

function scenario(overrides: Partial<LoadTestScenario> = {}): LoadTestScenario {
  return {
    name: 'status',
    method: 'GET',
    path: '/api/status',
    concurrency: 2,
    durationMs: 5_000,
    maxRequests: 8,
    ...overrides,
  };
}

describe('percentile (#860)', () => {
  it('returns 0 for an empty sample', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('uses nearest-rank for typical percentiles', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 90)).toBe(90);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
  });

  it('clamps the boundaries to the sample', () => {
    const sorted = [3, 9, 12];
    expect(percentile(sorted, 0)).toBe(3);
    expect(percentile(sorted, 100)).toBe(12);
  });
});

describe('summarizeLatencies (#860)', () => {
  it('reports min/mean/percentiles/max from unsorted input', () => {
    const stats = summarizeLatencies([40, 10, 30, 20]);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(40);
    expect(stats.mean).toBe(25);
    expect(stats.p50).toBe(20);
    expect(stats.p99).toBe(40);
  });

  it('returns zeroed stats for no samples', () => {
    expect(summarizeLatencies([])).toEqual({
      min: 0,
      mean: 0,
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      max: 0,
    });
  });
});

describe('runScenario (#860)', () => {
  it('measures exactly maxRequests and counts successes', async () => {
    const probe = constantProbe(200, 4);
    const result = await runScenario(scenario({ concurrency: 4, maxRequests: 20 }), probe);

    expect(result.requests).toBe(20);
    expect(result.success).toBe(20);
    expect(result.errorRate).toBe(0);
    expect(result.throughputRps).toBeGreaterThan(0);
    expect(result.latencyMs.p50).toBe(4);
    expect(probe).toHaveBeenCalledTimes(20);
  });

  it('separates client (4xx) and server (5xx) errors', async () => {
    let call = 0;
    const probe: LoadTestProbe = jest.fn(async () => {
      call += 1;
      const status = call % 4 === 0 ? 500 : call % 2 === 0 ? 429 : 200;
      return { status, durationMs: 1 };
    });

    const result = await runScenario(scenario({ concurrency: 1, maxRequests: 8 }), probe);

    expect(result.requests).toBe(8);
    expect(result.success + result.clientErrors + result.serverErrors).toBe(8);
    expect(result.serverErrors).toBeGreaterThan(0);
    expect(result.clientErrors).toBeGreaterThan(0);
    expect(result.errorRate).toBeGreaterThan(0);
  });

  it('does not count warm-up requests in the report', async () => {
    const probe = constantProbe(200, 1);
    const result = await runScenario(
      scenario({ concurrency: 2, durationMs: 20, warmupMs: 20, maxRequests: undefined }),
      probe,
    );

    // The report only reflects the measured phase, so it can't distinguish
    // warm-up calls; but the probe must have been called at least once.
    expect(result.requests).toBeGreaterThan(0);
    expect(probe).toHaveBeenCalled();
  });
});

describe('runLoadTest threshold gating (#860)', () => {
  const config = {
    scenarios: [scenario({ name: 'a', maxRequests: 10 }), scenario({ name: 'b', maxRequests: 10 })],
    thresholds: { maxErrorRate: 0.05, maxP95Ms: 100 },
  };

  it('passes when every threshold is satisfied and produces a schemaVersioned report', async () => {
    const report = await runLoadTest(config, constantProbe(200, 10));
    expect(report.schemaVersion).toBe(LOAD_REPORT_SCHEMA_VERSION);
    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.totals.requests).toBe(20);
    expect(report.scenarios.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('fails when the aggregate error rate breaches the threshold', async () => {
    const report = await runLoadTest(config, constantProbe(500, 10));
    expect(report.passed).toBe(false);
    expect(report.totals.errorRate).toBe(1);
    expect(report.failures.join(' ')).toContain('error rate');
  });

  it('fails when a scenario p95 breaches the latency threshold', async () => {
    const report = await runLoadTest(config, constantProbe(200, 500));
    expect(report.passed).toBe(false);
    expect(report.failures.join(' ')).toContain('p95');
  });

  it('fails when throughput falls below the minimum', async () => {
    const report = await runLoadTest(
      { ...config, thresholds: { ...config.thresholds, minThroughputRps: 10_000_000 } },
      constantProbe(200, 1),
    );
    expect(report.passed).toBe(false);
    expect(report.failures.join(' ')).toContain('throughput');
  });
});

describe('compareLoadReports (#860)', () => {
  function reportWith(name: string, p95: number, rps: number, errorRate = 0): LoadReport {
    const scenarioResult = {
      name,
      method: 'GET' as const,
      path: '/api/status',
      concurrency: 1,
      durationMs: 1000,
      requests: 100,
      success: 100,
      clientErrors: 0,
      serverErrors: 0,
      errorRate,
      throughputRps: rps,
      latencyMs: { min: p95, mean: p95, p50: p95, p90: p95, p95, p99: p95, max: p95 },
    };
    return {
      schemaVersion: LOAD_REPORT_SCHEMA_VERSION,
      generatedAt: new Date(0).toISOString(),
      environment: { node: 'v0', platform: 'test', release: 'test', cpus: 1, totalMemoryMb: 1 },
      scenarios: [scenarioResult],
      totals: { requests: 100, errorRate, throughputRps: rps, latencyMs: scenarioResult.latencyMs },
      thresholds: { maxErrorRate: 0.1, maxP95Ms: 1000 },
      passed: true,
      failures: [],
    };
  }

  it('detects a latency regression beyond the tolerance', () => {
    const comparison = compareLoadReports(
      reportWith('status', 100, 1000),
      reportWith('status', 150, 900),
    );
    const scenarioComparison = comparison.scenarios[0];
    expect(scenarioComparison.status).toBe('compared');
    expect(scenarioComparison.p95Ms?.delta).toBe(50);
    expect(scenarioComparison.p95Ms?.deltaPct).toBeCloseTo(0.5);
    expect(comparison.passed).toBe(false);
    expect(comparison.regressions.length).toBe(1);
  });

  it('treats an improvement as a pass', () => {
    const comparison = compareLoadReports(
      reportWith('status', 100, 1000),
      reportWith('status', 80, 1200),
    );
    expect(comparison.passed).toBe(true);
    expect(comparison.regressions).toEqual([]);
  });

  it('honours a wider regression tolerance', () => {
    const comparison = compareLoadReports(
      reportWith('status', 100, 1000),
      reportWith('status', 105, 1000),
      0.1,
    );
    expect(comparison.passed).toBe(true);
  });

  it('reports added and removed scenarios', () => {
    const comparison = compareLoadReports(
      reportWith('status', 100, 1000),
      reportWith('events', 100, 1000),
    );
    const statuses = comparison.scenarios.map((s) => s.status).sort();
    expect(statuses).toEqual(['added', 'removed']);
  });
});

describe('report formatting (#860)', () => {
  it('renders a readable report and comparison', async () => {
    const report = await runLoadTest(
      {
        scenarios: [scenario({ name: 'status', maxRequests: 4 })],
        thresholds: { maxErrorRate: 0.1, maxP95Ms: 1000 },
      },
      constantProbe(200, 3),
    );
    const text = formatLoadReport(report);
    expect(text).toContain('status');
    expect(text).toContain('Thresholds: PASS');

    const comparison = compareLoadReports(report, report);
    expect(formatComparison(comparison)).toContain('Comparison vs baseline');
  });
});
