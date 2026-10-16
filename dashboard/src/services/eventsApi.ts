import type { BlockchainEvent } from '../types/event';
import { NOTIFICATION_STATUS_EVENTS } from '../types/event';

/**
 * Resolves the `notificationStatus` field on each incoming event by inspecting
 * its `eventName` against the known status-transition event names.
 *
 * This ensures that after a hard page refresh (where the store is empty and
 * events are fetched fresh from the API), notification statuses are accurately
 * set from the first render — not left `undefined` until a mutation action
 * patches them in.
 */
function hydrateNotificationStatus(events: BlockchainEvent[]): BlockchainEvent[] {
  return events.map((event) => {
    if (!event.eventName) return event;
    const status = NOTIFICATION_STATUS_EVENTS[event.eventName];
    if (!status) return event;
    return { ...event, notificationStatus: status };
  });
}

export interface ContractStatus {
  address: string;
  paused: boolean;
  error?: string;
}

export interface StatusResponse {
  timestamp: string;
  contracts: ContractStatus[];
}

export interface NotificationSearchResult {
  id: number;
  source: 'scheduled' | 'processed';
  eventId: string | null;
  txHash: string | null;
  contractAddress: string | null;
  notificationType: string | null;
  targetRecipient: string | null;
  status: string;
  createdAt: string;
  payload: string | null;
  /**
   * Human-readable reason the delivery failed (#493).
   * `null` when the notification succeeded or is still pending.
   */
  failureReason: string | null;
}

export interface NotificationSearchResponse {
  results: NotificationSearchResult[];
  total: number;
  limit: number;
  offset: number;
  itemCount: number;
  totalPages: number;
}

export interface NotificationSearchParams {
  q?: string;
  sender?: string;
  txHash?: string;
  eventId?: string;
  status?: string;
  type?: string;
  /** Inclusive lower bound (YYYY-MM-DD or ISO datetime) */
  startDate?: string;
  /** Inclusive upper bound (YYYY-MM-DD or ISO datetime) */
  endDate?: string;
  limit?: number;
  offset?: number;
  /** Sort order for results (#495): newest (default) | oldest | status */
  sortBy?: 'newest' | 'oldest' | 'status';
}

export const LISTENER_API_TIMEOUT_MS = 10_000;

export function isListenerApiTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out|timeout/i.test(error.message);
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = LISTENER_API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const signal = init.signal;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let abortListener: (() => void) | null = null;
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      abortListener = () => controller.abort();
      signal.addEventListener('abort', abortListener, { once: true });
    }
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    const err = error as { name?: string };
    if (controller.signal.aborted && err?.name === 'AbortError') {
      throw new Error(`Listener API request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (abortListener && signal) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

export async function fetchEvents(apiUrl: string): Promise<BlockchainEvent[]> {
  const response = await fetchWithTimeout(apiUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch events: ${response.status}`);
  }

  const payload = (await response.json()) as { events?: BlockchainEvent[] };
  const raw = payload.events ?? [];
  return hydrateNotificationStatus(raw);
}

/**
 * Failure-injection hook for the events API (#failure-injection).
 *
 * Allows tests to deterministically simulate RPC / database / scheduler /
 * notification-provider failures and verify recovery behavior without
 * relying on real network or timing conditions.
 */
export type FailureComponent =
  | 'rpc'
  | 'database'
  | 'scheduler'
  | 'notification-provider';

export interface InjectedFailure {
  component: FailureComponent;
  /** Number of remaining calls that should fail. `Infinity` for persistent. */
  remaining: number;
  message?: string;
}

const injectedFailures = new Map<FailureComponent, InjectedFailure>();

/**
 * Register a controlled failure for a component. Deterministic: the failure
 * is consumed a fixed number of times before recovery is observed.
 */
export function injectFailure(
  component: FailureComponent,
  times = 1,
  message?: string
): void {
  injectedFailures.set(component, { component, remaining: times, message });
}

/** Clear all injected failures (used between tests for determinism). */
export function clearInjectedFailures(): void {
  injectedFailures.clear();
}

/** Returns true when the given component currently has a pending failure. */
export function hasInjectedFailure(component: FailureComponent): boolean {
  const failure = injectedFailures.get(component);
  return !!failure && failure.remaining > 0;
}

/**
 * Consume one failure for the component if present. Returns the error to
 * throw, or `null` when the component is healthy (recovered).
 */
function consumeFailure(component: FailureComponent): Error | null {
  const failure = injectedFailures.get(component);
  if (!failure || failure.remaining <= 0) return null;
  failure.remaining -= 1;
  if (failure.remaining <= 0) injectedFailures.delete(component);
  return new Error(
    failure.message ?? `Injected ${component} failure`
  );
}

/**
 * Wraps an async operation so that injected failures for `component` are
 * surfaced as thrown errors, enabling recovery verification in tests.
 */
export async function withFailureInjection<T>(
  component: FailureComponent,
  operation: () => Promise<T>
): Promise<T> {
  const error = consumeFailure(component);
  if (error) throw error;
  return operation();
}

export async function fetchStatus(apiUrl: string): Promise<StatusResponse> {
  return withFailureInjection('rpc', async () => {
    const response = await fetch(`${apiUrl}/api/status`);
    if (!response.ok) {
      throw new Error(`Failed to fetch status: ${response.status}`);
    }
    return response.json() as Promise<StatusResponse>;
  });
}

export async function searchNotifications(
  baseUrl: string,
  params: NotificationSearchParams,
): Promise<NotificationSearchResponse> {
  const url = new URL(`${baseUrl}/api/notifications/search`);
  if (params.q) url.searchParams.set('q', params.q);
  if (params.sender) url.searchParams.set('sender', params.sender);
  if (params.txHash) url.searchParams.set('txHash', params.txHash);
  if (params.eventId) url.searchParams.set('eventId', params.eventId);
  if (params.status) url.searchParams.set('status', params.status);
  if (params.type) url.searchParams.set('type', params.type);
  if (params.startDate) url.searchParams.set('startDate', params.startDate);
  if (params.endDate) url.searchParams.set('endDate', params.endDate);
  if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
  if (params.offset !== undefined) url.searchParams.set('offset', String(params.offset));
  if (params.sortBy) url.searchParams.set('sortBy', params.sortBy);

  return withFailureInjection('database', async () => {
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Search failed: ${response.status}`);
    }
    return response.json() as Promise<NotificationSearchResponse>;
  });
}
