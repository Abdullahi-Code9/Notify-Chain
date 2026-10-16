/**
 * Load-test configuration loading (issue #860)
 *
 * Shared by the external CLI (`src/scripts/load-test.ts`) and the in-process
 * Jest workflow (`src/__tests__/load-test.workflow.test.ts`) so both interpret
 * `load-test.config.json` identically.
 */

import fs from 'fs';
import path from 'path';

import type { RateLimitConfig } from '../types';
import type { LoadTestConfig } from './load-test-runner';

export interface LoadTestTarget {
  /** Default base URL used by the external CLI when `--url` is omitted. */
  baseUrl?: string;
  /**
   * Rate-limit config applied to the in-process server by the Jest workflow.
   * Rate limiting is disabled by default so the workflow measures raw API
   * capacity; enable it to load-test the throttling path itself.
   */
  rateLimit?: RateLimitConfig;
}

export interface LoadTestFileConfig extends LoadTestConfig {
  $schema?: string;
  target?: LoadTestTarget;
}

export const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', '..', 'load-test.config.json');

/** Reads and minimally validates the config file. Throws on unusable input. */
export function loadLoadTestConfig(configPath: string = DEFAULT_CONFIG_PATH): LoadTestFileConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as LoadTestFileConfig;
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
    throw new Error('Config must define at least one scenario');
  }
  if (!parsed.thresholds) {
    throw new Error('Config must define thresholds');
  }
  return parsed;
}
