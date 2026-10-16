/**
 * WebhookDeliveryService
 *
 * Delivers a generic HTTP webhook payload to a target URL and returns
 * whether the delivery succeeded.  A delivery is considered failed when:
 *   - The HTTP response status is 5xx (server-side error)
 *   - The request times out (AbortError)
 *   - Any network-level error is thrown
 *
 * 4xx responses (client errors) are treated as permanent failures — retrying
 * them would not change the outcome without a payload correction, so they
 * are logged as errors but return `false` to allow the caller (RetryScheduler)
 * to record and exhaust the retry budget rather than looping forever.
 *
 * The RetryScheduler handles all scheduling / backoff logic; this service
 * is intentionally stateless and makes exactly one HTTP attempt per call.
 */

import logger from '../utils/logger';
import {
  sendWebhook,
  WebhookSendOptions,
  WebhookFailureReason,
  isWebhookTimeoutError,
} from './webhook-sender';

/**
 * Default timeout applied to an outbound webhook request when the operator has
 * not configured one. This preserves the timeout the delivery service has
 * always applied implicitly, and is the default for `WEBHOOK_TIMEOUT_MS`.
 */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Upper bound for a configured webhook timeout. A larger value is almost
 * certainly a unit mistake (e.g. milliseconds vs seconds) and would let a
 * hung endpoint tie up a delivery worker for an unreasonable length of time.
 */
export const MAX_WEBHOOK_TIMEOUT_MS = 300_000;

export interface WebhookDeliveryOptions {
  /** Request timeout in milliseconds (default: DEFAULT_WEBHOOK_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Extra headers forwarded to every outbound request. */
  headers?: Record<string, string>;
}

export interface WebhookDeliveryResult {
  /** True when the server responded with a 2xx status code. */
  success: boolean;
  /** HTTP status code, or undefined when a network error occurred. */
  statusCode?: number;
  /** Human-readable failure reason for logging. */
  errorReason?: string;
providerMessageId?: string;
  providerResponse?: Record<string, unknown>;
  errorCode?: string;
  /**
   * Machine-readable failure classification. Distinguishes a request timeout
   * from a generic network error or an HTTP-level failure. Undefined on
   * success.
   */
  failureReason?: WebhookFailureReason;
}

export class WebhookDeliveryService {
  private readonly defaultTimeoutMs: number;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: WebhookDeliveryOptions = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    this.defaultHeaders = options.headers ?? {};
  }

  /**
   * Attempt to deliver `payload` to `targetUrl` via a single HTTP POST.
   *
   * @param targetUrl  - Destination URL.
   * @param payload    - JSON-serialisable body.
   * @param requestId  - Correlation ID for structured logging.
   * @param opts       - Per-call overrides for timeout and headers.
   * @returns          - Delivery result indicating success/failure and reason.
   */
  async deliver(
    targetUrl: string,
    payload: unknown,
    requestId?: string,
    opts: WebhookDeliveryOptions = {},
  ): Promise<WebhookDeliveryResult> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const headers = { ...this.defaultHeaders, ...(opts.headers ?? {}) };

    const sendOpts: WebhookSendOptions = { timeoutMs, headers };

    const logCtx = { requestId, targetUrl };

    logger.info('Delivering webhook', { ...logCtx, timeoutMs });

    const startMs = Date.now();

    try {
      const response = await sendWebhook(targetUrl, payload, sendOpts);
      const durationMs = Date.now() - startMs;
      const providerMessageId = response.headers.get('x-message-id') ?? undefined;
      const providerResponse = { statusCode: response.status };

      if (response.ok) {
        logger.info('Webhook delivered successfully', {
          ...logCtx,
          statusCode: response.status,
          durationMs,
        });
        return { success: true, statusCode: response.status, providerMessageId, providerResponse };
      }

      // 5xx — transient server error, worth retrying
      if (response.status >= 500) {
        logger.warn('Webhook delivery failed with server error (5xx) — will retry', {
          ...logCtx,
          statusCode: response.status,
          durationMs,
        });
        return {
          success: false,
          statusCode: response.status,
          errorReason: `HTTP ${response.status}`,
errorCode: `HTTP_${response.status}`,
          providerMessageId,
          providerResponse,
          failureReason: 'http_retryable',
        };
      }

      // 4xx — client error, permanent failure
      logger.error('Webhook delivery failed with client error (4xx) — no retry', {
        ...logCtx,
        statusCode: response.status,
        durationMs,
      });
      return {
        success: false,
        statusCode: response.status,
        errorReason: `HTTP ${response.status}`,
failureReason: 'http_permanent',
        errorCode: `HTTP_${response.status}`,
        providerMessageId,
        providerResponse,
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const isDnsBlocked = err instanceof Error && err.name === 'DnsRebindingError';
      const isTimeout = isWebhookTimeoutError(err);
      const errorReason = isTimeout
        ? `Webhook request timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);

      if (isDnsBlocked) {
        // DNS rebinding block is a permanent failure — retrying will not help
        logger.error('Webhook delivery blocked by DNS rebinding guard — no retry', {
          ...logCtx,
          hostname: (err as { hostname?: string }).hostname,
          blockedAddress: (err as { blockedAddress?: string }).blockedAddress,
          error: errorReason,
          durationMs,
        });
      } else if (isTimeout) {
        logger.warn('Webhook delivery timed out — will retry', {
          ...logCtx,
          timeoutMs,
          durationMs,
        });
      } else {
        logger.error('Webhook delivery failed with network error — will retry', {
          ...logCtx,
          error: errorReason,
          durationMs,
        });
      }

return {
        success: false,
        errorReason,
        failureReason: isTimeout ? 'timeout' : 'network',
        errorCode: isTimeout
          ? 'TIMEOUT'
          : typeof (err as NodeJS.ErrnoException)?.code === 'string'
            ? (err as NodeJS.ErrnoException).code
            : 'TRANSPORT_ERROR',
      };
    }
  }
}
