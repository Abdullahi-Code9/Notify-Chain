/**
 * Load-testing runner (issue #860)
 *
 * A small, dependency-free measurement core for the NotifyChain API. It is
 * deliberately separated from the CLI (`src/scripts/load-test.ts`) so the
 * metric maths, threshold gating and run-to-run comparison logic can be unit
 * tested without opening a socket.
 *
 * The workflow the issue asks for falls out of three exported pieces:
 *   1. `runLoadTest`      – executes documented scenarios and returns a report
 *   2. `compareLoadReports` – diffs a report against a saved baseline
 *   3. `formatLoadReport` / `formatComparison` – human-readable summaries
 *
 * Reports are plain JSON with a `schemaVersion`, so results can be committed
 * as a baseline and compared across changes.
 */

import os from 'os';

export const LOAD_REPORT_SCHEMA_VERSION = 1;

export type LoadTestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface LoadTestScenario {
  /** Stable identifier used to match scenarios across reports. */
  name: string;
  /** Human-readable note about which critical path the scenario covers. */
  description?: string;
  method: LoadTestMethod;
  path: string;
  headers?: Record<string, string>;
  /** Raw request body sent with the scenario (already serialized). */
  body?: string;
  /** Number of concurrent in-flight requests. */
  concurrency: number;
  /** Length of the measured phase, in milliseconds. */
  durationMs: number;
  /** Optional warm-up phase that is executed but excluded from the report. */
  warmupMs?: number;
  /**
   * Optional hard cap on measured requests. Combined with `durationMs` via a
   * logical AND, this keeps CI runs bounded and makes small runs deterministic.
   */
  maxRequests?: number;
}

export interface LoadTestThresholds {
  /** Maximum tolerated fraction of non-2xx responses (0..1). */
  maxErrorRate: number;
  /** Maximum tolerated p95 latency, in milliseconds. */
  maxP95Ms: number;
  /** Optional minimum aggregate throughput, in requests per second. */
  minThroughputRps?: number;
}

export interface LoadTestConfig {
  scenarios: LoadTestScenario[];
  thresholds: LoadTestThresholds;
}

export interface LatencyStats {
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ScenarioResult {
  name: string;
  method: LoadTestMethod;
  path: string;
  concurrency: number;
  durationMs: number;
  requests: number;
  success: number;
  clientErrors: number;
  serverErrors: number;
  /** Non-2xx responses divided by total responses. */
  errorRate: number;
  throughputRps: number;
  latencyMs: LatencyStats;
}

export interface LoadReportEnvironment {
  node: string;
  platform: string;
  release: string;
  cpus: number;
  totalMemoryMb: number;
}

export interface LoadReport {
  schemaVersion: number;
  generatedAt: string;
  environment: LoadReportEnvironment;
  scenarios: ScenarioResult[];
  totals: {
    requests: number;
    errorRate: number;
    throughputRps: number;
    latencyMs: LatencyStats;
  };
  thresholds: LoadTestThresholds;
  passed: boolean;
  failures: string[];
}

/** One probe invocation: returns the HTTP status and how long it took. */
export interface ProbeResult {
  status: number;
  durationMs: number;
}

export type LoadTestProbe = (scenario: LoadTestScenario) => Promise<ProbeResult>;

const EMPTY_STATS: LatencyStats = { min: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };

/**
 * Nearest-rank percentile (the same definition used by most HTTP load tools).
 * `sorted` must be ascending. Returns 0 for an empty input.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/** Summary statistics for a set of latency samples. */
export function summarizeLatencies(latencies: number[]): LatencyStats {
  if (latencies.length === 0) return { ...EMPTY_STATS };
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: round(sorted[0]),
    mean: round(sum / sorted.length),
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1]),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Runs one phase (warm-up or measured) at the scenario's concurrency.
 *
 * Each worker loops "check deadline/quota → issue request → await". Because the
 * check and the counter increment happen in the same synchronous block, the
 * `maxRequests` cap is never exceeded even with high concurrency.
 */
async function runPhase(
  scenario: LoadTestScenario,
  probe: LoadTestProbe,
  durationMs: number,
  maxRequests?: number,
): Promise<{
  latencies: number[];
  success: number;
  clientErrors: number;
  serverErrors: number;
  elapsedMs: number;
}> {
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  const latencies: number[] = [];
  let success = 0;
  let clientErrors = 0;
  let serverErrors = 0;
  let issued = 0;

  const workers = Array.from({ length: Math.max(1, scenario.concurrency) }, async () => {
    while (Date.now() < deadline && (maxRequests === undefined || issued < maxRequests)) {
      issued += 1;
      const result = await probe(scenario);
      latencies.push(result.durationMs);
      if (result.status >= 200 && result.status < 300) success += 1;
      else if (result.status >= 500) serverErrors += 1;
      else clientErrors += 1;
    }
  });

  await Promise.all(workers);
  return {
    latencies,
    success,
    clientErrors,
    serverErrors,
    elapsedMs: Math.max(1, Date.now() - startedAt),
  };
}

/** Executes a single scenario (warm-up + measured phase) and summarises it. */
export async function runScenario(
  scenario: LoadTestScenario,
  probe: LoadTestProbe,
): Promise<ScenarioResult> {
  if (scenario.warmupMs && scenario.warmupMs > 0) {
    await runPhase(scenario, probe, scenario.warmupMs, scenario.maxRequests);
  }

  const { latencies, success, clientErrors, serverErrors, elapsedMs } = await runPhase(
    scenario,
    probe,
    scenario.durationMs,
    scenario.maxRequests,
  );

  const requests = latencies.length;
  return {
    name: scenario.name,
    method: scenario.method,
    path: scenario.path,
    concurrency: scenario.concurrency,
    durationMs: elapsedMs,
    requests,
    success,
    clientErrors,
    serverErrors,
    errorRate: requests === 0 ? 0 : round((requests - success) / requests),
    throughputRps: round(requests / (elapsedMs / 1000)),
    latencyMs: summarizeLatencies(latencies),
  };
}

function describeEnvironment(): LoadReportEnvironment {
  return {
    node: process.version,
    platform: os.platform(),
    release: os.release(),
    cpus: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
  };
}

/**
 * Runs every scenario sequentially and evaluates the configured thresholds.
 * Scenarios run one after another so they don't contend for the same event loop
 * / server capacity (which would make results non-comparable across runs).
 */
export async function runLoadTest(
  config: LoadTestConfig,
  probe: LoadTestProbe,
): Promise<LoadReport> {
  const scenarios: ScenarioResult[] = [];
  for (const scenario of config.scenarios) {
    scenarios.push(await runScenario(scenario, probe));
  }

  let requests = 0;
  let success = 0;
  let elapsedMs = 0;
  for (const scenario of scenarios) {
    requests += scenario.requests;
    success += scenario.success;
    elapsedMs += scenario.durationMs;
  }

  const totals = {
    requests,
    errorRate: requests === 0 ? 0 : round((requests - success) / requests),
    throughputRps: elapsedMs === 0 ? 0 : round(requests / (elapsedMs / 1000)),
    latencyMs: summarizeLatencies(collectScenarioLatencies(scenarios)),
  };
  const failures = evaluateThresholds(scenarios, totals, config.thresholds);

  return {
    schemaVersion: LOAD_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    environment: describeEnvironment(),
    scenarios,
    totals,
    thresholds: config.thresholds,
    passed: failures.length === 0,
    failures,
  };
}

/**
 * We only keep per-scenario aggregate latency stats in the report, so the
 * aggregate "latencyMs" is derived from those percentiles (a report-level
 * roll-up, not a re-sampling of raw requests).
 */
function collectScenarioLatencies(scenarios: ScenarioResult[]): number[] {
  const samples: number[] = [];
  for (const scenario of scenarios) {
    // Weight each scenario's percentile points by its request count so the
    // roll-up tracks the overall traffic mix.
    const weight = Math.max(1, Math.min(50, Math.round(scenario.requests / 10) || 1));
    for (let i = 0; i < weight; i++) {
      samples.push(
        scenario.latencyMs.p50,
        scenario.latencyMs.p90,
        scenario.latencyMs.p95,
        scenario.latencyMs.p99,
      );
    }
  }
  return samples;
}

function evaluateThresholds(
  scenarios: ScenarioResult[],
  totals: LoadReport['totals'],
  thresholds: LoadTestThresholds,
): string[] {
  const failures: string[] = [];

  if (totals.errorRate > thresholds.maxErrorRate) {
    failures.push(
      `Aggregate error rate ${(totals.errorRate * 100).toFixed(2)}% exceeds maxErrorRate ${(thresholds.maxErrorRate * 100).toFixed(2)}%`,
    );
  }

  for (const scenario of scenarios) {
    if (scenario.latencyMs.p95 > thresholds.maxP95Ms) {
      failures.push(
        `Scenario "${scenario.name}" p95 ${scenario.latencyMs.p95}ms exceeds maxP95Ms ${thresholds.maxP95Ms}ms`,
      );
    }
  }

  if (
    thresholds.minThroughputRps !== undefined &&
    totals.throughputRps < thresholds.minThroughputRps
  ) {
    failures.push(
      `Aggregate throughput ${totals.throughputRps} rps is below minThroughputRps ${thresholds.minThroughputRps}`,
    );
  }

  return failures;
}

export interface ScenarioComparison {
  name: string;
  status: 'added' | 'removed' | 'compared';
  throughputRps?: Delta;
  p95Ms?: Delta;
  errorRate?: Delta;
}

export interface Delta {
  baseline: number;
  current: number;
  /** Absolute change (current - baseline). */
  delta: number;
  /** Relative change as a fraction (0.25 = +25%). */
  deltaPct: number;
}

export interface LoadReportComparison {
  scenarios: ScenarioComparison[];
  totals: {
    throughputRps: Delta;
    p95Ms: Delta;
    errorRate: Delta;
  };
  /** True when no scenario's p95 regressed by more than `regressionTolerancePct`. */
  passed: boolean;
  regressions: string[];
}

function makeDelta(baseline: number, current: number): Delta {
  const delta = round(current - baseline);
  return {
    baseline,
    current,
    delta,
    deltaPct: baseline === 0 ? (current === 0 ? 0 : 1) : round((current - baseline) / baseline),
  };
}

/**
 * Diffs two reports. `regressionTolerancePct` is the acceptable relative p95
 * increase (0.1 = 10%); anything above it is reported as a regression.
 */
export function compareLoadReports(
  baseline: LoadReport,
  current: LoadReport,
  regressionTolerancePct = 0.1,
): LoadReportComparison {
  const baselineByName = new Map(baseline.scenarios.map((scenario) => [scenario.name, scenario]));
  const currentByName = new Map(current.scenarios.map((scenario) => [scenario.name, scenario]));
  const names = Array.from(new Set([...baselineByName.keys(), ...currentByName.keys()]));

  const scenarios: ScenarioComparison[] = [];
  const regressions: string[] = [];

  for (const name of names) {
    const before = baselineByName.get(name);
    const after = currentByName.get(name);
    if (before && !after) {
      scenarios.push({ name, status: 'removed' });
      continue;
    }
    if (!before && after) {
      scenarios.push({ name, status: 'added' });
      continue;
    }
    if (!before || !after) continue;

    const p95Ms = makeDelta(before.latencyMs.p95, after.latencyMs.p95);
    scenarios.push({
      name,
      status: 'compared',
      throughputRps: makeDelta(before.throughputRps, after.throughputRps),
      p95Ms,
      errorRate: makeDelta(before.errorRate, after.errorRate),
    });

    if (p95Ms.deltaPct > regressionTolerancePct) {
      regressions.push(
        `Scenario "${name}" p95 regressed ${(p95Ms.deltaPct * 100).toFixed(1)}% (${before.latencyMs.p95}ms → ${after.latencyMs.p95}ms)`,
      );
    }
  }

  return {
    scenarios,
    totals: {
      throughputRps: makeDelta(baseline.totals.throughputRps, current.totals.throughputRps),
      p95Ms: makeDelta(baseline.totals.latencyMs.p95, current.totals.latencyMs.p95),
      errorRate: makeDelta(baseline.totals.errorRate, current.totals.errorRate),
    },
    passed: regressions.length === 0,
    regressions,
  };
}

/** Human-readable one-screen summary of a report. */
export function formatLoadReport(report: LoadReport): string {
  const lines: string[] = [];
  lines.push(`Load report (${report.generatedAt}) — schema v${report.schemaVersion}`);
  lines.push(
    `Environment: node ${report.environment.node} · ${report.environment.platform} ${report.environment.release} · ${report.environment.cpus} cpus`,
  );
  lines.push('');

  const header = ['scenario', 'reqs', 'err%', 'rps', 'p50', 'p95', 'p99', 'max'];
  const rows = report.scenarios.map((scenario) => [
    scenario.name,
    String(scenario.requests),
    `${(scenario.errorRate * 100).toFixed(2)}%`,
    scenario.throughputRps.toFixed(1),
    `${scenario.latencyMs.p50}ms`,
    `${scenario.latencyMs.p95}ms`,
    `${scenario.latencyMs.p99}ms`,
    `${scenario.latencyMs.max}ms`,
  ]);
  // Size each column to its widest cell so long scenario names don't collide
  // with the next column.
  const widths = header.map(
    (title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)) + 2,
  );
  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join('')
      .trimEnd();

  lines.push(renderRow(header));
  for (const row of rows) lines.push(renderRow(row));
  lines.push('');
  lines.push(
    `Totals: ${report.totals.requests} requests · ${report.totals.throughputRps.toFixed(1)} rps · error rate ${(report.totals.errorRate * 100).toFixed(2)}% · p95 ${report.totals.latencyMs.p95}ms`,
  );
  lines.push(report.passed ? 'Thresholds: PASS' : `Thresholds: FAIL (${report.failures.length})`);
  for (const failure of report.failures) lines.push(`  ✗ ${failure}`);
  return lines.join('\n');
}

/** Human-readable summary of a baseline comparison. */
export function formatComparison(comparison: LoadReportComparison): string {
  const lines: string[] = [];
  lines.push('Comparison vs baseline:');
  for (const scenario of comparison.scenarios) {
    if (scenario.status !== 'compared') {
      lines.push(`  ${scenario.name}: ${scenario.status}`);
      continue;
    }
    const p95 = scenario.p95Ms!;
    const rps = scenario.throughputRps!;
    const arrow = p95.deltaPct > 0 ? '↑' : '↓';
    lines.push(
      `  ${scenario.name}: p95 ${p95.baseline}ms → ${p95.current}ms (${arrow}${(Math.abs(p95.deltaPct) * 100).toFixed(1)}%), rps ${rps.baseline.toFixed(1)} → ${rps.current.toFixed(1)}`,
    );
  }
  lines.push(
    `  totals: p95 ${comparison.totals.p95Ms.baseline}ms → ${comparison.totals.p95Ms.current}ms, rps ${comparison.totals.throughputRps.baseline.toFixed(1)} → ${comparison.totals.throughputRps.current.toFixed(1)}`,
  );
  if (comparison.regressions.length > 0) {
    lines.push('Regressions:');
    for (const regression of comparison.regressions) lines.push(`  ✗ ${regression}`);
  }
  return lines.join('\n');
}
