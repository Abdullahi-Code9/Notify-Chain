/**
 * RetryPolicy — single source of truth for notification retry behaviour.
 *
 * Every retry path in the listener (RetryScheduler, NotificationRetryQueue,
 * EventProcessingQueue, the webhook retry helper and the Discord sender) used to
 * hard-code its own budget, backoff curve and failure handling, so a permanent
 * failure such as an HTTP 404 or a misconfigured webhook URL was retried until
 * the budget ran out. `RetryPolicy` makes all three knobs configurable:
 *
 *   1. **Maximum attempts** — an optional hard ceiling on delivery attempts.
 *      Set it to `1` to disable retries process-wide.
 *   2. **Delay** — exponential backoff (`baseDelayMs * multiplier^attempt`),
 *      capped at `maxDelayMs` with optional ±25 % jitter.
 *   3. **Eligible failure types** — only the failure types listed in
 *      `retryableFailureTypes` are retried; everything else fails immediately.
 *
 * See `RETRY_POLICY_DEFAULTS` for the shipped defaults and
 * `ENVIRONMENT_VARIABLES_AND_SECRETS.md` for the corresponding env vars.
 */

/**
 * Coarse classification of a delivery failure.
 *
 * The classification is deliberately transport-focused: it is the only signal
 * the retry paths need to answer "could a later attempt plausibly succeed?".
 */
export enum RetryFailureType {
  /** Socket/DNS/TLS level failure — connection refused, reset, unresolvable host. */
  NetworkError = 'network_error',
  /** Request exceeded its deadline (`AbortError` / `TimeoutError`). */
  Timeout = 'timeout',
  /** Upstream throttled us — HTTP 429. */
  RateLimited = 'rate_limited',
  /** Upstream returned 5xx. */
  ServerError = 'server_error',
  /** Upstream rejected the payload — other 4xx statuses. */
  ClientError = 'client_error',
  /** Target does not exist — HTTP 404, or a deleted Discord webhook. */
  NotFound = 'not_found',
  /** Credentials missing, expired or insufficient — HTTP 401/403. */
  AuthError = 'auth_error',
  /** Local misconfiguration — missing target URL, unsupported channel, bad payload. */
  ConfigurationError = 'configuration_error',
  /** Delivery was signalled as failed but carried no usable signal. */
  Unknown = 'unknown',
}

/** Every `RetryFailureType` value, in declaration order. */
export const RETRY_FAILURE_TYPES: readonly RetryFailureType[] = Object.freeze(
  Object.values(RetryFailureType),
);

/**
 * Failure types retried when an operator has not narrowed the policy.
 *
 * `Unknown` is included deliberately: it preserves the historical behaviour of
 * retrying unclassified failures rather than silently dropping notifications.
 * Everything that is unambiguously permanent (auth, not-found, client and
 * configuration errors) is excluded.
 */
export const DEFAULT_RETRYABLE_FAILURE_TYPES: readonly RetryFailureType[] = Object.freeze([
  RetryFailureType.NetworkError,
  RetryFailureType.Timeout,
  RetryFailureType.RateLimited,
  RetryFailureType.ServerError,
  RetryFailureType.Unknown,
]);

/** Why a retry was or was not scheduled. */
export type RetryDecisionReason =
  /** The failure is eligible for retry and attempts remain. */
  | 'retryable'
  /** The attempt budget has been used up. */
  | 'exhausted'
  /** The failure type is permanent — a retry cannot change the outcome. */
  | 'permanent';

export interface RetryDecision {
  /** Whether another delivery attempt should be made. */
  shouldRetry: boolean;
  /** Machine-readable explanation, suitable for logs and metrics labels. */
  reason: RetryDecisionReason;
  /** The failure type the decision was based on. */
  failureType: RetryFailureType;
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Total attempts allowed, after applying the policy ceiling. */
  maxAttempts: number;
  /**
   * Backoff before the next attempt. Only set when `shouldRetry` is true.
   * Left `undefined` when the policy disables jitter so callers can compute an
   * exact timestamp.
   */
  delayMs?: number;
}

export interface RetryPolicyConfig {
  /**
   * Hard ceiling on total delivery attempts, including the first one.
   * `undefined` (the default) means the caller-supplied budget is authoritative.
   * A value of `1` disables retries entirely.
   */
  maxAttempts?: number;
  /** Backoff base delay in ms. Delay for attempt `n` is `baseDelayMs * multiplier^n`. */
  baseDelayMs: number;
  /** Exponential growth factor applied per attempt. Must be >= 1. */
  multiplier: number;
  /** Upper bound for the computed delay in ms. */
  maxDelayMs: number;
  /** Apply ±25 % random jitter to the computed delay to avoid thundering herds. */
  jitter: boolean;
  /** Failure types eligible for retry. All others fail on the first attempt. */
  retryableFailureTypes: readonly RetryFailureType[];
}

export const RETRY_POLICY_DEFAULTS: RetryPolicyConfig = Object.freeze({
  maxAttempts: undefined,
  baseDelayMs: 5_000,
  multiplier: 2,
  maxDelayMs: 60 * 60 * 1_000,
  jitter: true,
  retryableFailureTypes: DEFAULT_RETRYABLE_FAILURE_TYPES,
});

/**
 * Error carrying an explicit {@link RetryFailureType} so a delivery attempt can
 * report *why* it failed instead of leaving the retry path to guess.
 */
export class DeliveryError extends Error {
  readonly failureType: RetryFailureType;
  readonly statusCode?: number;
  /** The lower-level failure this error wraps, when there was one. */
  readonly cause?: unknown;

  constructor(
    message: string,
    failureType: RetryFailureType,
    options: { statusCode?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'DeliveryError';
    this.failureType = failureType;
    if (options.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Narrow an unknown value to a {@link RetryFailureType}, if it is one. */
export function isRetryFailureType(value: unknown): value is RetryFailureType {
  return typeof value === 'string' && (RETRY_FAILURE_TYPES as readonly string[]).includes(value);
}

/**
 * Map an HTTP status code onto a failure type.
 *
 * Retrying only helps when the upstream condition is likely to clear, so 429
 * and 5xx map to transient types while 401/403/404 and other 4xx map to
 * permanent ones. 1xx/2xx/3xx have no failure meaning and yield `Unknown`.
 */
export function classifyHttpStatus(status: number | undefined): RetryFailureType {
  if (typeof status !== 'number' || Number.isNaN(status)) {
    return RetryFailureType.Unknown;
  }
  if (status === 429) return RetryFailureType.RateLimited;
  if (status === 408) return RetryFailureType.Timeout;
  if (status === 401 || status === 403) return RetryFailureType.AuthError;
  if (status === 404 || status === 410) return RetryFailureType.NotFound;
  if (status >= 500) return RetryFailureType.ServerError;
  if (status >= 400) return RetryFailureType.ClientError;
  return RetryFailureType.Unknown;
}

/**
 * Map a thrown value onto a failure type.
 *
 * Honours {@link DeliveryError} first, then the well-known abort/timeout error
 * shapes produced by `fetch` and Node's networking stack, and falls back to
 * inspecting the message for the handful of transient codes that surface as
 * generic `Error`s. Anything unrecognised is `Unknown`, which is retryable by
 * default.
 */
export function classifyError(error: unknown): RetryFailureType {
  if (error instanceof DeliveryError) {
    return error.failureType;
  }

  if (error && typeof error === 'object') {
    const candidate = error as { name?: unknown; code?: unknown; failureType?: unknown };

    if (isRetryFailureType(candidate.failureType)) {
      return candidate.failureType;
    }

    if (typeof candidate.name === 'string') {
      if (candidate.name === 'AbortError' || candidate.name === 'TimeoutError') {
        return RetryFailureType.Timeout;
      }
    }

    if (typeof candidate.code === 'string') {
      const code = candidate.code.toUpperCase();
      if (TRANSIENT_ERROR_CODES.has(code)) {
        return RetryFailureType.NetworkError;
      }
    }
  }

  if (typeof error === 'string') {
    return classifyByMessage(error);
  }

  if (error instanceof Error) {
    return classifyByMessage(error.message);
  }

  return RetryFailureType.Unknown;
}

/** Node/libuv error codes that always indicate a transient network condition. */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

function classifyByMessage(message: string): RetryFailureType {
  const normalized = message.toLowerCase();

  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('aborted') ||
    normalized.includes('etimedout')
  ) {
    return RetryFailureType.Timeout;
  }

  if (
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('socket hang up') ||
    normalized.includes('network error')
  ) {
    return RetryFailureType.NetworkError;
  }

  // An abort raised by our own timeout controller is a timeout, not a
  // configuration problem, even though the caller's message mentions "aborted".
  if (normalized.includes('missing targetrecipient')) {
    return RetryFailureType.ConfigurationError;
  }

  if (normalized.includes('not configured') || normalized.includes('unsupported notification type')) {
    return RetryFailureType.ConfigurationError;
  }

  return RetryFailureType.Unknown;
}

/**
 * Classify a delivery outcome that may carry either a status code, an error, or
 * both. An explicit status code takes precedence because it is the most precise
 * signal available.
 */
export function classifyDeliveryFailure(input: {
  statusCode?: number;
  error?: unknown;
}): RetryFailureType {
  if (typeof input.statusCode === 'number') {
    return classifyHttpStatus(input.statusCode);
  }
  if (input.error !== undefined && input.error !== null) {
    return classifyError(input.error);
  }
  return RetryFailureType.Unknown;
}

/**
 * Parse a comma-separated list of failure types (the format used by
 * `RETRY_POLICY_RETRYABLE_FAILURE_TYPES`).
 *
 * @returns the parsed types, or `undefined` when the input is blank.
 * @throws when any entry is not a known {@link RetryFailureType}.
 */
export function parseRetryableFailureTypes(
  raw: string | undefined,
): RetryFailureType[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  const parsed = trimmed
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (parsed.length === 0) return undefined;

  const unknownEntries = parsed.filter((entry) => !isRetryFailureType(entry));
  if (unknownEntries.length > 0) {
    throw new Error(
      `Unknown retry failure type(s): ${unknownEntries.join(', ')}. ` +
        `Supported values: ${RETRY_FAILURE_TYPES.join(', ')}.`,
    );
  }

  return parsed as RetryFailureType[];
}

/**
 * Exponential backoff with optional jitter — the one place the curve is defined.
 *
 * `delay = min(baseDelayMs * multiplier^attempt, maxDelayMs)`, then
 * `delay *= (0.75 + Math.random() * 0.5)` (±25 %) when jitter is enabled.
 *
 * @param attempt - 0-based index of the attempt that just failed.
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  multiplier: number,
  maxDelayMs: number,
  jitter: boolean,
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const raw = Math.min(baseDelayMs * Math.pow(multiplier, safeAttempt), maxDelayMs);
  return jitter ? raw * (0.75 + Math.random() * 0.5) : raw;
}

/** Resolves, for a single item, whether and when to retry a failed delivery. */
export class RetryPolicy {
  private readonly config: RetryPolicyConfig;
  private readonly retryable: ReadonlySet<RetryFailureType>;

  constructor(config: Partial<RetryPolicyConfig> = {}) {
    // Callers routinely forward optional fields that may be explicitly
    // `undefined` (e.g. `{ maxAttempts: maybeCeiling }`), so drop those keys
    // instead of letting them overwrite a default with `undefined`.
    const defined = Object.fromEntries(
      Object.entries(config).filter(([, value]) => value !== undefined),
    ) as Partial<RetryPolicyConfig>;

    this.config = { ...RETRY_POLICY_DEFAULTS, ...defined };
    this.retryable = new Set(this.config.retryableFailureTypes);
  }

  /** The effective configuration, useful for logging and `/health` style output. */
  getConfig(): RetryPolicyConfig {
    return { ...this.config, retryableFailureTypes: [...this.retryable] };
  }

  /** Whether a failure type is eligible for retry under this policy. */
  isRetryable(failureType: RetryFailureType): boolean {
    return this.retryable.has(failureType);
  }

  /** Whether a failure type can never succeed on a later attempt. */
  isPermanent(failureType: RetryFailureType): boolean {
    return !this.retryable.has(failureType);
  }

  /**
   * Apply the policy ceiling to a caller-supplied attempt budget.
   *
   * @param preferred - The caller's own budget (e.g. a notification's
   *   `maxRetries`, or a queue default). Used as-is when the policy sets no
   *   ceiling, otherwise clamped to the ceiling. A missing or non-finite value
   *   is treated as "no caller preference", which leaves the policy ceiling in
   *   charge — or, when no ceiling is configured, means "unbounded".
   * @returns A whole number of attempts, never below 1.
   */
  resolveMaxAttempts(preferred?: number): number {
    const ceiling = this.config.maxAttempts;
    const ceilingValue =
      ceiling === undefined || !Number.isFinite(ceiling)
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, Math.floor(ceiling));

    const budget =
      preferred === undefined || !Number.isFinite(preferred)
        ? ceilingValue
        : Math.max(1, Math.floor(preferred));

    return Math.min(budget, ceilingValue);
  }

  /** Total attempts allowed for `preferred`, after applying the ceiling. */
  maxAttemptsFor(preferred?: number): number {
    return this.resolveMaxAttempts(preferred);
  }

  /**
   * Backoff delay before the next attempt.
   *
   * @param attempt - 0-based index of the attempt that just failed.
   * @see computeBackoffDelay
   */
  computeDelayMs(attempt: number): number {
    return computeBackoffDelay(
      attempt,
      this.config.baseDelayMs,
      this.config.multiplier,
      this.config.maxDelayMs,
      this.config.jitter,
    );
  }

  /**
   * Decide whether a failed attempt should be followed by another one.
   *
   * Permanent failure types are rejected before the attempt budget is
   * consulted, so an exhausted budget is never the reason a permanent failure
   * stops — `reason: 'permanent'` is always reported as such.
   *
   * @param failureType - Classification of the failure that just occurred.
   * @param attempt - 1-based index of the attempt that just failed.
   * @param preferredMaxAttempts - Caller's own attempt budget.
   */
  evaluate(
    failureType: RetryFailureType,
    attempt: number,
    preferredMaxAttempts: number,
  ): RetryDecision {
    const maxAttempts = this.resolveMaxAttempts(preferredMaxAttempts);
    const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;

    if (this.isPermanent(failureType)) {
      return { shouldRetry: false, reason: 'permanent', failureType, attempt: safeAttempt, maxAttempts };
    }

    if (safeAttempt >= maxAttempts) {
      return { shouldRetry: false, reason: 'exhausted', failureType, attempt: safeAttempt, maxAttempts };
    }

    return {
      shouldRetry: true,
      reason: 'retryable',
      failureType,
      attempt: safeAttempt,
      maxAttempts,
      delayMs: this.computeDelayMs(safeAttempt - 1),
    };
  }

  /**
   * Convenience wrapper for callers that only hold a raw failure. Classifies
   * with {@link classifyDeliveryFailure} and delegates to {@link evaluate}.
   */
  evaluateFailure(
    input: { statusCode?: number; error?: unknown },
    attempt: number,
    preferredMaxAttempts: number,
  ): RetryDecision {
    return this.evaluate(classifyDeliveryFailure(input), attempt, preferredMaxAttempts);
  }

  /** True when `failureType` is eligible for retry and attempts remain. */
  shouldRetry(failureType: RetryFailureType, attempt: number, preferredMaxAttempts: number): boolean {
    return this.evaluate(failureType, attempt, preferredMaxAttempts).shouldRetry;
  }
}

/** Shared policy used when a caller does not supply its own. */
export const DEFAULT_RETRY_POLICY = new RetryPolicy();
