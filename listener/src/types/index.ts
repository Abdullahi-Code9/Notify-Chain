import type { RetryFailureType } from '../services/retry-policy';
import type { CircuitBreakerConfig } from '../services/circuit-breaker';
import type { PartialRetryBackoffConfig } from '../utils/retry-backoff-config';
import * as StellarSDK from '@stellar/stellar-sdk';

export interface NotificationProvider {
  sendEventNotification(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    requestId?: string,
  ): Promise<boolean>;

  sendTestMessage(requestId?: string): Promise<boolean>;
}

export interface ContractConfig {
  address: string;
  events: string[];
  /** Optional user ID for per-user notification preference gating */
  userId?: string;
}

export interface DiscordConfig {
  webhookUrl: string;
  webhookId: string;
  retryCount?: number;
  backoffBaseSeconds?: number;
  deduplicationWindowMs?: number;
  deduplicationMaxSize?: number;
  timeoutMs?: number;
}

export interface RetryQueueConfig {
  /**
   * Provider-independent retry backoff parameters for the in-memory
   * notification retry queue.  Defaults from `RETRY_BACKOFF_DEFAULTS` are
   * applied to any omitted field; the merged result is strictly validated
   * by the shared `resolveRetryBackoffConfig` validator.
   */
  backoff?: PartialRetryBackoffConfig;
  processIntervalMs?: number;
  priorityWeights?: { high: number; medium: number; low: number };
}

export interface WebhookSecret {
  id: string;
  secret: string;
}

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  maxRequests: number;
  clientOverrides: Record<string, { maxRequests: number; windowMs?: number }>;
}

export interface ApiKey {
  key: string;
  name?: string;
}

export interface Config {
  stellarNetwork: string;
  stellarRpcUrl: string;
  stellarRpcFallbackUrls?: string[];
  stellarRpcUrls?: string[];
  rpcFallback?: RpcFallbackConfig;
  stellarNetworkPassphrase: string;
  contractAddresses: ContractConfig[];
  pollIntervalMs: number;
  /** Maximum number of blockchain events fetched per polling cycle (default: 100). */
  eventBatchSize: number;
  maxReconnectAttempts: number;
  reconnectDelayMs: number;
  eventsApiPort: number;
  eventsApiCorsOrigin: string;
  discord?: DiscordConfig;
  retryQueue?: RetryQueueConfig;
  eventQueue?: EventQueueConfig;
  webhookSecrets?: WebhookSecret[];
  apiKeys?: ApiKey[];
  scheduler?: SchedulerConfig;
  retryScheduler?: RetrySchedulerOptions;
  retryPolicy?: RetryPolicyOptions;
  databasePath?: string;
  rateLimit?: RateLimitConfig;
  rpcRateLimit?: RpcRateLimitConfig;
  cleanup?: AppCleanupConfig;
  analytics?: AnalyticsConfig;
  expiration?: ExpirationConfig;
  /** Default scheduled-notification lifetime in seconds; zero disables expiry. */
  notificationDefaultTtlSeconds?: number;
  backfill?: BackfillConfig;
  logging?: LoggingConfig;
  api?: ApiConfig;
  /** High-volume event batching settings (feature: batched delivery). */
  eventBatching?: EventBatchingConfig;
  /** Periodic digest summary settings (feature: digest delivery). */
  digest?: DigestConfig;
  /** Localization (i18n) settings (feature: template separation). */
  localization?: LocalizationConfig;
  /** Dry-run mode: parse and validate events without persisting or delivering notifications. */
  dryRun?: boolean;
  /** Circuit breaker configuration for RPC failure handling. */
  circuitBreaker?: CircuitBreakerConfig;
}

/**
 * High-volume event batching configuration.
 *
 * When enabled, selected event groups are coalesced into a single batched
 * message once either `maxBatchSize` events accumulate or `windowMs` elapses.
 */
export interface EventBatchingConfig {
  enabled: boolean;
  maxBatchSize: number;
  windowMs: number;
}

/**
 * Periodic digest summary configuration.
 *
 * When enabled, recipients receive a periodic summary of accumulated event
 * activity instead of one delivery per event.
 */
export interface DigestConfig {
  enabled: boolean;
  intervalMs: number;
  maxEventsPerDigest: number;
}

/** Localization (i18n) configuration. */
export interface LocalizationConfig {
  /** Initial/default locale, used when a translation is missing. */
  defaultLocale: string;
}

/** Observability settings, sourced from LOG_LEVEL / LOG_FORMAT. */
export interface LoggingConfig {
  /** `error | warn | info | debug`. Defaults to `info`. */
  level: string;
  /**
   * `json` for aggregator-friendly newline-delimited JSON, `pretty` for the
   * colourised human format. Defaults to `json` in production and `pretty`
   * elsewhere.
   */
  format: string;
}

/** HTTP surface settings for the events API. */
export interface ApiConfig {
  /**
   * Largest request body accepted, in bytes. Oversized requests are answered
   * with 413 and their payload is never parsed.
   */
  maxBodyBytes: number;
}

export interface SchedulerConfig {
  enabled: boolean;
  pollIntervalMs: number;
  lockTimeoutMs: number;
  processorId?: string;
  batchSize: number;
  concurrency: number;
  timingBufferMs: number;
  recoveryPolicy: 'EXECUTE' | 'EXPIRE' | 'REQUIRE_INTERVENTION';
}

export interface EventQueueConfig {
  /** Maximum number of events to process concurrently (default: 1, must be >= 1). */
  maxConcurrency?: number;
  /** Maximum retry attempts per event (default: 3). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 2000). */
  baseDelayMs?: number;
  /** How often to poll the queue for due events in ms (default: 1000). */
  pollIntervalMs?: number;
}

export interface AppCleanupConfig {
  /** Whether scheduled database cleanup is enabled. */
  enabled: boolean;
  /** How often to run cleanup jobs (ms). */
  intervalMs: number;
  /** Global retention period for database cleanup (days). */
  retentionDays: number;
  /** Explicit legacy per-table overrides, when supplied. */
  retentionOverridesMs?: {
    processedEvents?: number;
    executionLogs?: number;
    rateLimitEvents?: number;
  };
  /** Retain completed/failed/cancelled notifications for this long (ms). */
  notificationRetentionMs: number;
  /** Retain rate-limit audit rows for this long (ms). */
  rateLimitEventRetentionMs: number;
  /** Retain in-memory events for this long (ms). */
  eventRetentionMs: number;
  /** Retain processed event metadata for this long (ms). Default: 30 days. */
  processedEventRetentionMs: number;
  /** Retain notification execution log rows for this long (ms). */
  executionLogRetentionMs: number;
}

export interface RetrySchedulerOptions {
  enabled: boolean;
  pollIntervalMs: number;
  lockTimeoutMs: number;
  processorId?: string;
  batchSize: number;
  baseDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  jitter: boolean;
  /**
   * Timeout (ms) for outbound webhook requests (`WEBHOOK_TIMEOUT_MS`).
   * Defaults to `DEFAULT_WEBHOOK_TIMEOUT_MS` (10 000 ms).
   */
  webhookTimeoutMs: number;
  /**
   * Retry-policy ceiling on total attempts. Mirrors `RetrySchedulerConfig`;
   * `undefined` leaves each notification's own `maxRetries` in control.
   */
  maxAttempts?: number;
  /** Failure types eligible for retry. Mirrors `RetrySchedulerConfig`. */
  retryableFailureTypes?: RetryFailureType[];
}

/**
 * Retry policy settings (#842).
 *
 * Controls the three knobs that decide whether a failed notification delivery
 * is attempted again:
 *   - `maxAttempts` — hard ceiling on total attempts. `undefined` leaves each
 *     notification's own `max_retries` in control; `1` disables retries.
 *   - `retryableFailureTypes` — the failure types eligible for retry. Anything
 *     not listed fails on its first attempt.
 *
 * The delay curve reuses the existing `RETRY_BASE_DELAY_MS`,
 * `RETRY_MULTIPLIER`, `RETRY_MAX_DELAY_MS` and `RETRY_JITTER` variables, which
 * the retry scheduler and the in-memory retry queue already share.
 */
export interface RetryPolicyOptions {
  /** Hard ceiling on delivery attempts; `undefined` means no ceiling. */
  maxAttempts?: number;
  /** Failure types eligible for retry. */
  retryableFailureTypes: RetryFailureType[];
}

export interface AnalyticsConfig {
  enabled: boolean;
  maxRecords: number;
  maxBuckets: number;
  bucketSizeMs: number;
  /** How often to persist summarized snapshots (ms). */
  persistIntervalMs: number;
  /** How long to retain persisted snapshots (days). */
  snapshotRetentionDays: number;
}

export interface ExpirationConfig {
  /** Default expiration time in milliseconds (default: 24 hours = 86400000). */
  defaultExpirationMs: number;
  /** Per-event-type expiration times in milliseconds. */
  perEventTypeExpiration?: Record<string, number>;
  /** Whether expiration checking is enabled (default: true). */
  enabled: boolean;
}

/**
 * Safety limits for the historical backfill that runs when the listener
 * starts without a stored cursor (first boot or after downtime).
 */
export interface BackfillConfig {
  /**
   * When true, a backfill run is triggered once at startup before the live
   * polling loop begins.
   */
  enabled?: boolean;
  /**
   * The earliest ledger from which to recover missed events (inclusive).
   * Events at or after this ledger that are not yet in processed_events will
   * be passed through the normal processing pipeline.
   */
  startLedger?: number;
  /**
   * The last ledger to include in the backfill window (inclusive).
   * Defaults to the current network-tip ledger when not set.
   */
  endLedger?: number;
  /**
   * Maximum number of Stellar RPC pages to fetch per contract during the
   * backfill.  Each page holds up to 200 events.  Defaults to 50.
   */
  maxPages?: number;
  /**
   * Upper bound on the total number of on-chain events processed per
   * contract.  Acts as a safety rail against unexpectedly large windows.
   * Defaults to 10 000.
   */
  maxEventsPerContract?: number;
  /**
   * Maximum number of ledgers to replay from the network tip on a cold start.
   *
   * When the subscriber has no persisted cursor for a contract it would
   * normally request events from ledger 1, which can be an arbitrarily large
   * range after downtime or a configuration change.  This limit caps the
   * range to the most recent `maxLedgers` ledgers instead.
   *
   * Set to `0` to disable the limit and allow full historical replay
   * (the previous default behaviour).  Default: 10 000.
   */
  maxLedgers?: number;
}

/**
 * Rate limiting configuration for RPC event ingestion to prevent
 * excessive RPC requests and resource consumption.
 */
export interface RpcRateLimitConfig {
  /** Whether RPC rate limiting is enabled (default: true). */
  enabled: boolean;
  /** Maximum RPC requests per second (default: 10). */
  maxRequestsPerSecond: number;
  /** Burst size - allows short bursts above the sustained rate (default: 20). */
  burstSize: number;
  /** Delay in ms to apply when throttled (default: 1000). */
  throttleDelayMs: number;
}

/** Configuration for fallback RPC endpoints and automatic failover. */
export interface RpcFallbackConfig {
  /** Array of fallback RPC URLs to try when primary fails */
  fallbackUrls: string[];
  /** Number of consecutive failures before marking endpoint unhealthy and failing over (default: 3) */
  failureThreshold: number;
  /** Cooldown duration in ms before attempting to reuse a failed endpoint (default: 60000) */
  cooldownMs: number;
  /** Timeout for RPC requests in milliseconds (default: 10000) */
  requestTimeoutMs: number;
  /** Maximum number of endpoint retries for a single operation across pool (default: pool size) */
  maxRetries?: number;
  /**
   * When true (default), the manager returns to the highest-priority endpoint
   * (the primary first) once its cooldown has elapsed, instead of staying on a
   * fallback indefinitely. Controlled by `RPC_FAILBACK_ENABLED`.
   */
  failbackToPrimary?: boolean;
}

/** Operational status metrics for an RPC endpoint */
export interface RpcEndpointStatus {
  url: string;
  /** Credential-free form of `url`, safe to log or expose via APIs. */
  redactedUrl?: string;
  isPrimary: boolean;
  status: 'healthy' | 'degraded' | 'unhealthy';
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  lastError: string | null;
}

/* -------------------------------------------------------------------------- */
/* Typed Client SDK for the Listener API (#990)                               */
/* -------------------------------------------------------------------------- */

/**
 * Lightweight, typed, fetch-based client for the Listener HTTP API.
 *
 * Core operations (events, stats, notifications, credentials) are exposed as
 * typed methods, and every HTTP failure is surfaced as a consistent
 * {@link ApiClientError} carrying the status code and parsed error body.
 *
 * @example
 * ```ts
 * import { ListenerApiClient, ApiClientError } from './types';
 *
 * const client = new ListenerApiClient({
 *   baseUrl: 'http://localhost:3000',
 *   apiKey: process.env.LISTENER_API_KEY,
 * });
 *
 * // List recent events
 * const { events, total } = await client.listEvents({ limit: 20 });
 *
 * // Fetch stats
 * const stats = await client.getStats();
 *
 * // Send a notification
 * await client.sendNotification({
 *   contractAddress: 'CABC...',
 *   eventType: 'transfer',
 *   payload: { amount: '100' },
 * });
 *
 * // Manage credentials
 * const credential = await client.createCredential({ name: 'ci' });
 *
 * // Consistent error handling
 * try {
 *   await client.getEvent('missing-id');
 * } catch (err) {
 *   if (err instanceof ApiClientError) {
 *     console.error(err.status, err.code, err.message);
 *   }
 * }
 * ```
 */

/** A single event as returned by the Listener API. */
export interface ApiEvent {
  id: string;
  contractAddress: string;
  eventType: string;
  ledger?: number;
  txHash?: string;
  payload?: unknown;
  createdAt?: string;
  [key: string]: unknown;
}

/** Query parameters accepted by {@link ListenerApiClient.listEvents}. */
export interface ListEventsParams {
  contractAddress?: string;
  eventType?: string;
  limit?: number;
  offset?: number;
  since?: string;
}

/** Paginated response for the events listing endpoint. */
export interface ListEventsResponse {
  events: ApiEvent[];
  total: number;
  limit?: number;
  offset?: number;
}

/** Aggregate statistics returned by the stats endpoint. */
export interface StatsResponse {
  totalEvents: number;
  totalNotifications: number;
  pendingNotifications?: number;
  failedNotifications?: number;
  uptimeSeconds?: number;
  [key: string]: unknown;
}

/** Request body for {@link ListenerApiClient.sendNotification}. */
export interface SendNotificationRequest {
  contractAddress: string;
  eventType: string;
  payload?: unknown;
  userId?: string;
  scheduledAt?: string;
}

/** Response returned after a notification is accepted. */
export interface SendNotificationResponse {
  id: string;
  status: string;
  scheduledAt?: string;
}

/** A stored credential (API key) record. */
export interface Credential {
  id: string;
  name?: string;
  createdAt?: string;
  /** Present only on creation responses. */
  secret?: string;
}

/** Request body for {@link ListenerApiClient.createCredential}. */
export interface CreateCredentialRequest {
  name?: string;
}

/** Options used to construct a {@link ListenerApiClient}. */
export interface ApiClientOptions {
  /** Base URL of the Listener API, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** Optional API key sent as the `x-api-key` header. */
  apiKey?: string;
  /** Per-request timeout in milliseconds (default: 10 000). */
  timeoutMs?: number;
  /** Custom fetch implementation (defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
}

/** Parsed error body shape returned by the Listener API. */
export interface ApiErrorBody {
  error?: string;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * Consistent error type for every failed Listener API call.
 *
 * Thrown by all {@link ListenerApiClient} methods when the server responds
 * with a non-2xx status, when the request times out, or when the network
 * request itself fails (in which case `status` is `0`).
 */
export class ApiClientError extends Error {
  /** HTTP status code, or `0` for network/timeout failures. */
  readonly status: number;
  /** Machine-readable error code from the response body, when present. */
  readonly code?: string;
  /** Parsed response body, when available. */
  readonly body?: ApiErrorBody;

  constructor(message: string, status: number, code?: string, body?: ApiErrorBody) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.body = body;
    Object.setPrototypeOf(this, ApiClientError.prototype);
  }
}

/**
 * Typed, fetch-based client for the Listener API.
 *
 * All methods reject with {@link ApiClientError} on failure.
 */
export class ListenerApiClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    if (!options || !options.baseUrl) {
      throw new Error('ListenerApiClient requires a baseUrl');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** List events, optionally filtered and paginated. */
  async listEvents(params: ListEventsParams = {}): Promise<ListEventsResponse> {
    const query = new URLSearchParams();
    if (params.contractAddress) query.set('contractAddress', params.contractAddress);
    if (params.eventType) query.set('eventType', params.eventType);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.since) query.set('since', params.since);
    const qs = query.toString();
    return this.request<ListEventsResponse>('GET', `/events${qs ? `?${qs}` : ''}`);
  }

  /** Fetch a single event by id. */
  async getEvent(id: string): Promise<ApiEvent> {
    return this.request<ApiEvent>('GET', `/events/${encodeURIComponent(id)}`);
  }

  /** Fetch aggregate listener statistics. */
  async getStats(): Promise<StatsResponse> {
    return this.request<StatsResponse>('GET', '/stats');
  }

  /** Enqueue a notification for delivery. */
  async sendNotification(body: SendNotificationRequest): Promise<SendNotificationResponse> {
    return this.request<SendNotificationResponse>('POST', '/notifications', body);
  }

  /** Create a new credential (API key). */
  async createCredential(body: CreateCredentialRequest = {}): Promise<Credential> {
    return this.request<Credential>('POST', '/credentials', body);
  }

  /** List stored credentials. */
  async listCredentials(): Promise<Credential[]> {
    return this.request<Credential[]>('GET', '/credentials');
  }

  /** Revoke a credential by id. */
  async deleteCredential(id: string): Promise<void> {
    await this.request<unknown>('DELETE', `/credentials/${encodeURIComponent(id)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new ApiClientError(
        aborted ? `Request timed out after ${this.timeoutMs}ms` : 'Network request failed',
        0,
        aborted ? 'TIMEOUT' : 'NETWORK_ERROR'
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const errorBody = (parsed && typeof parsed === 'object' ? parsed : undefined) as
        | ApiErrorBody
        | undefined;
      const message =
        errorBody?.message ?? errorBody?.error ?? `Request failed with status ${response.status}`;
      throw new ApiClientError(message, response.status, errorBody?.code, errorBody);
    }

    return parsed as T;
  }
}
