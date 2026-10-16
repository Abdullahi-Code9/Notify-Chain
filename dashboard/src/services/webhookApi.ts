import type { WebhookDelivery } from '../types/webhook';
import { generateMockWebhookDeliveries } from '../utils/webhookData';

const BASE_URL =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_EVENTS_API_URL) ||
  'http://localhost:8787';

export interface WebhookDeliveryResponse {
  deliveries: WebhookDelivery[];
  total: number;
}

export interface WebhookApiFailureInjection {
  /** Number of consecutive failures to inject before succeeding. 0 disables injection. */
  failures: number;
  /** Error message to throw when a failure is injected. */
  message?: string;
  /** HTTP status code to simulate. */
  status?: number;
}

let failureInjection: WebhookApiFailureInjection { failures: 0 } = { failures: 0 };
let remainingFailures = 0;

/**
 * Configure controlled failure injection for webhook API calls.
 * This is deterministic and intended for tests.
 */
export function setWebhookApiFailureInjection(config: WebhookApiFailureInjection): void {
  failureInjection = { ...config };
  remainingFailures = Math.max(0, config.failures || 0);
}

/**
 * Clear any configured failure injection and reset counters.
 */
export function clearWebhookApiFailureInjection(): void {
  failureInjection = { failures: 0 };
  remainingFailures = 0;
}

export function getRemainingWebhookApiFailures(): number {
  return remainingFailures;
}

function shouldInjectFailure(): boolean {
  if (failureInjection.failures <= 0 || remainingFailures <= 0) {
    return false;
  }
  remainingFailures -= 1;
  return true;
}

/**
 * Fetch webhook delivery records from the API.
 * Falls back to mock data if the API is unreachable.
 */
export async function fetchWebhookDeliveries(): Promise<WebhookDeliveryResponse> {
  if (shouldInjectFailure()) {
    const status = failureInjection.status ?? 500;
    const message =
      failureInjection.message ??
      `Failed to fetch webhook deliveries: ${status}`;
    throw new Error(message);
  }

  const response = await fetch(`${BASE_URL}/api/webhooks/deliveries`);
  if (!response.ok) {
    throw new Error(`Failed to fetch webhook deliveries: ${response.status}`);
  }
  return response.json() as Promise<WebhookDeliveryResponse>;
}

/**
 * Generates mock deliveries for local development / API unavailable scenarios.
 */
export function getMockWebhookDeliveries(): WebhookDeliveryResponse {
  const deliveries = generateMockWebhookDeliveries(600, 168);
  return { deliveries, total: deliveries.length };
}
