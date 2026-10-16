import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { WebhookDeliveryService } from './webhook-delivery-service';
import { DiscordNotificationService } from './discord-notification';
import { RetryScheduler } from './retry-scheduler';
import { ScheduledNotificationRepository } from './scheduled-notification-repository';
import {
  NotificationStatus,
  NotificationType,
  ScheduledNotification,
} from '../types/scheduled-notification';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = jest.fn() as any;
global.fetch = mockFetch;

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('./worker-manager', () => ({
  getWorkerManager: () => ({
    isShutdownInProgress: () => false,
    startJob: () => true,
    completeJob: () => true,
    initiateGracefulShutdown: async () => {},
  }),
}));

describe('Notification Failure Scenarios (#793)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // 1. Provider Timeout
  // =========================================================================
  describe('1. Provider Timeout', () => {
    it('handles provider timeout in WebhookDeliveryService via AbortError', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      const service = new WebhookDeliveryService({ timeoutMs: 100 });
      const result = await service.deliver('https://api.example.com/webhook', { msg: 'test' });

      expect(result.success).toBe(false);
      expect(result.errorReason).toMatch(/timed out/i);
    });

    it('tracks timeoutCount in DiscordNotificationService on AbortError', async () => {
      const abortError = new Error('Request timed out');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      const service = new DiscordNotificationService({
        webhookUrl: 'https://discord.com/api/webhooks/test',
        webhookId: 'test-webhook-123',
        timeoutMs: 50,
        retryCount: 0,
      });

      const success = await service.sendTestMessage();
      expect(success).toBe(false);
      expect(service.getMetrics().timeoutCount).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // 2. Invalid Response
  // =========================================================================
  describe('2. Invalid Response', () => {
    it('handles corrupted/empty HTTP responses gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: async () => '<html>502 Bad Gateway - upstream died</html>',
      });

      const service = new WebhookDeliveryService();
      const result = await service.deliver('https://api.example.com/webhook', { ping: true });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(502);
      expect(result.errorReason).toBe('HTTP 502');
    });

    it('handles network-level disconnect or DNS resolution failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND invalid-domain.local'));

      const service = new WebhookDeliveryService();
      const result = await service.deliver('https://invalid-domain.local', { data: 123 });

      expect(result.success).toBe(false);
      expect(result.errorReason).toContain('ENOTFOUND');
      expect(result.statusCode).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. Temporary Provider Failure (Retry State)
  // =========================================================================
  describe('3. Temporary Provider Failure', () => {
    it('identifies 5xx as temporary failure eligible for retry in WebhookDeliveryService', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'Service Temporarily Unavailable',
      });

      const service = new WebhookDeliveryService();
      const result = await service.deliver('https://api.example.com/webhook', { foo: 'bar' });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(503);
    });

    it('schedules next retry with backoff and keeps notification in PENDING state', async () => {
      const mockRepo = {
        recoverStaleLocks: (jest.fn() as any).mockResolvedValue(0),
        fetchDueRetries: jest.fn() as any,
        markAsFailedOrRetry: (jest.fn() as any).mockResolvedValue(undefined),
        logExecution: (jest.fn() as any).mockResolvedValue(undefined),
        markAsCompleted: jest.fn() as any,
      } as unknown as ScheduledNotificationRepository;

      const failingNotification: ScheduledNotification = {
        id: 101,
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: 'https://example.com/webhook',
        payload: JSON.stringify({ event: 'test' }),
        executeAt: new Date(),
        status: NotificationStatus.PENDING,
        retryCount: 1,
        maxRetries: 3,
        priority: 1,
      };

      (mockRepo.fetchDueRetries as any).mockResolvedValueOnce([failingNotification]);

      const mockWebhookService = {
        deliver: (jest.fn() as any).mockResolvedValue({
          success: false,
          statusCode: 500,
          errorReason: 'HTTP 500 Internal Server Error',
        }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(
        mockRepo,
        {
          enabled: true,
          baseDelayMs: 1000,
          multiplier: 2,
          jitter: false,
        },
        null,
        mockWebhookService,
      );

      await scheduler.runOnce();

      // Verify repository recorded retry state
      expect(mockRepo.markAsFailedOrRetry).toHaveBeenCalledTimes(1);
      const [id, , priorFailures, maxRetries, nextRetryAt] = (mockRepo.markAsFailedOrRetry as any)
        .mock.calls[0];
      expect(id).toBe(101);
      expect(priorFailures).toBe(1);
      expect(maxRetries).toBe(3);
      expect(nextRetryAt).toBeInstanceOf(Date);
      expect(nextRetryAt.getTime()).toBeGreaterThan(Date.now());

      // Verify execution log status is 'RETRY'
      expect(mockRepo.logExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledNotificationId: 101,
          status: 'RETRY',
          executionAttempt: 2,
        }),
      );
    });
  });

  // =========================================================================
  // 4. Permanent Provider Failure (Terminal Non-Retryable Failure)
  // =========================================================================
  describe('4. Permanent Provider Failure', () => {
    it('classifies HTTP 404/401 client errors as permanent failure in WebhookDeliveryService', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Webhook endpoint not found',
      });

      const service = new WebhookDeliveryService();
      const result = await service.deliver('https://api.example.com/missing', { ping: true });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
      expect(result.errorReason).toBe('HTTP 404');
    });

    it('marks notification failed permanently and routes to dead letter queue', async () => {
      const mockDb = {
        run: (jest.fn() as any).mockResolvedValue({ changes: 1 }),
        get: (jest.fn() as any).mockResolvedValue({
          id: 202,
          notification_type: 'webhook',
          target_recipient: 'https://example.com/invalid-auth',
          payload: '{"test":true}',
          retry_count: 0,
        }),
      };

      const repo = new ScheduledNotificationRepository(mockDb as any);
      const moveToDlqSpy = jest.spyOn(repo, 'moveToDeadLetterQueue').mockResolvedValue(true);

      // Trigger markAsFailedOrRetry with currentRetryCount = 0 and maxRetries = 1 (instant terminal)
      await repo.markAsFailedOrRetry(202, new Error('HTTP 401 Unauthorized'), 0, 1);

      // Verify SQL update set status to FAILED and nullified next_retry_at
      expect(mockDb.run).toHaveBeenCalledTimes(1);
      const [sql, params] = (mockDb.run as any).mock.calls[0];
      expect(sql).toContain('status = ?');
      expect((params as any[])[0]).toBe(NotificationStatus.FAILED);
      expect((params as any[])[4]).toBeNull(); // next_retry_at is null

      // Verify Dead-Letter Queue entry was created
      expect(moveToDlqSpy).toHaveBeenCalledWith(202, expect.any(Error), expect.any(String), 1);
    });
  });

  // =========================================================================
  // 5. Retry Exhaustion (Terminal State)
  // =========================================================================
  describe('5. Retry Exhaustion', () => {
    it('transitions to FAILED terminal status when retryCount + 1 reaches maxRetries', async () => {
      const mockRepo = {
        recoverStaleLocks: (jest.fn() as any).mockResolvedValue(0),
        fetchDueRetries: jest.fn() as any,
        markAsFailedOrRetry: (jest.fn() as any).mockResolvedValue(undefined),
        logExecution: (jest.fn() as any).mockResolvedValue(undefined),
        markAsCompleted: jest.fn() as any,
      } as unknown as ScheduledNotificationRepository;

      const exhaustedNotification: ScheduledNotification = {
        id: 303,
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: 'https://example.com/webhook',
        payload: JSON.stringify({ alert: 'exhaustion-check' }),
        executeAt: new Date(),
        status: NotificationStatus.PENDING,
        retryCount: 2, // 2 prior failures
        maxRetries: 3, // 3 max -> this 3rd attempt exhausts retries
        priority: 1,
      };

      (mockRepo.fetchDueRetries as any).mockResolvedValueOnce([exhaustedNotification]);

      const mockWebhookService = {
        deliver: (jest.fn() as any).mockResolvedValue({
          success: false,
          statusCode: 504,
          errorReason: 'HTTP 504 Gateway Timeout',
        }),
      } as unknown as WebhookDeliveryService;

      const scheduler = new RetryScheduler(
        mockRepo,
        {
          enabled: true,
        },
        null,
        mockWebhookService,
      );

      await scheduler.runOnce();

      // Verify nextRetryAt is undefined (no further retry scheduled)
      expect(mockRepo.markAsFailedOrRetry).toHaveBeenCalledWith(
        303,
        expect.any(Error),
        2,
        3,
        undefined,
      );

      // Verify execution log reflects terminal 'FAILED' status
      expect(mockRepo.logExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledNotificationId: 303,
          status: 'FAILED',
          executionAttempt: 3,
        }),
      );
    });
  });

  // =========================================================================
  // 6. Malformed Notification Data
  // =========================================================================
  describe('6. Malformed Notification Data', () => {
    it('rejects delivery when payload is invalid JSON', async () => {
      const mockRepo = {
        recoverStaleLocks: (jest.fn() as any).mockResolvedValue(0),
        fetchDueRetries: jest.fn() as any,
        markAsFailedOrRetry: (jest.fn() as any).mockResolvedValue(undefined),
        logExecution: (jest.fn() as any).mockResolvedValue(undefined),
      } as unknown as ScheduledNotificationRepository;

      const malformedNotification: ScheduledNotification = {
        id: 404,
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: 'https://example.com/hook',
        payload: '{ not-valid-json: missing-quotes',
        executeAt: new Date(),
        status: NotificationStatus.PENDING,
        retryCount: 0,
        maxRetries: 3,
        priority: 1,
      };

      (mockRepo.fetchDueRetries as any).mockResolvedValueOnce([malformedNotification]);

      const scheduler = new RetryScheduler(mockRepo);
      await scheduler.runOnce();

      expect(mockRepo.markAsFailedOrRetry).toHaveBeenCalledTimes(1);
      const [, error] = (mockRepo.markAsFailedOrRetry as any).mock.calls[0];
      expect(error).toBeInstanceOf(SyntaxError);
    });

    it('rejects webhook delivery when targetRecipient URL is missing or empty', async () => {
      const mockRepo = {
        recoverStaleLocks: (jest.fn() as any).mockResolvedValue(0),
        fetchDueRetries: jest.fn() as any,
        markAsFailedOrRetry: (jest.fn() as any).mockResolvedValue(undefined),
        logExecution: (jest.fn() as any).mockResolvedValue(undefined),
      } as unknown as ScheduledNotificationRepository;

      const notificationMissingUrl: ScheduledNotification = {
        id: 505,
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: '', // Empty target URL
        payload: JSON.stringify({ message: 'hello' }),
        executeAt: new Date(),
        status: NotificationStatus.PENDING,
        retryCount: 0,
        maxRetries: 3,
        priority: 1,
      };

      (mockRepo.fetchDueRetries as any).mockResolvedValueOnce([notificationMissingUrl]);

      const scheduler = new RetryScheduler(mockRepo);
      await scheduler.runOnce();

      expect(mockRepo.markAsFailedOrRetry).toHaveBeenCalledTimes(1);
      const [, error] = (mockRepo.markAsFailedOrRetry as any).mock.calls[0];
      expect(error.message).toMatch(/missing targetRecipient/i);
    });
  });
});
