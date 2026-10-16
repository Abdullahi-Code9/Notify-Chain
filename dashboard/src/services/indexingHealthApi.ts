import type { IndexingHealth } from '../types/indexingHealth';
import { parseIndexingHealth } from '../types/indexingHealth';

export type FailureInjectionTarget = 'rpc' | 'database' | 'scheduler' | 'notification-provider';

export interface FailureInjectionConfig {
  target: FailureInjectionTarget;
  /** Number of consecutive failures to simulate before recovery. Defaults to 1. */
  failures?: number;
  /** Optional deterministic error message. */
  message?: string;
}

export interface FailureInjectionState {
  target: FailureInjectionTarget;
  remainingFailures: number;
  totalFailures: number;
  message: string;
}

const DEFAULT_FAILURE_MESSAGES: Record<FailureInjectionTarget, string> = {
  rpc: 'Injected RPC failure',
  database: 'Injected database failure',
  scheduler: 'Injected scheduler failure',
  'notification-provider': 'Injected notification provider failure',
};

let activeInjection: FailureInjectionState | null = null;

/**
 * Configure a controlled failure scenario for a single component.
 * The next `failures` calls to the corresponding component will throw,
 * after which the component automatically recovers.
 */
export function injectFailure(config: FailureInjectionConfig): void {
  const failures = Math.max(1, Math.floor(config.failures ?? 1));
  activeInjection = {
    target: config.target,
    remainingFailures: failures,
    totalFailures: failures,
    message: config.message ?? DEFAULT_FAILURE_MESSAGES[config.target],
  };
}

/** Clear any active failure injection. */
export function clearFailureInjection(): void {
  activeInjection = null;
}

/** Return the current injection state, if any. */
export function getFailureInjectionState(): FailureInjectionState | null {
  return activeInjection ? { ...activeInjection } : null;
}

/**
 * Returns true when the given component is currently experiencing an
 * injected failure. Consumes a failure and automatically recovers once
 * the configured number of failures have been consumed.
 */
export function consumeInjectedFailure(target: FailureInjectionTarget): boolean {
  if (!activeInjection || activeInjection.target !== target) {
    return false;
  }

  if (activeInjection.remainingFailures <= 0) {
    activeInjection = null;
    return false;
  }

  activeInjection.remainingFailures -= 1;
  if (activeInjection.remainingFailures <= 0) {
    activeInjection = null;
  }
  return true;
}

export async function fetchIndexingHealth(
  healthUrl: string,
  options?: { signal?: AbortSignal },
): Promise<IndexingHealth> {
  if (consumeInjectedFailure('rpc')) {
    throw new Error(DEFAULT_FAILURE_MESSAGES.rpc);
  }

  const response = await fetch(healthUrl, { signal: options?.signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch indexing health: ${response.status}`);
  }

  const json = (await response.json()) as unknown;
  if (consumeInjectedFailure('database')) {
    throw new Error(DEFAULT_FAILURE_MESSAGES.database);
  }
  return parseIndexingHealth(json);
}

export function resolveIndexingHealthUrl(eventsApiUrl: string): string {
  // Most deployments use `{base}/api/events` for the event feed.
  // Derive the health endpoint from that in a resilient way.
  try {
    const url = new URL(eventsApiUrl);
    url.pathname = '/api/indexing/health';
    url.search = '';
    return url.toString();
  } catch {
    return 'http://localhost:8787/api/indexing/health';
  }
}
