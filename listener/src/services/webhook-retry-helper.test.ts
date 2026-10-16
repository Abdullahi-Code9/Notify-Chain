/**
 * Tests for webhook-retry-helper
 *
 * Validates the bounded retry mechanism for transient API failures.
 *
 * Coverage:
 *  - Retryable HTTP failures (429, 500, 502, 503, 504) are retried
 *  - Transient failures eventually succeed after retry
 *  - Permanent client errors (400, 401, 403, 404, 422) are NOT retried
 *  - Network/connection failures are retried
 *  - Retry attempts are bounded (initial + 2 retries = 3 total attempts max)
 *  - Delay occurs between retry attempts
 *  - Retry attempt counts are explicitly validated
 *  - Success responses are returned immediately without retry
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { sendWebhookWithRetry, classifyWebhookFailure } from './webhook-retry-helper';

// ---------------------------------------------------------------------------
// Mock sendWebhook to prevent real HTTP requests
// ---------------------------------------------------------------------------

jest.mock('./webhook-sender', () => ({
  sendWebhook: jest.fn(),
}));

import { sendWebhook } from './webhook-sender';
const mockSendWebhook = sendWebhook as jest.MockedFunction<typeof sendWebhook>;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeResponse(status: number, ok = status >= 200 && status < 300): Response {
  return {
    status,
    ok,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: jest.fn<() => Promise<string>>().mockResolvedValue(''),
  } as unknown as Response;
}

function makeNetworkError(): Error {
  return new Error('ECONNREFUSED');
}

function makeTimeoutError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

const TARGET_URL = 'https://example.com/webhook';
const PAYLOAD = { event: 'test', data: { key: 'value' } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendWebhookWithRetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Successful requests ──────────────────────────────────────────────────

  describe('successful requests (2xx)', () => {
    it('returns the response immediately on success without retrying', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(200));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(mockSendWebhook).toHaveBeenCalledTimes(1);
    });

    it('returns 201 response without retrying', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(201));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe(201);
      expect(mockSendWebhook).toHaveBeenCalledTimes(1);
    });
  });

  // ── Permanent client errors (no retry) ───────────────────────────────────

  describe('permanent client errors (4xx) are NOT retried', () => {
    it.each([400, 401, 403, 404, 422])(
      'returns HTTP %i immediately without retrying',
      async (status) => {
        mockSendWebhook.mockResolvedValue(makeResponse(status, false));

        const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe(status);
        expect(result.ok).toBe(false);
        // Must be called exactly once - no retries for permanent errors
        expect(mockSendWebhook).toHaveBeenCalledTimes(1);
      },
    );
  });

  // ── Retryable server errors (5xx) ────────────────────────────────────────

  describe('retryable server errors (5xx)', () => {
    it.each([429, 500, 502, 503, 504])(
      'retries HTTP %i up to the maximum attempts',
      async (status) => {
        mockSendWebhook.mockResolvedValue(makeResponse(status, false));

        const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe(status);
        expect(result.ok).toBe(false);
        // Should attempt: initial + 2 retries = 3 total
        expect(mockSendWebhook).toHaveBeenCalledTimes(3);
      },
    );

    it('succeeds after retrying a 503 error once', async () => {
      mockSendWebhook
        .mockResolvedValueOnce(makeResponse(503, false))
        .mockResolvedValueOnce(makeResponse(200));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe(200);
      expect(result.ok).toBe(true);
      // First attempt fails, second succeeds
      expect(mockSendWebhook).toHaveBeenCalledTimes(2);
    });

    it('succeeds on the final retry attempt after multiple 500 errors', async () => {
      mockSendWebhook
        .mockResolvedValueOnce(makeResponse(500, false))
        .mockResolvedValueOnce(makeResponse(500, false))
        .mockResolvedValueOnce(makeResponse(200));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe(200);
      expect(result.ok).toBe(true);
      // All 3 attempts used: 2 failures + 1 success
      expect(mockSendWebhook).toHaveBeenCalledTimes(3);
    });

    it('returns the final failed response after exhausting all retry attempts', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(503, false));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe(503);
      expect(result.ok).toBe(false);
      // Maximum attempts: 1 initial + 2 retries = 3
      expect(mockSendWebhook).toHaveBeenCalledTimes(3);
    });
  });

  // ── Network errors (retryable) ───────────────────────────────────────────

  describe('network/connection errors are retried', () => {
    it('retries network errors up to the maximum attempts', async () => {
      mockSendWebhook.mockRejectedValue(makeNetworkError());

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      jest.runAllTimersAsync();

      await expect(promise).rejects.toThrow('ECONNREFUSED');

      // Should retry: 1 initial + 2 retries = 3 total
      expect(mockSendWebhook).toHaveBeenCalledTimes(3);
    });

    it('succeeds after a network error is resolved on retry', async () => {
      mockSendWebhook
        .mockRejectedValueOnce(makeNetworkError())
        .mockResolvedValueOnce(makeResponse(200));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe(200);
      expect(result.ok).toBe(true);
      // First attempt fails with error, second succeeds
      expect(mockSendWebhook).toHaveBeenCalledTimes(2);
    });

    it('retries timeout errors (AbortError)', async () => {
      mockSendWebhook.mockRejectedValue(makeTimeoutError());

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      jest.runAllTimersAsync();

      await expect(promise).rejects.toThrow('The operation was aborted');

      // Should retry: 1 initial + 2 retries = 3 total
      expect(mockSendWebhook).toHaveBeenCalledTimes(3);
    });

    it('succeeds after a timeout is resolved on retry', async () => {
      mockSendWebhook
        .mockRejectedValueOnce(makeTimeoutError())
        .mockRejectedValueOnce(makeTimeoutError())
        .mockResolvedValueOnce(makeResponse(200));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe(200);
      expect(result.ok).toBe(true);
      // 2 timeouts, then success on 3rd attempt
      expect(mockSendWebhook).toHaveBeenCalledTimes(3);
    });
  });

  // ── Retry delay ──────────────────────────────────────────────────────────

  describe('retry delay between attempts', () => {
    it('waits 1000ms between retry attempts', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(503, false));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);

      // First attempt happens immediately
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSendWebhook).toHaveBeenCalledTimes(1);

      // Advance timer by 1000ms to trigger first retry
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockSendWebhook).toHaveBeenCalledTimes(2);

      // Advance timer by another 1000ms to trigger second retry
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockSendWebhook).toHaveBeenCalledTimes(3);

      await promise;
    });

    it('does not delay before the initial attempt', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(200));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);

      // Initial attempt happens immediately
      await Promise.resolve();
      expect(mockSendWebhook).toHaveBeenCalledTimes(1);

      await jest.runAllTimersAsync();
      const result = await promise;
      expect(result.ok).toBe(true);
    });

    it('does not delay after the final attempt', async () => {
      mockSendWebhook
        .mockResolvedValueOnce(makeResponse(503, false))
        .mockResolvedValueOnce(makeResponse(503, false))
        .mockResolvedValueOnce(makeResponse(200));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);

      // Initial attempt happens immediately
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSendWebhook).toHaveBeenCalledTimes(1);

      // First retry after delay
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockSendWebhook).toHaveBeenCalledTimes(2);

      // Second retry after delay (final attempt)
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockSendWebhook).toHaveBeenCalledTimes(3);

      // Should have no more pending timers
      const result = await promise;
      expect(result.ok).toBe(true);
    });
  });

  // ── Bounded attempts ─────────────────────────────────────────────────────

  describe('bounded retry attempts', () => {
    it('enforces maximum of 3 total attempts (1 initial + 2 retries)', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(500, false));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      await jest.runAllTimersAsync();
      await promise;

      // Must not exceed 3 attempts
      expect(mockSendWebhook).toHaveBeenCalledTimes(3);
    });

    it('does not create infinite retry loops', async () => {
      mockSendWebhook.mockRejectedValue(makeNetworkError());

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      jest.runAllTimersAsync();

      await expect(promise).rejects.toThrow();

      // Must stop after maximum attempts
      expect(mockSendWebhook).toHaveBeenCalledTimes(3);
      expect(mockSendWebhook.mock.calls.length).toBeLessThanOrEqual(3);
    });
  });

  // ── Mixed scenarios ──────────────────────────────────────────────────────

  describe('mixed failure scenarios', () => {
    it('retries network error then 503, then succeeds', async () => {
      mockSendWebhook
        .mockRejectedValueOnce(makeNetworkError())
        .mockResolvedValueOnce(makeResponse(503, false))
        .mockResolvedValueOnce(makeResponse(200));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(mockSendWebhook).toHaveBeenCalledTimes(3);
    });

    it('retries 502, then 429, then fails permanently', async () => {
      mockSendWebhook
        .mockResolvedValueOnce(makeResponse(502, false))
        .mockResolvedValueOnce(makeResponse(429, false))
        .mockResolvedValueOnce(makeResponse(429, false));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD);
      await jest.runAllTimersAsync();
      const result = await promise;

      expect(result.status).toBe(429);
      expect(result.ok).toBe(false);
      expect(mockSendWebhook).toHaveBeenCalledTimes(3);
    });
  });

  // ── Options passthrough ──────────────────────────────────────────────────

  describe('options passthrough', () => {
    it('passes timeout options to sendWebhook', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(200));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD, { timeoutMs: 3000 });
      await jest.runAllTimersAsync();
      await promise;

      expect(mockSendWebhook).toHaveBeenCalledWith(
        TARGET_URL,
        PAYLOAD,
        expect.objectContaining({ timeoutMs: 3000 }),
      );
    });

    it('passes custom headers to sendWebhook', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(200));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD, {
        headers: { 'X-Custom': 'value' },
      });
      await jest.runAllTimersAsync();
      await promise;

      expect(mockSendWebhook).toHaveBeenCalledWith(
        TARGET_URL,
        PAYLOAD,
        expect.objectContaining({ headers: { 'X-Custom': 'value' } }),
      );
    });

    it('retries with the same options on each attempt', async () => {
      mockSendWebhook
        .mockResolvedValueOnce(makeResponse(503, false))
        .mockResolvedValueOnce(makeResponse(200));

      const promise = sendWebhookWithRetry(TARGET_URL, PAYLOAD, {
        timeoutMs: 2500,
        headers: { 'X-Retry': 'test' },
      });
      await jest.runAllTimersAsync();
      await promise;

      expect(mockSendWebhook).toHaveBeenNthCalledWith(
        1,
        TARGET_URL,
        PAYLOAD,
        expect.objectContaining({ timeoutMs: 2500, headers: { 'X-Retry': 'test' } }),
      );
      expect(mockSendWebhook).toHaveBeenNthCalledWith(
        2,
        TARGET_URL,
        PAYLOAD,
        expect.objectContaining({ timeoutMs: 2500, headers: { 'X-Retry': 'test' } }),
      );
    });
  });

  // ── Failure classification ────────────────────────────────────────────────

  describe('classifyWebhookFailure', () => {
    it('classifies an AbortError as a timeout', () => {
      expect(classifyWebhookFailure(undefined, makeTimeoutError())).toBe('timeout');
    });

    it('classifies a TimeoutError as a timeout', () => {
      const err = new Error('request timed out');
      err.name = 'TimeoutError';

      expect(classifyWebhookFailure(undefined, err)).toBe('timeout');
    });

    it('classifies a generic error as a network failure (not a timeout)', () => {
      expect(classifyWebhookFailure(undefined, makeNetworkError())).toBe('network');
    });

    it('does not treat a message mentioning "timeout" as a timeout', () => {
      // Only the error name marks an abort; a generic message must not be
      // mistaken for a timeout, otherwise retry/observability cannot tell them apart.
      expect(classifyWebhookFailure(undefined, new Error('timeout'))).toBe('network');
    });

    it('classifies retryable HTTP statuses', () => {
      for (const status of [429, 500, 502, 503, 504]) {
        expect(classifyWebhookFailure(makeResponse(status, false))).toBe('http_retryable');
      }
    });

    it('classifies permanent client errors', () => {
      for (const status of [400, 401, 403, 404, 422]) {
        expect(classifyWebhookFailure(makeResponse(status, false))).toBe('http_permanent');
      }
    });

    it('returns null for a successful response', () => {
      expect(classifyWebhookFailure(makeResponse(200))).toBeNull();
    });
  });
});
