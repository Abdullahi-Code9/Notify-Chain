/**
 * Report persistence for the load-testing workflow (issue #860)
 *
 * Reports are schema-versioned JSON (`LOAD_REPORT_SCHEMA_VERSION`), which is
 * what makes "results comparable across changes" possible: a report can be
 * committed as a baseline and diffed by `compareLoadReports`.
 */

import fs from 'fs';
import path from 'path';

import type { LoadReport } from './load-test-runner';

export const DEFAULT_REPORT_DIR = path.resolve(__dirname, '..', '..', 'reports', 'load');
export const DEFAULT_REPORT_PATH = path.join(DEFAULT_REPORT_DIR, 'latest.json');
export const DEFAULT_BASELINE_PATH = path.join(DEFAULT_REPORT_DIR, 'baseline.json');

/** Writes a report as pretty-printed JSON, creating the directory if needed. */
export function writeLoadReport(outPath: string, report: LoadReport): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

/** Reads a previously written report. Throws if it is missing. */
export function readLoadReport(reportPath: string): LoadReport {
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Report not found: ${reportPath}`);
  }
  return JSON.parse(fs.readFileSync(reportPath, 'utf8')) as LoadReport;
}
