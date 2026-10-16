/**
 * Bounded retry helper for transient webhook API failures.
 *
 * Wraps the sendWebhook function with retry logic driven by a {@link RetryPolicy},
 * so the attempt budget, the delay curve and the set of eligible failure types
 * are all configurable rather than hard-coded here.
 *
 * The shipped default policy retries:
 *   - Network/connection errors
 *   - Timeout (AbortError)
 *   - HTTP 429 (Too Many Requests)
 *   - HTTP 500, 502, 503, 504 (Server errors)
 *
 * Permanent client errors (400, 401, 403, 404, 410, 422) are NOT retried: a
 * later attempt would produce the identical rejection, so the response is
 * returned to the caller immediately.
 */

import { sendWebhook, WebhookSendOptions, WebhookFailureReason, isWebhookTimeoutError } from './webhook-sender';
import { RetryFailureType, RetryPolicy, classifyError, classifyHttpStatus } from './retry-policy';

/** Maximum number of retry attempts (not counting the initial attempt). */
const MAX_RETRY_ATTEMPTS = 2;

/** Delay in milliseconds before the first retry. */
const RETRY_DELAY_MS = 1000;

export interface WebhookRetryOptions extends WebhookSendOptions {
  /**
   * Retry policy overrides. Defaults to
   * `{ maxAttempts: 1 + MAX_RETRY_ATTEMPTS, baseDelayMs: RETRY_DELAY_MS, multiplier: 1, jitter: false }`
   * so the historical behaviour is preserved unless a policy is supplied.
   */
  retryPolicy?: ConstructorParameters<typeof RetryPolicy>[0];
}

const DEFAULT_RETRY_POLICY = new RetryPolicy({
  maxAttempts: 1 + MAX_RETRY_ATTEMPTS,
  baseDelayMs: RETRY_DELAY_MS,
  multiplier: 1,
  maxDelayMs: RETRY_DELAY_MS,
  jitter: false,
});

/**
 * Classify a webhook attempt as a specific failure reason, or `null` when it
 * succeeded / did not fail.
 *
* A request timeout is reported as its own `'timeout'` reason rather than
 * being folded into a generic network error, so retry logic and observability
 * can treat (and count) the two separately.
 *
 * @param response - The HTTP response, if one was received
 * @param error - The error thrown, if the request failed before/without a response
 * @param policy - Policy deciding which failure types are retryable
 * @returns the failure reason, or null when the attempt did not fail
 */
export function classifyWebhookFailure(
  response?: Response,
  error?: unknown
): WebhookFailureReason | null {
  // A thrown error means no HTTP response was available. Timeouts are their
  // own reason; everything else is a network-level failure.
  if (error) {
    return isWebhookTimeoutError(error) ? 'timeout' : 'network';
  }

  if (!response || response.ok) {
    return null;
  }

  // Permanent client errors are not worth retrying.
  if (PERMANENT_CLIENT_ERRORS.has(response.status)) {
    return 'http_permanent';
  }

  // Explicit retryable status codes, plus any other 5xx.
  if (RETRYABLE_STATUS_CODES.has(response.status) || response.status >= 500) {
    return 'http_retryable';
  }

  // Other status codes (e.g. redirects, unlisted 4xx) are non-retryable.
  return 'http_permanent';
}

/**
 * Determines if an error or response should trigger a retry.
 *
 * @param response - The HTTP response, if available
 * @param error - The error thrown, if any
 * @returns true if the failure is retryable
 */
function isRetryable(response?: Response, error?: unknown): boolean {
  const reason = classifyWebhookFailure(response, error);
  return reason === 'timeout' || reason === 'network' || reason === 'http_retryable';
}

/**
 * Delay execution for the specified number of milliseconds.
 */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a webhook with bounded, configurable retry logic for transient
 * failures.
 *
 * Makes an initial attempt, then retries while the policy allows: while the
 * attempt budget is not exhausted *and* the failure type is eligible for retry.
 * Each retry is preceded by the policy's backoff delay.
 *
 * @param url - Target webhook URL
 * @param payload - JSON-serializable payload
 * @param opts - Webhook send options (timeout, headers) plus optional retry policy
 * @returns Response object or throws the final error
 * @throws The last error encountered after all retry attempts are exhausted
 */
export async function sendWebhookWithRetry(
  url: string,
  payload: any,
  opts: WebhookRetryOptions = {},
): Promise<Response> {
  const { retryPolicy, ...sendOpts } = opts;
  const policy = retryPolicy ? new RetryPolicy(retryPolicy) : DEFAULT_RETRY_POLICY;

  const maxAttempts = policy.resolveMaxAttempts(1 + MAX_RETRY_ATTEMPTS);

  let lastError: unknown;
  let lastResponse: Response | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await sendWebhook(url, payload, sendOpts);

      // Success case
      if (response.ok) {
        return response;
      }

      // Non-retryable failure (permanent client error)
      if (!isRetryable(response, undefined, policy)) {
        return response;
      }

      lastResponse = response;

      if (attempt < maxAttempts) {
        await delay(policy.computeDelayMs(attempt - 1));
      }
    } catch (error) {
      lastError = error;

      // Permanent failures are returned/raised immediately rather than retried.
      if (!policy.isRetryable(classifyError(error))) {
        throw error;
      }

      // If this was the last attempt, throw the error
      if (attempt === maxAttempts) {
        throw error;
      }

      // Otherwise, delay and retry
      await delay(policy.computeDelayMs(attempt - 1));
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError ?? new Error('All retry attempts failed');
}

/** The failure types the default webhook policy considers retryable. */
export const WEBHOOK_RETRYABLE_FAILURE_TYPES: readonly RetryFailureType[] = DEFAULT_RETRY_POLICY
  .getConfig()
  .retryableFailureTypes;
