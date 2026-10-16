/**
 * RetryPolicy unit tests (#842)
 *
 * Covers the three configurable knobs from the issue:
 *   - maximum attempts
 *   - delay / backoff
 *   - eligible failure types (including "permanent failures are not retried")
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  DEFAULT_RETRYABLE_FAILURE_TYPES,
  DEFAULT_RETRY_POLICY,
  DeliveryError,
  RETRY_FAILURE_TYPES,
  RETRY_POLICY_DEFAULTS,
  RetryFailureType,
  RetryPolicy,
  classifyDeliveryFailure,
  classifyError,
  classifyHttpStatus,
  computeBackoffDelay,
  isRetryFailureType,
  parseRetryableFailureTypes,
} from './retry-policy';
import { loadConfig } from '../config';

// ── Failure classification ───────────────────────────────────────────────────

describe('classifyHttpStatus', () => {
  it.each([
    [429, RetryFailureType.RateLimited],
    [408, RetryFailureType.Timeout],
    [401, RetryFailureType.AuthError],
    [403, RetryFailureType.AuthError],
    [404, RetryFailureType.NotFound],
    [410, RetryFailureType.NotFound],
    [400, RetryFailureType.ClientError],
    [422, RetryFailureType.ClientError],
    [500, RetryFailureType.ServerError],
    [502, RetryFailureType.ServerError],
    [503, RetryFailureType.ServerError],
    [504, RetryFailureType.ServerError],
    [599, RetryFailureType.ServerError],
  ])('maps HTTP %i to %s', (status, expected) => {
    expect(classifyHttpStatus(status)).toBe(expected);
  });

  it.each([200, 201, 204, 301, 302])('maps non-failure HTTP %i to Unknown', (status) => {
    expect(classifyHttpStatus(status)).toBe(RetryFailureType.Unknown);
  });

  it.each([undefined, NaN])('maps %s to Unknown', (status) => {
    expect(classifyHttpStatus(status)).toBe(RetryFailureType.Unknown);
  });
});

describe('classifyError', () => {
  it('honours the failureType carried by a DeliveryError', () => {
    expect(classifyError(new DeliveryError('nope', RetryFailureType.AuthError))).toBe(
      RetryFailureType.AuthError,
    );
  });

  it('prefers a DeliveryError failureType over message inspection', () => {
    const err = new DeliveryError('timed out while calling', RetryFailureType.ClientError);
    expect(classifyError(err)).toBe(RetryFailureType.ClientError);
  });

  it('honours a failureType property on a plain error-like object', () => {
    expect(classifyError({ failureType: RetryFailureType.RateLimited })).toBe(
      RetryFailureType.RateLimited,
    );
  });

  it('ignores a failureType property that is not a known failure type', () => {
    expect(classifyError({ failureType: 'made_up' })).toBe(RetryFailureType.Unknown);
  });

  it.each(['AbortError', 'TimeoutError'])('treats %s as a timeout', (name) => {
    expect(classifyError(Object.assign(new Error('aborted'), { name }))).toBe(
      RetryFailureType.Timeout,
    );
  });

  it.each([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'UND_ERR_SOCKET',
  ])('treats Node error code %s as a network failure', (code) => {
    expect(classifyError(Object.assign(new Error('boom'), { code }))).toBe(
      RetryFailureType.NetworkError,
    );
  });

  it('lowercases error codes before matching', () => {
    expect(classifyError(Object.assign(new Error('boom'), { code: 'econnreset' }))).toBe(
      RetryFailureType.NetworkError,
    );
  });

  it.each([
    ['Request timed out', RetryFailureType.Timeout],
    ['The operation was aborted', RetryFailureType.Timeout],
    ['socket hang up', RetryFailureType.NetworkError],
    ['connect ECONNREFUSED 127.0.0.1:443', RetryFailureType.NetworkError],
    ['Webhook notification missing targetRecipient URL', RetryFailureType.ConfigurationError],
    ['Discord service not configured', RetryFailureType.ConfigurationError],
    ['Unsupported notification type: sms', RetryFailureType.ConfigurationError],
    ['something entirely unexpected', RetryFailureType.Unknown],
    ['', RetryFailureType.Unknown],
  ])('classifies message %j as %s', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  it('classifies a bare string error', () => {
    expect(classifyError('ETIMEDOUT')).toBe(RetryFailureType.Timeout);
  });

  it.each([null, undefined, 42, {}, []])('classifies %j as Unknown', (value) => {
    expect(classifyError(value)).toBe(RetryFailureType.Unknown);
  });
});

describe('classifyDeliveryFailure', () => {
  it('prefers an explicit status code over a thrown error', () => {
    expect(
      classifyDeliveryFailure({ statusCode: 503, error: new Error('timed out') }),
    ).toBe(RetryFailureType.ServerError);
  });

  it('falls back to the error when no status code is available', () => {
    expect(classifyDeliveryFailure({ error: Object.assign(new Error('x'), { code: 'EPIPE' }) })).toBe(
      RetryFailureType.NetworkError,
    );
  });

  it.each([{}, { statusCode: undefined, error: undefined }, { statusCode: undefined, error: null }])(
    'returns Unknown for %j',
    (input) => {
      expect(classifyDeliveryFailure(input)).toBe(RetryFailureType.Unknown);
    },
  );
});

// ── Parsing / type guards ────────────────────────────────────────────────────

describe('isRetryFailureType', () => {
  it('accepts every declared failure type', () => {
    for (const type of RETRY_FAILURE_TYPES) {
      expect(isRetryFailureType(type)).toBe(true);
    }
  });

  it.each(['nope', '', null, undefined, 7, {}])('rejects %j', (value) => {
    expect(isRetryFailureType(value)).toBe(false);
  });
});

describe('parseRetryableFailureTypes', () => {
  it.each([undefined, '', '   '])('returns undefined for blank input %j', (input) => {
    expect(parseRetryableFailureTypes(input)).toBeUndefined();
  });

  it('parses a single failure type', () => {
    expect(parseRetryableFailureTypes('timeout')).toEqual([RetryFailureType.Timeout]);
  });

  it('parses a comma-separated list, trimming whitespace and case', () => {
    expect(parseRetryableFailureTypes(' Timeout , server_error,RATE_LIMITED ')).toEqual([
      RetryFailureType.Timeout,
      RetryFailureType.ServerError,
      RetryFailureType.RateLimited,
    ]);
  });

  it('drops empty entries from a trailing or doubled comma', () => {
    expect(parseRetryableFailureTypes('timeout,,server_error,')).toEqual([
      RetryFailureType.Timeout,
      RetryFailureType.ServerError,
    ]);
  });

  it('throws a descriptive error listing supported values for unknown entries', () => {
    expect(() => parseRetryableFailureTypes('timeout,bogus')).toThrow(/Unknown retry failure type/);
    expect(() => parseRetryableFailureTypes('timeout,bogus')).toThrow(/bogus/);
    expect(() => parseRetryableFailureTypes('bogus')).toThrow(
      new RegExp(RETRY_FAILURE_TYPES.join(', ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('reports every unknown entry, not just the first', () => {
    expect(() => parseRetryableFailureTypes('alpha,beta')).toThrow(/alpha, beta/);
  });
});

// ── Defaults ────────────────────────────────────────────────────────────────

describe('RETRY_POLICY_DEFAULTS', () => {
  it('leaves the attempt ceiling unset so per-item budgets stay authoritative', () => {
    expect(RETRY_POLICY_DEFAULTS.maxAttempts).toBeUndefined();
  });

  it('uses an exponential curve with a one hour cap and jitter', () => {
    expect(RETRY_POLICY_DEFAULTS).toMatchObject({
      baseDelayMs: 5_000,
      multiplier: 2,
      maxDelayMs: 3_600_000,
      jitter: true,
    });
  });

  it('retries only transient failure types by default', () => {
    expect([...RETRY_POLICY_DEFAULTS.retryableFailureTypes]).toEqual([
      RetryFailureType.NetworkError,
      RetryFailureType.Timeout,
      RetryFailureType.RateLimited,
      RetryFailureType.ServerError,
      RetryFailureType.Unknown,
    ]);
  });

  it('excludes every permanent failure type from the default set', () => {
    for (const type of [
      RetryFailureType.ClientError,
      RetryFailureType.NotFound,
      RetryFailureType.AuthError,
      RetryFailureType.ConfigurationError,
    ]) {
      expect(DEFAULT_RETRYABLE_FAILURE_TYPES).not.toContain(type);
    }
  });

  it('cannot be mutated through the exported array', () => {
    expect(() => {
      (RETRY_POLICY_DEFAULTS.retryableFailureTypes as RetryFailureType[]).push(
        RetryFailureType.ClientError,
      );
    }).toThrow();
    expect(RETRY_POLICY_DEFAULTS.retryableFailureTypes).not.toContain(RetryFailureType.ClientError);
  });
});

describe('RetryPolicy construction', () => {
  it('falls back to defaults for every omitted field', () => {
    expect(new RetryPolicy().getConfig()).toMatchObject({
      baseDelayMs: RETRY_POLICY_DEFAULTS.baseDelayMs,
      multiplier: RETRY_POLICY_DEFAULTS.multiplier,
      maxDelayMs: RETRY_POLICY_DEFAULTS.maxDelayMs,
      jitter: RETRY_POLICY_DEFAULTS.jitter,
    });
  });

  it('ignores explicitly undefined overrides instead of clobbering defaults', () => {
    const policy = new RetryPolicy({ maxAttempts: undefined, retryableFailureTypes: undefined });
    const config = policy.getConfig();

    expect(config.maxAttempts).toBeUndefined();
    expect(config.retryableFailureTypes).toEqual([...DEFAULT_RETRYABLE_FAILURE_TYPES]);
    expect(config.baseDelayMs).toBe(RETRY_POLICY_DEFAULTS.baseDelayMs);
  });

  it('honours explicit overrides', () => {
    const policy = new RetryPolicy({
      maxAttempts: 4,
      baseDelayMs: 10,
      multiplier: 3,
      maxDelayMs: 20,
      jitter: false,
      retryableFailureTypes: [RetryFailureType.ServerError],
    });

    expect(policy.getConfig()).toMatchObject({
      maxAttempts: 4,
      baseDelayMs: 10,
      multiplier: 3,
      maxDelayMs: 20,
      jitter: false,
    });
  });

  it('returns a defensive copy of the resolved configuration', () => {
    const policy = new RetryPolicy();
    const first = policy.getConfig();
    (first.retryableFailureTypes as RetryFailureType[]).push(RetryFailureType.AuthError);

    expect(policy.getConfig().retryableFailureTypes).not.toContain(RetryFailureType.AuthError);
  });

  it('shares one default policy instance that stays transient-only', () => {
    expect(DEFAULT_RETRY_POLICY.isRetryable(RetryFailureType.ServerError)).toBe(true);
    expect(DEFAULT_RETRY_POLICY.isPermanent(RetryFailureType.AuthError)).toBe(true);
  });
});

// ── Failure eligibility ──────────────────────────────────────────────────────

describe('RetryPolicy failure eligibility', () => {
  it('treats the default transient set as retryable', () => {
    const policy = new RetryPolicy();
    for (const type of DEFAULT_RETRYABLE_FAILURE_TYPES) {
      expect(policy.isRetryable(type)).toBe(true);
      expect(policy.isPermanent(type)).toBe(false);
    }
  });

  it('treats unlisted failure types as permanent', () => {
    const policy = new RetryPolicy();
    for (const type of [
      RetryFailureType.ClientError,
      RetryFailureType.NotFound,
      RetryFailureType.AuthError,
      RetryFailureType.ConfigurationError,
    ]) {
      expect(policy.isRetryable(type)).toBe(false);
      expect(policy.isPermanent(type)).toBe(true);
    }
  });

  it('honours a narrowed retryable set', () => {
    const policy = new RetryPolicy({ retryableFailureTypes: [RetryFailureType.ServerError] });

    expect(policy.isRetryable(RetryFailureType.ServerError)).toBe(true);
    expect(policy.isRetryable(RetryFailureType.Timeout)).toBe(false);
    expect(policy.isRetryable(RetryFailureType.Unknown)).toBe(false);
  });

  it('honours a widened retryable set', () => {
    const policy = new RetryPolicy({
      retryableFailureTypes: [...DEFAULT_RETRYABLE_FAILURE_TYPES, RetryFailureType.AuthError],
    });

    expect(policy.isRetryable(RetryFailureType.AuthError)).toBe(true);
  });

  it('retries nothing when the eligible set is empty', () => {
    const policy = new RetryPolicy({ retryableFailureTypes: [] });

    for (const type of RETRY_FAILURE_TYPES) {
      expect(policy.isPermanent(type)).toBe(true);
    }
  });
});

// ── Maximum attempts ─────────────────────────────────────────────────────────

describe('RetryPolicy.resolveMaxAttempts', () => {
  it('uses the caller-supplied budget when no ceiling is configured', () => {
    const policy = new RetryPolicy();
    expect(policy.resolveMaxAttempts(3)).toBe(3);
    expect(policy.resolveMaxAttempts(7)).toBe(7);
  });

  it('clamps a caller budget that exceeds the ceiling', () => {
    const policy = new RetryPolicy({ maxAttempts: 3 });
    expect(policy.resolveMaxAttempts(7)).toBe(3);
  });

  it('keeps a caller budget that is below the ceiling', () => {
    const policy = new RetryPolicy({ maxAttempts: 10 });
    expect(policy.resolveMaxAttempts(2)).toBe(2);
  });

  it('treats maxAttempts = 1 as "retries disabled"', () => {
    expect(new RetryPolicy({ maxAttempts: 1 }).resolveMaxAttempts(99)).toBe(1);
  });

  it.each([1.9, 3.99])('floors a fractional budget (%s)', (preferred) => {
    expect(new RetryPolicy().resolveMaxAttempts(preferred)).toBe(Math.floor(preferred));
  });

  it.each([0, -5])('never returns fewer than one attempt for budget %s', (preferred) => {
    expect(new RetryPolicy().resolveMaxAttempts(preferred)).toBe(1);
  });

  it.each([0, -5])('never returns fewer than one attempt for ceiling %s', (ceiling) => {
    expect(new RetryPolicy({ maxAttempts: ceiling }).resolveMaxAttempts(5)).toBe(1);
  });

  it('reports an unbounded budget when neither a ceiling nor a preference is given', () => {
    expect(new RetryPolicy().resolveMaxAttempts()).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('uses the ceiling when only a ceiling is given', () => {
    expect(new RetryPolicy({ maxAttempts: 6 }).resolveMaxAttempts()).toBe(6);
  });

  it('exposes the same value through maxAttemptsFor', () => {
    const policy = new RetryPolicy({ maxAttempts: 4 });
    expect(policy.maxAttemptsFor(9)).toBe(4);
    expect(policy.maxAttemptsFor(2)).toBe(2);
  });
});

// ── Delay ────────────────────────────────────────────────────────────────────

describe('computeBackoffDelay', () => {
  it('returns base * multiplier^attempt without jitter', () => {
    expect(computeBackoffDelay(0, 1_000, 2, 60_000, false)).toBe(1_000);
    expect(computeBackoffDelay(1, 1_000, 2, 60_000, false)).toBe(2_000);
    expect(computeBackoffDelay(2, 1_000, 2, 60_000, false)).toBe(4_000);
    expect(computeBackoffDelay(3, 1_000, 2, 60_000, false)).toBe(8_000);
  });

  it('respects a custom multiplier', () => {
    expect(computeBackoffDelay(2, 1_000, 3, 100_000, false)).toBe(9_000);
  });

  it('caps the delay at maxDelayMs', () => {
    expect(computeBackoffDelay(20, 1_000, 2, 5_000, false)).toBe(5_000);
  });

  it('applies ±25 % jitter when enabled', () => {
    const base = computeBackoffDelay(1, 1_000, 2, 60_000, false);
    for (let i = 0; i < 50; i++) {
      const jittered = computeBackoffDelay(1, 1_000, 2, 60_000, true);
      expect(jittered).toBeGreaterThanOrEqual(base * 0.75);
      expect(jittered).toBeLessThanOrEqual(base * 1.25);
    }
  });

  it.each([0, -1, NaN])('treats attempt %s as the first attempt', (attempt) => {
    expect(computeBackoffDelay(attempt, 1_000, 2, 60_000, false)).toBe(1_000);
  });
});

describe('RetryPolicy.computeDelayMs', () => {
  it('mirrors computeBackoffDelay for the configured curve', () => {
    const policy = new RetryPolicy({ baseDelayMs: 250, multiplier: 3, jitter: false });
    expect(policy.computeDelayMs(0)).toBe(250);
    expect(policy.computeDelayMs(1)).toBe(750);
    expect(policy.computeDelayMs(2)).toBe(2_250);
  });

  it('honours the configured cap', () => {
    const policy = new RetryPolicy({
      baseDelayMs: 1_000,
      multiplier: 2,
      maxDelayMs: 3_000,
      jitter: false,
    });
    expect(policy.computeDelayMs(5)).toBe(3_000);
  });
});

// ── Retry decisions ──────────────────────────────────────────────────────────

describe('RetryPolicy.evaluate', () => {
  const jitterless = { jitter: false } as const;

  it('schedules another attempt for a transient failure with budget remaining', () => {
    const decision = new RetryPolicy(jitterless).evaluate(RetryFailureType.ServerError, 1, 3);

    expect(decision).toMatchObject({
      shouldRetry: true,
      reason: 'retryable',
      failureType: RetryFailureType.ServerError,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(decision.delayMs).toBe(RETRY_POLICY_DEFAULTS.baseDelayMs);
  });

  it('grows the delay with each attempt', () => {
    const policy = new RetryPolicy({ ...jitterless, baseDelayMs: 1_000, multiplier: 2 });
    expect(policy.evaluate(RetryFailureType.ServerError, 1, 5).delayMs).toBe(1_000);
    expect(policy.evaluate(RetryFailureType.ServerError, 2, 5).delayMs).toBe(2_000);
    expect(policy.evaluate(RetryFailureType.ServerError, 3, 5).delayMs).toBe(4_000);
  });

  it('reports exhaustion once the attempt budget is used up', () => {
    const decision = new RetryPolicy(jitterless).evaluate(RetryFailureType.ServerError, 3, 3);

    expect(decision).toMatchObject({
      shouldRetry: false,
      reason: 'exhausted',
      failureType: RetryFailureType.ServerError,
      attempt: 3,
      maxAttempts: 3,
    });
    expect(decision.delayMs).toBeUndefined();
  });

  it('does not retry a permanent failure even with budget remaining', () => {
    const decision = new RetryPolicy(jitterless).evaluate(RetryFailureType.NotFound, 1, 10);

    expect(decision).toMatchObject({
      shouldRetry: false,
      reason: 'permanent',
      failureType: RetryFailureType.NotFound,
      attempt: 1,
      maxAttempts: 10,
    });
    expect(decision.delayMs).toBeUndefined();
  });

  it('prefers the permanent reason over exhaustion when both apply', () => {
    const decision = new RetryPolicy(jitterless).evaluate(RetryFailureType.AuthError, 3, 3);
    expect(decision.reason).toBe('permanent');
  });

  it.each([
    RetryFailureType.ClientError,
    RetryFailureType.NotFound,
    RetryFailureType.AuthError,
    RetryFailureType.ConfigurationError,
  ])('never retries %s', (failureType) => {
    const policy = new RetryPolicy(jitterless);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(policy.shouldRetry(failureType, attempt, 5)).toBe(false);
    }
  });

  it('disables retries entirely when maxAttempts is 1', () => {
    const policy = new RetryPolicy({ ...jitterless, maxAttempts: 1 });

    expect(policy.shouldRetry(RetryFailureType.ServerError, 1, 5)).toBe(false);
    expect(policy.evaluate(RetryFailureType.ServerError, 1, 5)).toMatchObject({
      shouldRetry: false,
      reason: 'exhausted',
      maxAttempts: 1,
    });
  });

  it('reports the capped budget in the decision', () => {
    const decision = new RetryPolicy({ ...jitterless, maxAttempts: 2 }).evaluate(
      RetryFailureType.Timeout,
      1,
      9,
    );

    expect(decision.maxAttempts).toBe(2);
    expect(decision.shouldRetry).toBe(true);
  });

  it('retries a failure type that was added to the eligible set', () => {
    const policy = new RetryPolicy({
      ...jitterless,
      retryableFailureTypes: [RetryFailureType.ClientError],
    });

    expect(policy.evaluate(RetryFailureType.ClientError, 1, 3)).toMatchObject({
      shouldRetry: true,
      reason: 'retryable',
    });
    expect(policy.evaluate(RetryFailureType.ServerError, 1, 3).reason).toBe('permanent');
  });

  it.each([0, -2, NaN, undefined])('normalises attempt %s to 1', (attempt) => {
    const decision = new RetryPolicy(jitterless).evaluate(RetryFailureType.ServerError, attempt as number, 3);
    expect(decision.attempt).toBe(1);
  });
});

describe('RetryPolicy.evaluateFailure', () => {
  const policy = new RetryPolicy({ jitter: false });

  it('classifies from a status code', () => {
    expect(policy.evaluateFailure({ statusCode: 503 }, 1, 3)).toMatchObject({
      shouldRetry: true,
      failureType: RetryFailureType.ServerError,
    });
  });

  it('refuses to retry a 404 without spending any budget', () => {
    expect(policy.evaluateFailure({ statusCode: 404 }, 1, 3)).toMatchObject({
      shouldRetry: false,
      reason: 'permanent',
      failureType: RetryFailureType.NotFound,
    });
  });

  it('classifies from a thrown error when no status code is present', () => {
    const err = Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    expect(policy.evaluateFailure({ error: err }, 1, 3)).toMatchObject({
      shouldRetry: true,
      failureType: RetryFailureType.NetworkError,
    });
  });

  it('classifies an unclassifiable delivery as retryable Unknown', () => {
    expect(policy.evaluateFailure({}, 1, 3)).toMatchObject({
      shouldRetry: true,
      failureType: RetryFailureType.Unknown,
    });
  });
});

// ── DeliveryError ────────────────────────────────────────────────────────────

describe('DeliveryError', () => {
  it('is an Error carrying its failure type and status code', () => {
    const err = new DeliveryError('HTTP 404', RetryFailureType.NotFound, { statusCode: 404 });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DeliveryError');
    expect(err.message).toBe('HTTP 404');
    expect(err.failureType).toBe(RetryFailureType.NotFound);
    expect(err.statusCode).toBe(404);
  });

  it('omits statusCode when not supplied', () => {
    expect(new DeliveryError('boom', RetryFailureType.ConfigurationError).statusCode).toBeUndefined();
  });

  it('records the originating error as cause', () => {
    const cause = new Error('root');
    expect(new DeliveryError('wrapped', RetryFailureType.ServerError, { cause }).cause).toBe(cause);
  });
});

// ── Determinism of the jitter bounds under stubbed randomness ────────────────

describe('RetryPolicy jitter bounds', () => {
  const randomSpy = jest.fn();

  beforeEach(() => {
    randomSpy.mockReset();
    randomSpy.mockReturnValue(0);
    jest.spyOn(Math, 'random').mockImplementation(randomSpy as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('applies the -25 % bound at random() = 0', () => {
    expect(new RetryPolicy({ baseDelayMs: 1_000, jitter: true }).computeDelayMs(0)).toBe(750);
  });

  it('applies the +25 % bound at random() = 1', () => {
    randomSpy.mockReturnValue(0.999999);
    expect(new RetryPolicy({ baseDelayMs: 1_000, jitter: true }).computeDelayMs(0)).toBeLessThan(1_250);
  });

  it('returns the exact delay when jitter is disabled', () => {
    expect(new RetryPolicy({ baseDelayMs: 1_000, jitter: false }).computeDelayMs(0)).toBe(1_000);
  });

  it('caps before applying jitter so the ceiling can still be exceeded by at most 25 %', () => {
    randomSpy.mockReturnValue(0);
    expect(new RetryPolicy({ baseDelayMs: 1_000, maxDelayMs: 2_000, jitter: true }).computeDelayMs(9)).toBe(
      1_500,
    );
  });
});

// ── Environment configuration (#842) ─────────────────────────────────────────

describe('retry policy environment configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.RETRY_POLICY_MAX_ATTEMPTS;
    delete process.env.RETRY_POLICY_RETRYABLE_FAILURE_TYPES;
    // CONTRACT_ADDRESSES is required by loadConfig; supply a valid value so the
    // assertions below isolate retry-policy behaviour.
    process.env.CONTRACT_ADDRESSES = JSON.stringify([
      { address: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', events: ['*'] },
    ]);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('falls back to the shipped defaults when nothing is configured', () => {
    const { retryPolicy } = loadConfig();

    expect(retryPolicy?.maxAttempts).toBeUndefined();
    expect(retryPolicy?.retryableFailureTypes).toEqual([...DEFAULT_RETRYABLE_FAILURE_TYPES]);
  });

  it('reads RETRY_POLICY_MAX_ATTEMPTS', () => {
    process.env.RETRY_POLICY_MAX_ATTEMPTS = '4';

    expect(loadConfig().retryPolicy?.maxAttempts).toBe(4);
  });

  it('reads RETRY_POLICY_RETRYABLE_FAILURE_TYPES and normalises spacing and case', () => {
    process.env.RETRY_POLICY_RETRYABLE_FAILURE_TYPES = ' Timeout , NETWORK_ERROR ,timeout';

    expect(loadConfig().retryPolicy?.retryableFailureTypes).toEqual([
      RetryFailureType.Timeout,
      RetryFailureType.NetworkError,
      RetryFailureType.Timeout,
    ]);
  });

  it('lets a permanent failure type be opted back into the retryable set', () => {
    process.env.RETRY_POLICY_RETRYABLE_FAILURE_TYPES = 'network_error,client_error';

    expect(loadConfig().retryPolicy?.retryableFailureTypes).toContain(RetryFailureType.ClientError);
  });

  it('rejects an unknown failure type rather than silently dropping it', () => {
    process.env.RETRY_POLICY_RETRYABLE_FAILURE_TYPES = 'network_error,teapot';

    expect(() => loadConfig()).toThrow(/RETRY_POLICY_RETRYABLE_FAILURE_TYPES is invalid/);
  });

  it('folds the policy ceiling into the retry scheduler config', () => {
    process.env.RETRY_POLICY_MAX_ATTEMPTS = '2';
    process.env.RETRY_POLICY_RETRYABLE_FAILURE_TYPES = 'timeout';

    const { retryScheduler } = loadConfig();

    expect(retryScheduler?.maxAttempts).toBe(2);
    expect(retryScheduler?.retryableFailureTypes).toEqual([RetryFailureType.Timeout]);
  });
});
