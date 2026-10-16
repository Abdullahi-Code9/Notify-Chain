#!/usr/bin/env ts-node

/**
 * Repeatable load-testing workflow (issue #860) — external target
 *
 * Runs the scenarios documented in `load-test.config.json` against a running
 * NotifyChain listener and writes a JSON report that can be compared across
 * changes.
 *
 * This entry point talks to an already-running server over HTTP, which is how
 * you load-test a deployed listener. To run the same scenarios in-process
 * (no external server, no network) use `npm run load-test`, which drives the
 * scenarios through the Jest workflow instead — the listener's runtime
 * dependency mapping (`@stellar/stellar-sdk`, `node-cache`, `uuid`) is only
 * wired up under Jest, so that is the supported in-process path.
 *
 * Usage:
 *   npm run load-test:external -- --url http://127.0.0.1:3000
 *   npm run load-test:external -- --url https://listener.example.com --out reports/load/staging.json
 *   npm run load-test:external -- --url http://127.0.0.1:3000 --baseline reports/load/baseline.json
 *   npm run load-test:external -- --url http://127.0.0.1:3000 --baseline reports/load/baseline.json --fail-on-regression
 *
 * Exit codes:
 *   0  thresholds (and, when gating, baseline comparison) passed
 *   1  a threshold was breached, or a regression was detected while gating
 *   2  the workflow could not run (bad config, bad arguments)
 */

import path from 'path';

import {
  DEFAULT_CONFIG_PATH,
  loadLoadTestConfig,
  type LoadTestFileConfig,
} from '../utils/load-test-config';
import { makeHttpProbe } from '../utils/load-test-http-probe';
import { DEFAULT_REPORT_PATH, readLoadReport, writeLoadReport } from '../utils/load-test-reports';
import {
  compareLoadReports,
  formatComparison,
  formatLoadReport,
  runLoadTest,
  type LoadTestConfig,
} from '../utils/load-test-runner';

interface CliOptions {
  configPath: string;
  url?: string;
  outPath: string;
  baselinePath?: string;
  failOnRegression: boolean;
  concurrency?: number;
  durationMs?: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    configPath: DEFAULT_CONFIG_PATH,
    outPath: DEFAULT_REPORT_PATH,
    failOnRegression: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case '--config':
        options.configPath = path.resolve(next());
        break;
      case '--url':
        options.url = next();
        break;
      case '--out':
        options.outPath = path.resolve(next());
        break;
      case '--baseline':
        options.baselinePath = path.resolve(next());
        break;
      case '--concurrency':
        options.concurrency = Number(next());
        break;
      case '--duration':
        options.durationMs = Number(next());
        break;
      case '--fail-on-regression':
        options.failOnRegression = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp(): void {
  process.stdout.write(
    [
      'NotifyChain load-testing workflow (external target)',
      '',
      'Options:',
      '  --config <path>          Scenario/threshold config (default: load-test.config.json)',
      '  --url <baseUrl>          Base URL of the listener to test (default: target.baseUrl in the config)',
      '  --out <path>             Where to write the JSON report (default: reports/load/latest.json)',
      '  --baseline <path>        Compare against a previously saved report',
      '  --fail-on-regression     Exit non-zero when the baseline comparison regresses',
      '  --concurrency <n>        Override concurrency for every scenario',
      '  --duration <ms>          Override durationMs for every scenario',
      '  --quiet                  Only print the report',
      '',
    ].join('\n'),
  );
}

function applyOverrides(config: LoadTestFileConfig, options: CliOptions): LoadTestConfig {
  const scenarios = config.scenarios.map((scenario) => ({
    ...scenario,
    concurrency: options.concurrency ?? scenario.concurrency,
    durationMs: options.durationMs ?? scenario.durationMs,
  }));
  return { scenarios, thresholds: config.thresholds };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadLoadTestConfig(options.configPath);
  const runConfig = applyOverrides(config, options);

  const baseUrl = options.url ?? config.target?.baseUrl;
  if (!baseUrl) {
    throw new Error('No target: pass --url or set target.baseUrl in the config');
  }

  if (!options.quiet) {
    process.stdout.write(
      `Load testing ${baseUrl} across ${runConfig.scenarios.length} scenario(s)...\n\n`,
    );
  }

  const report = await runLoadTest(runConfig, makeHttpProbe(baseUrl));
  writeLoadReport(options.outPath, report);
  process.stdout.write(`${formatLoadReport(report)}\n`);
  process.stdout.write(`\nReport written to ${options.outPath}\n`);

  let regressionFailed = false;
  if (options.baselinePath) {
    const baseline = readLoadReport(options.baselinePath);
    const comparison = compareLoadReports(baseline, report);
    process.stdout.write(`\n${formatComparison(comparison)}\n`);
    if (!comparison.passed && options.failOnRegression) {
      regressionFailed = true;
      process.stdout.write('\nBaseline regressions detected while --fail-on-regression is set.\n');
    }
  }

  if (!report.passed || regressionFailed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Load-test workflow failed: ${message}\n`);
  process.exit(2);
});
