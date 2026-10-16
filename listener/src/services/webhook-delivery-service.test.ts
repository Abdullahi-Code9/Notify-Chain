/**
 * Tests for WebhookDeliveryService
 *
 * Covers:
 *  - Successful 2xx delivery
 *  - 5xx responses are treated as retryable failures (warn log)
 *  - 4xx responses are treated as permanent failures (error log)
 *  - Request timeouts (AbortError) are retryable (warn log)
 *  - Network errors are retryable (error log)
 *  - Correct fields in returned WebhookDeliveryResult
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { WebhookDeliveryService } from './webhook-delivery-service';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock sendWebhook so no real HTTP requests are made
// ---------------------------------------------------------------------------

jest.mock('./webhook-sender', () => ({
  sendWebhook: jest.fn(),
}));

import { sendWebhook } from './webhook-sender';
const mockSendWebhook = sendWebhook as jest.MockedFunction<typeof sendWebhook>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(status: number, ok = status >= 200 && status < 300): Response {
  return { status, ok, text: jest.fn<() => Promise<string>>().mockResolvedValue('') } as unknown as Response;
}

function makeAbortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

const TARGET_URL = 'https://example.com/webhook';
const PAYLOAD = { event: 'test', data: { key: 'value' } };
const REQUEST_ID = 'req-test-001';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let logger: ReturnType<typeof jest.requireMock<{ default: Record<string, jest.Mock> }>>['default'];

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WebhookDeliveryService({ timeoutMs: 5000 });
    logger = (jest.requireMock('../utils/logger') as any).default;
  });

  // ── Success ──────────────────────────────────────────────────────────────

  describe('successful delivery (2xx)', () => {
    it('returns success: true for a 200 response', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(200));

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.errorReason).toBeUndefined();
    });

    it('returns success: true for a 201 response', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(201));

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(201);
    });

    it('logs an info message on successful delivery', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(200));

      await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(logger.info).toHaveBeenCalledWith(
        'Webhook delivered successfully',
        expect.objectContaining({ requestId: REQUEST_ID, targetUrl: TARGET_URL, statusCode: 200 }),
      );
    });

    it('passes the payload and options to sendWebhook', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(200));

      await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID, { timeoutMs: 3000 });

      expect(mockSendWebhook).toHaveBeenCalledWith(
        TARGET_URL,
        PAYLOAD,
        expect.objectContaining({ timeoutMs: 3000 }),
      );
    });
  });

  // ── 5xx — retryable ──────────────────────────────────────────────────────

  describe('5xx server errors (retryable)', () => {
    it.each([500, 502, 503, 504])(
      'returns success: false for HTTP %i',
      async (status) => {
        mockSendWebhook.mockResolvedValue(makeResponse(status, false));

        const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

        expect(result.success).toBe(false);
        expect(result.statusCode).toBe(status);
        expect(result.errorReason).toBe(`HTTP ${status}`);
      },
    );

    it('logs a warn (not error) for 5xx so the caller knows to retry', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(503, false));

      await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(logger.warn).toHaveBeenCalledWith(
        'Webhook delivery failed with server error (5xx) — will retry',
        expect.objectContaining({ statusCode: 503 }),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  // ── 4xx — permanent failure ───────────────────────────────────────────────

  describe('4xx client errors (permanent failure)', () => {
    it.each([400, 401, 403, 404, 422])(
      'returns success: false for HTTP %i',
      async (status) => {
        mockSendWebhook.mockResolvedValue(makeResponse(status, false));

        const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

        expect(result.success).toBe(false);
        expect(result.statusCode).toBe(status);
        expect(result.errorReason).toBe(`HTTP ${status}`);
      },
    );

    it('logs an error (not warn) for 4xx to signal permanent failure', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(404, false));

      await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(logger.error).toHaveBeenCalledWith(
        'Webhook delivery failed with client error (4xx) — no retry',
        expect.objectContaining({ statusCode: 404 }),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // ── Timeout (AbortError) — retryable ─────────────────────────────────────

  describe('request timeout (AbortError)', () => {
    it('returns success: false when the request times out', async () => {
      mockSendWebhook.mockRejectedValue(makeAbortError());

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBeUndefined();
      expect(result.errorReason).toMatch(/timed out/i);
    });

    it('logs a warn for timeouts so the caller knows to retry', async () => {
      mockSendWebhook.mockRejectedValue(makeAbortError());

      await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID, { timeoutMs: 2000 });

      expect(logger.warn).toHaveBeenCalledWith(
        'Webhook delivery timed out — will retry',
        expect.objectContaining({ requestId: REQUEST_ID, timeoutMs: 2000 }),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('includes the configured timeout in the errorReason', async () => {
      mockSendWebhook.mockRejectedValue(makeAbortError());

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID, { timeoutMs: 7500 });

      expect(result.errorReason).toContain('7500ms');
    });
  });

  // ── Network error — retryable ─────────────────────────────────────────────

  describe('network / unexpected errors (retryable)', () => {
    it('returns success: false on a generic network error', async () => {
      mockSendWebhook.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe('ECONNREFUSED');
    });

    it('logs an error for non-timeout network failures', async () => {
      mockSendWebhook.mockRejectedValue(new Error('ECONNRESET'));

      await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(logger.error).toHaveBeenCalledWith(
        'Webhook delivery failed with network error — will retry',
        expect.objectContaining({ requestId: REQUEST_ID, error: 'ECONNRESET' }),
      );
    });

    it('handles non-Error thrown values gracefully', async () => {
      mockSendWebhook.mockRejectedValue('string rejection');

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe('string rejection');
    });
  });

  // ── Default options ───────────────────────────────────────────────────────

  describe('default options', () => {
    it('uses the instance-level timeout when none provided per-call', async () => {
      const svc = new WebhookDeliveryService({ timeoutMs: 8000 });
      mockSendWebhook.mockResolvedValue(makeResponse(200));

      await svc.deliver(TARGET_URL, PAYLOAD);

      expect(mockSendWebhook).toHaveBeenCalledWith(
        TARGET_URL,
        PAYLOAD,
        expect.objectContaining({ timeoutMs: 8000 }),
      );
    });

    it('merges instance headers with per-call headers', async () => {
      const svc = new WebhookDeliveryService({ headers: { 'X-Source': 'notify-chain' } });
      mockSendWebhook.mockResolvedValue(makeResponse(200));

      await svc.deliver(TARGET_URL, PAYLOAD, undefined, { headers: { 'X-Request-Id': 'abc' } });

      expect(mockSendWebhook).toHaveBeenCalledWith(
        TARGET_URL,
        PAYLOAD,
        expect.objectContaining({
          headers: { 'X-Source': 'notify-chain', 'X-Request-Id': 'abc' },
        }),
      );
    });
  });

  // ── Machine-readable failure classification ──────────────────────────────

  describe('failure classification', () => {
    it('labels a request timeout as "timeout"', async () => {
      mockSendWebhook.mockRejectedValue(makeAbortError());

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(result.failureReason).toBe('timeout');
    });

    it('labels a TimeoutError as "timeout"', async () => {
      const err = new Error('request timed out');
      err.name = 'TimeoutError';
      mockSendWebhook.mockRejectedValue(err);

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(result.failureReason).toBe('timeout');
    });

    it('labels a generic network error as "network"', async () => {
      mockSendWebhook.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(result.failureReason).toBe('network');
      expect(result.failureReason).not.toBe('timeout');
    });

    it('labels a 5xx response as "http_retryable"', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(503, false));

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(result.failureReason).toBe('http_retryable');
    });

    it('labels a 4xx response as "http_permanent"', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(404, false));

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(result.failureReason).toBe('http_permanent');
    });

    it('leaves failureReason undefined on success', async () => {
      mockSendWebhook.mockResolvedValue(makeResponse(200));

      const result = await service.deliver(TARGET_URL, PAYLOAD, REQUEST_ID);

      expect(result.failureReason).toBeUndefined();
    });
  });
});
