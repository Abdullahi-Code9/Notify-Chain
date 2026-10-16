/**
 * Provider-Independent Retry Backoff Configuration.
 *
 * Decouples exponential-backoff parameters (initial delay, max delay,
 * max retries, multiplier, jitter) from any specific notification
 * provider. The same validator, defaults, and delay calculator are
 * reused by the DB-backed retry scheduler, the in-memory retry queue,
 * and the webhook synchronous retry helper — without either of them
 * knowing about each other.
 *
 * Design constraints (enforced by `validateRetryBackoffConfig`):
 *   - Delays are non-negative finite numbers.
 *   - `maxDelayMs >= initialDelayMs` (backoff can only grow or stay flat).
 *   - `maxRetries` has a hard upper bound so retry loops cannot hang
 *     indefinitely, even under pathological configuration.
 *   - `multiplier >= 1` because a multiplier below 1 would *shrink*
 *     delays on each attempt rather than backing off.
 *   - `jitter` is always coerced / validated as a boolean.
 */

import { InputValidator, ValidationError } from './validation';

// ---------------------------------------------------------------------------
// Hard bounds (never exceeded, even by "defaults").
// These exist to guarantee termination of retry loops.
// ---------------------------------------------------------------------------

/** Absolute minimum non-negative initial delay. */
export const MIN_INITIAL_DELAY_MS = 0;
/** Hard upper bound on any retry delay — prevents infinite-hold loops. */
export const MAX_ALLOWED_MAX_DELAY_MS = 24 * 60 * 60 * 1_000; // 24 hours
/** Hard upper bound on the multiplier to prevent overflowing `Math.pow`. */
export const MAX_ALLOWED_MULTIPLIER = 100;
/** Minimum multiplier; below 1 the delay would *decrease* per attempt. */
export const MIN_MULTIPLIER = 1;
/** Hard ceiling on `maxRetries` — protects against accidentally infinite loops. */
export const MAX_ALLOWED_MAX_RETRIES = 1_000;
/** Minimum number of retries (0 is valid — means "first failure is final"). */
export const MIN_RETRIES = 0;
/** Default maximum attempts for consumers that don't specify. */
export const DEFAULT_MAX_RETRIES = 5;
/** Default initial delay for consumers that don't specify. */
export const DEFAULT_INITIAL_DELAY_MS = 5_000;
/** Default max delay cap. */
export const DEFAULT_MAX_DELAY_MS = 60 * 60 * 1_000; // 1 hour
/** Default exponential multiplier. */
export const DEFAULT_MULTIPLIER = 2;
/** Default jitter toggle. */
export const DEFAULT_JITTER = true;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Fully-resolved retry backoff parameters.  Every field is required after
 * passing through `resolveRetryBackoffConfig`; use `PartialRetryBackoffConfig`
 * for inputs that fall back to defaults.
 */
export interface RetryBackoffConfig {
  /** Initial / base delay in ms before the first retry (attempt 2). */
  initialDelayMs: number;
  /**
   * Maximum delay in ms.  The exponential formula is clamped to this value
   * so successive retries never wait longer than the hard cap, even if
   * `base * multiplier^attempt` would grow past it.
   */
  maxDelayMs: number;
  /**
   * Maximum number of *retries* (i.e. additional attempts beyond the
   * initial one).  `maxRetries = 0` means the first failure is final —
   * no retries are scheduled.
   */
  maxRetries: number;
  /** Exponential growth factor.  `delay = initialDelayMs * multiplier^attempt`. */
  multiplier: number;
  /** When true, add ±25 % uniform random jitter to each delay. */
  jitter: boolean;
}

/** Input shape accepted by resolvers — any field may be omitted for default. */
export type PartialRetryBackoffConfig = Partial<RetryBackoffConfig>;

/**
 * Safe, provider-independent defaults that always pass the validator.
 * Guaranteed to be within every hard bound defined above.
 */
export const RETRY_BACKOFF_DEFAULTS: Readonly<RetryBackoffConfig> = Object.freeze({
  initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
  maxRetries: DEFAULT_MAX_RETRIES,
  multiplier: DEFAULT_MULTIPLIER,
  jitter: DEFAULT_JITTER,
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Strictly validates a *fully resolved* backoff configuration and throws a
 * `ValidationError` containing every violated constraint (not just the
 * first).  The caller sees a complete list of problems in a single
 * exception, instead of having to fix-and-restart repeatedly.
 *
 * Intentionally validates `config` *in-place* (after defaults have been
 * merged) so the same function can be reused both by `resolve*` (below)
 * and by tests / config loaders that want to re-assert bounds on
 * already-merged data.
 *
 * @throws ValidationError if any field is missing, out-of-range, or violates
 *   the cross-field ordering invariants (`maxDelayMs >= initialDelayMs`, etc).
 */
export function validateRetryBackoffConfig(config: unknown): asserts config is RetryBackoffConfig {
  const v = new InputValidator();
  const obj = config as Record<string, unknown>;

  // ── Presence + type checks (each field required on resolved config) ───
  v.check(
    typeof obj?.initialDelayMs === 'number' && Number.isFinite(obj.initialDelayMs),
    'initialDelayMs',
    `must be a finite number, received ${describe(obj?.initialDelayMs)}`,
  );
  v.check(
    typeof obj?.maxDelayMs === 'number' && Number.isFinite(obj.maxDelayMs),
    'maxDelayMs',
    `must be a finite number, received ${describe(obj?.maxDelayMs)}`,
  );
  v.check(
    typeof obj?.maxRetries === 'number' && Number.isFinite(obj.maxRetries) && Number.isInteger(obj.maxRetries),
    'maxRetries',
    `must be a finite integer, received ${describe(obj?.maxRetries)}`,
  );
  v.check(
    typeof obj?.multiplier === 'number' && Number.isFinite(obj.multiplier),
    'multiplier',
    `must be a finite number, received ${describe(obj?.multiplier)}`,
  );
  v.check(
    typeof obj?.jitter === 'boolean',
    'jitter',
    `must be a boolean, received ${describe(obj?.jitter)}`,
  );

  // Short-circuit range checks if any field has the wrong type — the
  // comparisons below would otherwise give nonsensical error messages.
  if (v.hasIssues()) {
    v.throwIfInvalid();
    return;
  }

  const cast = config as RetryBackoffConfig;

  // ── Range checks (lower bounds) ────────────────────────────────────────
  v.check(
    cast.initialDelayMs >= MIN_INITIAL_DELAY_MS,
    'initialDelayMs',
    `must be >= ${MIN_INITIAL_DELAY_MS} ms (non-negative), received ${cast.initialDelayMs}`,
  );
  v.check(
    cast.maxDelayMs >= MIN_INITIAL_DELAY_MS,
    'maxDelayMs',
    `must be >= ${MIN_INITIAL_DELAY_MS} ms (non-negative), received ${cast.maxDelayMs}`,
  );
  v.check(
    cast.maxRetries >= MIN_RETRIES,
    'maxRetries',
    `must be >= ${MIN_RETRIES}, received ${cast.maxRetries}`,
  );
  v.check(
    cast.multiplier >= MIN_MULTIPLIER,
    'multiplier',
    `must be >= ${MIN_MULTIPLIER} (multipliers < 1 shrink delays instead of backing off), received ${cast.multiplier}`,
  );

  // ── Range checks (upper / hard bounds) ─────────────────────────────────
  v.check(
    cast.maxDelayMs <= MAX_ALLOWED_MAX_DELAY_MS,
    'maxDelayMs',
    `must be <= ${MAX_ALLOWED_MAX_DELAY_MS} ms (24-hour hard cap to prevent indefinite waits), received ${cast.maxDelayMs}`,
  );
  v.check(
    cast.maxRetries <= MAX_ALLOWED_MAX_RETRIES,
    'maxRetries',
    `must be <= ${MAX_ALLOWED_MAX_RETRIES} (hard cap to prevent infinite retry loops), received ${cast.maxRetries}`,
  );
  v.check(
    cast.multiplier <= MAX_ALLOWED_MULTIPLIER,
    'multiplier',
    `must be <= ${MAX_ALLOWED_MULTIPLIER} to prevent Math.pow overflow, received ${cast.multiplier}`,
  );

  // ── Cross-field ordering invariants ────────────────────────────────────
  v.check(
    cast.maxDelayMs >= cast.initialDelayMs,
    'maxDelayMs',
    `must be >= initialDelayMs; received maxDelayMs=${cast.maxDelayMs} but initialDelayMs=${cast.initialDelayMs}`,
  );

  v.throwIfInvalid();
}

// ---------------------------------------------------------------------------
// Resolver (partial input → fully validated resolved config)
// ---------------------------------------------------------------------------

/**
 * Merges a caller-supplied partial config on top of `RETRY_BACKOFF_DEFAULTS`
 * and strictly validates the result.  If the caller did not specify a
 * value the default is used; if the caller *did* specify a value it is
 * preserved verbatim and validated against the hard bounds.
 *
 * This is the **only** supported way to build a RetryBackoffConfig from
 * partial user input. Constructing the type manually is not recommended
 * because it will bypass validation; instead pass your object through
 * this resolver.
 *
 * @throws ValidationError if any explicitly supplied value violates the
 *   bounds or cross-field invariants defined above.
 */
export function resolveRetryBackoffConfig(
  input: PartialRetryBackoffConfig = {}
): RetryBackoffConfig {
  const merged: RetryBackoffConfig = {
    initialDelayMs:
      input.initialDelayMs !== undefined ? input.initialDelayMs : RETRY_BACKOFF_DEFAULTS.initialDelayMs,
    maxDelayMs:
      input.maxDelayMs !== undefined ? input.maxDelayMs : RETRY_BACKOFF_DEFAULTS.maxDelayMs,
    maxRetries:
      input.maxRetries !== undefined ? input.maxRetries : RETRY_BACKOFF_DEFAULTS.maxRetries,
    multiplier:
      input.multiplier !== undefined ? input.multiplier : RETRY_BACKOFF_DEFAULTS.multiplier,
    jitter: input.jitter !== undefined ? !!input.jitter : RETRY_BACKOFF_DEFAULTS.jitter,
  };

  validateRetryBackoffConfig(merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Shared backoff delay calculator
// ---------------------------------------------------------------------------

/**
 * Computes the delay (in ms) that should elapse before re-attempting a
 * failed notification.
 *
 * Formula (deterministic):
 *   ```
 *   raw      = min(initialDelayMs * multiplier^retryIndex, maxDelayMs)
 *   final    = jitter ? raw * (0.75 + rand() * 0.5) : raw
 *   ```
 *
 * `retryIndex` counts the number of *retries already attempted* — i.e.
 * pass `priorFailures` (0-based), not the absolute attempt number
 * (1-based). For example:
 *   - first retry  (priorFailures = 0) → base * multiplier^0 = initialDelayMs
 *   - second retry (priorFailures = 1) → initialDelayMs * multiplier^1
 *   - third retry  (priorFailures = 2) → initialDelayMs * multiplier^2
 *
 * This function is intentionally pure so it can be unit-tested without
 * mocks; callers are responsible for clamping `retryIndex` / handling
 * maxRetries themselves (it is not the delay calculator's job to end
 * the retry loop, only to give honest delays).
 */
export function calculateBackoffDelay(
  retryIndex: number,
  config: Readonly<RetryBackoffConfig>
): number {
  const base = Math.min(
    config.initialDelayMs * Math.pow(config.multiplier, retryIndex),
    config.maxDelayMs,
  );
  return config.jitter ? base * (0.75 + Math.random() * 0.5) : base;
}

/**
 * Deterministic variant of `calculateBackoffDelay` used by tests and any
 * caller that wants reproducible delays.  Applies the exact same
 * formula but replaces the random jitter with a fixed ±12.5 % (midpoint
 * of the jitter range) so output is 100 % reproducible for a given input.
 */
export function calculateBackoffDelayDeterministic(
  retryIndex: number,
  config: Readonly<RetryBackoffConfig>,
): number {
  const base = Math.min(
    config.initialDelayMs * Math.pow(config.multiplier, retryIndex),
    config.maxDelayMs,
  );
  return config.jitter ? base * 0.875 : base;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Returns true iff `err` is a backoff-config validation error. */
export function isBackoffValidationError(err: unknown): err is ValidationError {
  return err instanceof ValidationError;
}

// Helper for error messages — prints what the caller actually passed.
function describe(value: unknown): string {
  if (value === undefined) return 'undefined (missing)';
  if (value === null) return 'null';
  if (typeof value === 'number') return `number(${value})`;
  if (typeof value === 'string') return `string("${value}")`;
  if (typeof value === 'boolean') return `boolean(${value})`;
  return `${typeof value}`;
}
