import type { RetryStatistics } from '../types/retryStatistics';

import { getEventsApiBaseUrl } from '../config/eventsApiUrl';

const BASE_URL = getEventsApiBaseUrl();

export interface RetryStatisticsApiOptions {

  fetchFn?: typeof fetch;

  retryDelayMs?: number;

  maxRetries?: number;

}

export interface RetryStatisticsFailureInjection {

  failNextRequests?: number;

  failUntilTimestamp?: number;

}

let injectedFailures: RetryStatisticsFailureInjection = {};

export function injectRetryStatisticsFailure(

  injection: RetryStatisticsFailureInjection,

): void {

  injectedFailures = { ...injectedFailures, ...injection };

}

export function clearRetryStatisticsFailureInjection(): void {

  injectedFailures = {};

}

export function getRetryStatisticsFailureInjection(): RetryStatisticsFailureInjection {

  return { ...injectedFailures };

}

function shouldInjectFailure(now: number): boolean {

  if (injectedFailures.failUntilTimestamp !== undefined) {

    if (now < injectedFailures.failUntilTimestamp) {

      return true;

    }

  }

  if (injectedFailures.failNextRequests !== undefined && injectedFailures.failNextRequests > 0) {

    injectedFailures.failNextRequests -= 1;

    return true;

  }

  return false;

}

function sleep(ms: number): Promise<void> {

  return new Promise((resolve) => setTimeout(resolve, ms));

}

export async function fetchRetryStatistics(

  options: RetryStatisticsApiOptions = {},

): Promise<RetryStatistics> {

  const fetchFn = options.fetchFn ?? fetch;

  const maxRetries = options.maxRetries ?? 0;

  const retryDelayMs = options.retryDelayMs ?? 0;

  let attempt = 0;

  let lastError: Error | undefined;

  while (attempt <= maxRetries) {

    if (shouldInjectFailure(Date.now())) {

      lastError = new Error('Injected retry statistics failure');

    } else {

      try {

        const response = await fetchFn(`${BASE_URL}/api/schedule/retry-statistics`);

        if (!response.ok) {

          throw new Error(`Failed to fetch retry statistics: ${response.status}`);

        }

        return (await response.json()) as RetryStatistics;

      } catch (error) {

        lastError = error instanceof Error ? error : new Error(String(error));

      }

    }

    if (attempt < maxRetries) {

      if (retryDelayMs > 0) {

        await sleep(retryDelayMs);

      }

    }

    attempt += 1;

  }

  throw lastError ?? new Error('Failed to fetch retry statistics');

}

/** Deterministic mock used when the API is unavailable (dev / offline). */

export function generateMockRetryStatistics(): RetryStatistics {

  return {

    totalNotifications: 48,

    totalRetryAttempts: 27,

    notificationsWithRetries: 14,

    permanentFailures: 5,

    recoveredAfterRetry: 9,

    averageRetriesPerNotification: 0.56,

    maxObservedRetryCount: 3,

    retryRate: 14 / 48,

    distribution: [

      { retryCount: 0, count: 34, successCount: 30, failureCount: 4 },

      { retryCount: 1, count: 8, successCount: 6, failureCount: 2 },

      { retryCount: 2, count: 4, successCount: 2, failureCount: 2 },

      { retryCount: 3, count: 2, successCount: 1, failureCount: 1 },

    ],

  };

}
