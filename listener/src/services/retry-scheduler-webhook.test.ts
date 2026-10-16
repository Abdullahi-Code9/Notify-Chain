/**
 * RetryScheduler — webhook notification retry tests
 *
 * Covers acceptance criteria from issue #383:
 *  - Failed webhooks (5xx, timeout, network) are queued and retried
 *  - Retry intervals follow exponential backoff
 *  - Exhausted retries are logged as errors
 *  - Successful retries are marked COMPLETED and logged
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RetryScheduler, RETRY_SCHEDULER_DEFAULTS } from './retry-scheduler';
import { WebhookDeliveryService } from './webhook-delivery-service';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../utils/request-id', () => ({ generateRequestId: () => 'test-req-id' }));

// Keep WorkerManager transparent so tests don't need it
jest.mock('./worker-manager', () => ({
  getWorkerManager: () => ({
    isShutdownInProgress: () => false,
    startJob: () => true,
    completeJob: () => {},
    initiateGracefulShutdown: jest.fn().mockImplementation(() => Promise.resolve()),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(overrides: Record<string, any> = {}): any {
  return {
    recoverStaleLocks: jest.fn().mockImplementation(() => Promise.resolve(0)),
    fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([])),
    markAsCompleted: jest.fn().mockImplementation(() => Promise.resolve()),
    markAsFailedOrRetry: jest.fn().mockImplementation(() => Promise.resolve()),
    logExecution: jest.fn().mockImplementation(() => Promise.resolve()),
    initiateGracefulShutdown: jest.fn().mockImplementation(() => Promise.resolve()),
    ...overrides,
  } as any;
}

function makeWebhookNotification(overrides: Record<string, any> = {}) {
  return {
    id: 10,
    payload: JSON.stringify({ event: 'order.created', orderId: 'abc-123' }),
    notificationType: NotificationType.WEBHOOK,
    targetRecipient: 'https://example.com/webhook',
    executeAt: new Date(),
    status: NotificationStatus.PROCESSING,
    retryCount: 1,
    maxRetries: 3,
    priority: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RetryScheduler — webhook retry queue', () => {
  let logger: any;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = (jest.requireMock('../utils/logger') as any).default;
  });

  // ── Successful retry ──────────────────────────────────────────────────────

  describe('successful delivery', () => {
    it('persists a delivered receipt for a successful retry', async () => {
      const notification = makeWebhookNotification();
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });
      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({
          success: true,
          statusCode: 204,
          providerMessageId: 'retry-message-1',
          providerResponse: { statusCode: 204 },
        }),
      } as unknown as WebhookDeliveryService;
      const receiptRepository = { create: jest.fn().mockImplementation(() => Promise.resolve(1)) };

      const scheduler = new RetryScheduler(
        repo,
        RETRY_SCHEDULER_DEFAULTS,
        null,
        webhookService,
        receiptRepository as any,
      );
      await scheduler.runOnce();

      expect(receiptRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        notificationId: 10,
        channel: 'webhook',
        status: 'delivered',
        attemptCount: 2,
        providerMessageId: 'retry-message-1',
        providerResponse: { statusCode: 204 },
      }));
    });

    it('marks the notification COMPLETED when the webhook succeeds', async () => {
      const notification = makeWebhookNotification();
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({ success: true, statusCode: 200 }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      expect(webhookService.deliver).toHaveBeenCalledTimes(1);
      expect(webhookService.deliver).toHaveBeenCalledWith(
        notification.targetRecipient,
        expect.objectContaining({ event: 'order.created' }),
        expect.stringContaining('retry-10'),
      );
      expect(repo.markAsCompleted).toHaveBeenCalledWith(10, 'test-req-id');
    });

    it('logs a success message when the webhook is delivered', async () => {
      const notification = makeWebhookNotification();
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({ success: true, statusCode: 200 }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      expect(logger.info).toHaveBeenCalledWith(
        'Retry succeeded',
        expect.objectContaining({ id: 10 }),
      );
    });

    it('logs a SUCCESS execution record', async () => {
      const notification = makeWebhookNotification();
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({ success: true, statusCode: 200 }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      expect(repo.logExecution).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'SUCCESS', scheduledNotificationId: 10 }),
      );
    });
  });

  // ── Failed delivery → queued for retry ───────────────────────────────────

  describe('failed delivery (retries remaining)', () => {
    it('schedules next retry with backoff when a 5xx response is received', async () => {
      const notification = makeWebhookNotification({ retryCount: 1, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({
          success: false,
          statusCode: 503,
          errorReason: 'HTTP 503',
        }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(
        repo,
        { ...RETRY_SCHEDULER_DEFAULTS, baseDelayMs: 1000, multiplier: 2, jitter: false },
        null,
        webhookService,
      );
      await scheduler.runOnce();

      expect(repo.markAsFailedOrRetry).toHaveBeenCalledWith(
        10,
        expect.any(Error),
        1,   // retryCount passed in
        3,   // maxRetries
        expect.any(Date), // nextRetryAt must be set
      );

      const [, , , , rawNextRetryAt] = (repo.markAsFailedOrRetry as jest.Mock).mock.calls[0];
      const nextRetryAt = rawNextRetryAt as Date;

      expect(nextRetryAt).toBeInstanceOf(Date);
      expect(nextRetryAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('logs a warn with retry details when delivery fails but retries remain', async () => {
      const notification = makeWebhookNotification({ retryCount: 1, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({
          success: false,
          statusCode: 500,
          errorReason: 'HTTP 500',
        }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      expect(logger.warn).toHaveBeenCalledWith(
        'Retry failed, scheduling next attempt',
        expect.objectContaining({ id: 10 }),
      );
    });

    it('records a RETRY execution log when retries remain', async () => {
      const notification = makeWebhookNotification({ retryCount: 1, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({
          success: false,
          statusCode: 502,
          errorReason: 'HTTP 502',
        }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      expect(repo.logExecution).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'RETRY', scheduledNotificationId: 10 }),
      );
    });

    it('propagates the failure error reason into markAsFailedOrRetry', async () => {
      const notification = makeWebhookNotification({ retryCount: 1, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({
          success: false,
          statusCode: 503,
          errorReason: 'HTTP 503',
        }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      const [, rawError] = (repo.markAsFailedOrRetry as jest.Mock).mock.calls[0];
      const error = rawError as Error;

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('HTTP 503');
    });
  });

  // ── Exhausted retries → permanent failure ─────────────────────────────────

  describe('exhausted retries (permanent failure)', () => {
    it('marks notification as permanently failed when max retries are reached', async () => {
      // retryCount = maxRetries - 1 means this is the last attempt
      const notification = makeWebhookNotification({ retryCount: 2, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({
          success: false,
          statusCode: 500,
          errorReason: 'HTTP 500',
        }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      expect(repo.markAsFailedOrRetry).toHaveBeenCalledWith(
        10,
        expect.any(Error),
        2,
        3,
        undefined, // no nextRetryAt when permanently failed
      );
    });

    it('logs an error when max retries are exhausted', async () => {
      const notification = makeWebhookNotification({ retryCount: 2, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({
          success: false,
          statusCode: 500,
          errorReason: 'HTTP 500',
        }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      expect(logger.error).toHaveBeenCalledWith(
        'Notification permanently failed after max retries',
        expect.objectContaining({ id: 10, totalAttempts: 3 }),
      );
    });

    it('records a FAILED execution log when retries are exhausted', async () => {
      const notification = makeWebhookNotification({ retryCount: 2, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({
          success: false,
          statusCode: 504,
          errorReason: 'HTTP 504',
        }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      expect(repo.logExecution).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'FAILED', scheduledNotificationId: 10 }),
      );
    });
  });

  // ── Timeout / network error handling ─────────────────────────────────────

  describe('timeout and network errors', () => {
    it('queues for retry when the webhook service throws (network error)', async () => {
      const notification = makeWebhookNotification({ retryCount: 0, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({
          success: false,
          errorReason: 'Webhook request timed out after 10000ms',
        }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      // Should schedule next retry, not mark as permanently failed
      const [, , , , nextRetryAt] = (repo.markAsFailedOrRetry as jest.Mock).mock.calls[0];
      expect(nextRetryAt).toBeInstanceOf(Date);
    });

    it('does not throw when webhook delivery throws an exception', async () => {
      const notification = makeWebhookNotification({ retryCount: 1, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockRejectedValue(new Error('ECONNREFUSED')),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);

      await expect(scheduler.runOnce()).resolves.not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        'Retry failed, scheduling next attempt',
        expect.objectContaining({ id: 10 }),
      );
    });
  });

  // ── Backoff intervals ─────────────────────────────────────────────────────

  describe('retry interval (backoff)', () => {
    it('sets a future nextRetryAt proportional to the backoff config', async () => {
      const notification = makeWebhookNotification({ retryCount: 1, maxRetries: 5 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({ success: false, statusCode: 503, errorReason: 'HTTP 503' }),
      } as unknown as WebhookDeliveryService;

      const baseDelayMs = 2000;
      const multiplier = 2;
      // With retryCount=1, expected delay = 2000 * 2^1 = 4000 ms (no jitter)
      const scheduler = new RetryScheduler(
        repo,
        { ...RETRY_SCHEDULER_DEFAULTS, baseDelayMs, multiplier, jitter: false },
        null,
        webhookService,
      );

      const before = Date.now();
      await scheduler.runOnce();
      const after = Date.now();

      const [, , , , rawNextRetryAt] = (repo.markAsFailedOrRetry as jest.Mock).mock.calls[0];
      const nextRetryAt = rawNextRetryAt as Date;

      const expectedDelay = baseDelayMs * Math.pow(multiplier, 1); // 4000
      // nextRetryAt should be roughly before + expectedDelay
      expect(nextRetryAt.getTime()).toBeGreaterThanOrEqual(before + expectedDelay - 100);
      expect(nextRetryAt.getTime()).toBeLessThanOrEqual(after + expectedDelay + 100);
    });

    it('does not set nextRetryAt when retries are exhausted', async () => {
      const notification = makeWebhookNotification({ retryCount: 2, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockResolvedValue({ success: false, statusCode: 500, errorReason: 'HTTP 500' }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      const [, , , , nextRetryAt] = (repo.markAsFailedOrRetry as jest.Mock).mock.calls[0];
      expect(nextRetryAt).toBeUndefined();
    });
  });

  // ── Missing targetRecipient ───────────────────────────────────────────────

  describe('configuration errors', () => {
    it('logs error and fails permanently when targetRecipient is missing', async () => {
      const notification = makeWebhookNotification({ targetRecipient: '', retryCount: 0, maxRetries: 3 });
      const repo = makeRepo({ fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])) });

      const webhookService = new WebhookDeliveryService();

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      // A missing target can never succeed, so it is a permanent configuration
      // failure: no nextRetryAt is scheduled, and the budget is collapsed to the
      // attempt that just failed so the row is retired as FAILED instead of
      // being re-picked with next_retry_at = NULL.
      expect(repo.markAsFailedOrRetry).toHaveBeenCalledWith(
        10,
        expect.objectContaining({ message: expect.stringContaining('targetRecipient') }),
        0,
        1,
        undefined,
      );
      expect(logger.error).toHaveBeenCalledWith(
        'Notification failed permanently, not retried',
        expect.objectContaining({ id: 10 }),
      );
    });
  });

  // ── Configurable webhook timeout ──────────────────────────────────────────
  describe('webhook timeout configuration', () => {
    const realFetch = global.fetch;

    afterEach(() => {
      (global as any).fetch = realFetch;
    });

    it('applies the configured webhookTimeoutMs to the outbound request', async () => {
      const notification = makeWebhookNotification();
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      let aborted = false;
      (global as any).fetch = jest.fn().mockImplementation((_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () => {
            aborted = true;
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }),
      );

      const scheduler = new RetryScheduler(repo, {
        ...RETRY_SCHEDULER_DEFAULTS,
        pollIntervalMs: 1000,
        lockTimeoutMs: 1000,
        batchSize: 1,
        webhookTimeoutMs: 25,
      });
      await scheduler.runOnce();

      expect(aborted).toBe(true);
      expect(repo.markAsFailedOrRetry).toHaveBeenCalledWith(
        10,
        expect.objectContaining({ message: expect.stringContaining('timed out after 25ms') }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
