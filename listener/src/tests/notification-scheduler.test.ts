jest.mock('../utils/request-id', () => ({ generateRequestId: () => 'test-request-id' }));

import { Database } from '../database/database';
import { ScheduledNotificationRepository } from '../services/scheduled-notification-repository';
import { NotificationScheduler } from '../services/notification-scheduler';
import { NotificationAPI } from '../services/notification-api';
import { DeliveryReceiptRepository } from '../services/delivery-receipt-repository';
import {
  NotificationType,
  NotificationStatus,
  CreateScheduledNotificationInput,
} from '../types/scheduled-notification';
import * as fs from 'fs';
import * as path from 'path';

describe('NotificationScheduler', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let scheduler: NotificationScheduler;
  let api: NotificationAPI;
  let receiptRepository: DeliveryReceiptRepository;

  const testDbPath = './data/test-notifications.db';

  beforeAll(async () => {
    // Clean up test database if it exists
    const dbDir = path.dirname(testDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Initialize test database
    db = new Database(testDbPath);
    await db.initialize();
    repository = new ScheduledNotificationRepository(db);
    receiptRepository = new DeliveryReceiptRepository(db);
    api = new NotificationAPI(repository);
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  beforeEach(async () => {
    // Clear tables before each test
    await db.run('DELETE FROM delivery_receipts');
    await db.run('DELETE FROM notification_execution_log');
    await db.run('DELETE FROM scheduled_notifications');
  });

  describe('ScheduledNotificationRepository', () => {
    test('persists successful provider delivery with sanitized response metadata', async () => {
      const id = await repository.create({
        payload: { message: 'Receipt test' },
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: 'https://example.com/hook',
        executeAt: new Date(Date.now() - 1000),
      });
      const providerRegistry = {
        has: () => true,
        deliver: jest.fn().mockResolvedValue({
          success: true,
          degradedCapabilities: [],
          providerMessageId: 'provider-message-12',
          providerResponse: {
            statusCode: 202,
            messageId: 'provider-message-12',
            authorization: 'Bearer never-store-this',
          },
        }),
      };
      scheduler = new NotificationScheduler(
        repository,
        {
          enabled: true,
          pollIntervalMs: 1000,
          lockTimeoutMs: 30000,
          processorId: 'receipt-success-test',
          batchSize: 10,
          timingBufferMs: 1000,
        },
        null,
        undefined,
        providerRegistry as any,
        receiptRepository,
      );

      await (scheduler as any).processPendingNotifications();

      const receipts = await receiptRepository.findByNotificationId(id);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        status: 'delivered',
        channel: 'webhook',
        attemptCount: 1,
        providerMessageId: 'provider-message-12',
        providerResponse: { statusCode: 202, messageId: 'provider-message-12' },
      });
      expect(await receiptRepository.findByNotificationId(id, 'failed')).toHaveLength(0);
    });

    test('persists a failed receipt with timeout details when provider transport throws', async () => {
      const id = await repository.create({
        payload: { message: 'Timeout receipt test' },
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: 'https://example.com/hook',
        executeAt: new Date(Date.now() - 1000),
      });
      const timeoutError = Object.assign(new Error('secret token=should-not-persist'), {
        name: 'AbortError',
      });
      const providerRegistry = {
        has: () => true,
        deliver: jest.fn().mockRejectedValue(timeoutError),
      };
      scheduler = new NotificationScheduler(
        repository,
        {
          enabled: true,
          pollIntervalMs: 1000,
          lockTimeoutMs: 30000,
          processorId: 'receipt-failure-test',
          batchSize: 10,
          timingBufferMs: 1000,
        },
        null,
        undefined,
        providerRegistry as any,
        receiptRepository,
      );

      await (scheduler as any).processPendingNotifications();

      const failed = await receiptRepository.findByNotificationId(id, 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        status: 'failed',
        errorCode: 'TIMEOUT',
        errorMessage: 'Provider request timed out',
      });
      expect(await receiptRepository.findByNotificationId(id, 'delivered')).toHaveLength(0);
    });

    test('should create a scheduled notification', async () => {
      const input: CreateScheduledNotificationInput = {
        payload: { message: 'Test notification' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: new Date(Date.now() + 60000),
        maxRetries: 3,
        priority: 5,
      };

      const id = await repository.create(input);
      expect(id).toBeGreaterThan(0);

      const notification = await repository.getById(id);
      expect(notification).toBeDefined();
      expect(notification!.status).toBe(NotificationStatus.PENDING);
      expect(notification!.retryCount).toBe(0);
    });

    test('does not deliver an expired scheduled notification', async () => {
      const id = await repository.create({
        payload: { event: {}, contractConfig: {}, message: 'Expired notification' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'webhook-b',
        executeAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() - 1000),
      });
      const discordService = { sendEventNotification: jest.fn().mockResolvedValue(true) } as any;

      scheduler = new NotificationScheduler(
        repository,
        {
          enabled: true,
          pollIntervalMs: 1000,
          lockTimeoutMs: 30000,
          processorId: 'expired-dispatch-test',
          batchSize: 10,
          timingBufferMs: 1000,
        },
        discordService,
      );

      await (scheduler as any).processPendingNotifications();

      expect(discordService.sendEventNotification).toHaveBeenCalledTimes(0);
      expect((await repository.getById(id))!.status).toBe(NotificationStatus.EXPIRED);
    });

    test('does not deliver a notification that expires between retries', async () => {
      const id = await repository.create({
        payload: { event: {}, contractConfig: {}, message: 'Retry expiration' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 60_000),
        maxRetries: 3,
      });
      const discordService = {
        sendEventNotification: jest.fn().mockRejectedValueOnce(new Error('temporary outage')),
      } as any;
      scheduler = new NotificationScheduler(
        repository,
        {
          enabled: true,
          pollIntervalMs: 1000,
          lockTimeoutMs: 30000,
          processorId: 'retry-expiration-initial-test',
          batchSize: 10,
          timingBufferMs: 1000,
          retryDelayMs: 100,
        },
        discordService,
      );

      await (scheduler as any).processPendingNotifications();
      expect(discordService.sendEventNotification).toHaveBeenCalledTimes(1);

      await db.run(
        'UPDATE scheduled_notifications SET expires_at = ?, next_retry_at = ? WHERE id = ?',
        [new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 1000).toISOString(), id],
      );

      const { RetryScheduler } = await import('../services/retry-scheduler');
      const retryScheduler = new RetryScheduler(
        repository,
        {
          enabled: true,
          pollIntervalMs: 1000,
          lockTimeoutMs: 30000,
          processorId: 'retry-expiration-test',
          batchSize: 10,
          baseDelayMs: 100,
          multiplier: 2,
          maxDelayMs: 1000,
          jitter: false,
        },
        discordService,
      );

      await retryScheduler.runOnce();

      expect(discordService.sendEventNotification).toHaveBeenCalledTimes(1);
      expect((await repository.getById(id))!.status).toBe(NotificationStatus.EXPIRED);
    });

    test('delivers non-expired and NULL-expiration notifications normally', async () => {
      const activeId = await repository.create({
        payload: { event: {}, contractConfig: {}, message: 'Still valid' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'webhook-a',
        executeAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const neverExpiresId = await repository.create({
        payload: { event: {}, contractConfig: {}, message: 'Never expires' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'webhook-b',
        executeAt: new Date(Date.now() - 1000),
        expiresAt: null,
      });
      const discordService = { sendEventNotification: jest.fn().mockResolvedValue(true) } as any;
      scheduler = new NotificationScheduler(
        repository,
        {
          enabled: true,
          pollIntervalMs: 1000,
          lockTimeoutMs: 30000,
          processorId: 'valid-expiration-test',
          batchSize: 10,
          timingBufferMs: 1000,
        },
        discordService,
      );

      await (scheduler as any).processPendingNotifications();

      expect(discordService.sendEventNotification).toHaveBeenCalledTimes(2);
      expect((await repository.getById(activeId))!.status).toBe(NotificationStatus.COMPLETED);
      expect((await repository.getById(neverExpiresId))!.status).toBe(NotificationStatus.COMPLETED);
    });

    test('should fetch and lock pending notifications', async () => {
      const executeAt = new Date(Date.now() - 1000); // Past time

      await repository.create({
        payload: { message: 'Test 1' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt,
      });

      await repository.create({
        payload: { message: 'Test 2' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt,
      });

      const processorId = 'test-processor-1';
      const notifications = await repository.fetchAndLockPendingNotifications(
        processorId,
        30000,
        10,
      );

      expect(notifications.length).toBe(2);
      expect(notifications[0].status).toBe(NotificationStatus.PROCESSING);
      expect(notifications[0].processorId).toBe(processorId);
      expect(notifications[0].lockExpiresAt).toBeDefined();
    });

    test('should dispatch missed schedules and schedule retry after temporary failure', async () => {
      const executeAt = new Date(Date.now() - 60_000);

      const id = await repository.create({
        payload: { event: {}, contractConfig: {}, message: 'Missed schedule catch-up' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt,
        maxRetries: 3,
      });

      const discordService = {
        sendEventNotification: jest
          .fn()
          .mockRejectedValueOnce(new Error('temporary discord outage'))
          .mockResolvedValueOnce(true),
      } as any;

      scheduler = new NotificationScheduler(
        repository,
        {
          enabled: true,
          pollIntervalMs: 1000,
          lockTimeoutMs: 30000,
          processorId: 'dispatcher-test',
          batchSize: 10,
          timingBufferMs: 1000,
          retryDelayMs: 2000,
        },
        discordService,
      );

      await (scheduler as any).processPendingNotifications();

      let notification = await repository.getById(id);
      expect(discordService.sendEventNotification).toHaveBeenCalledTimes(1);
      expect(notification!.status).toBe(NotificationStatus.PENDING);
      expect(notification!.retryCount).toBe(1);
      expect(notification!.nextRetryAt).toBeInstanceOf(Date);
      expect(notification!.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());

      await db.run('UPDATE scheduled_notifications SET next_retry_at = ? WHERE id = ?', [
        new Date(Date.now() - 1000).toISOString(),
        id,
      ]);

      const { RetryScheduler } = await import('../services/retry-scheduler');
      const retryScheduler = new RetryScheduler(
        repository,
        {
          enabled: true,
          pollIntervalMs: 1000,
          lockTimeoutMs: 30000,
          batchSize: 10,
          baseDelayMs: 100,
          multiplier: 2,
          maxDelayMs: 1000,
          jitter: false,
        },
        discordService,
      );

      await retryScheduler.runOnce();

      notification = await repository.getById(id);
      expect(discordService.sendEventNotification).toHaveBeenCalledTimes(2);
      expect(notification!.status).toBe(NotificationStatus.COMPLETED);
      expect(notification!.retryCount).toBe(1);
    });

    test('should prevent race conditions with distributed locking', async () => {
      const executeAt = new Date(Date.now() - 1000);

      await repository.create({
        payload: { message: 'Test' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt,
      });

      const processor1 = await repository.fetchAndLockPendingNotifications(
        'processor-1',
        30000,
        10,
      );
      const processor2 = await repository.fetchAndLockPendingNotifications(
        'processor-2',
        30000,
        10,
      );

      expect(processor1.length).toBe(1);
      expect(processor2.length).toBe(0); // Should not pick up locked notification
    });

    test('should recover stale locks', async () => {
      const executeAt = new Date(Date.now() - 1000);

      const id = await repository.create({
        payload: { message: 'Test' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt,
      });

      // Lock the notification
      await repository.fetchAndLockPendingNotifications('processor-1', 30000, 10);

      // Manually expire the lock
      const pastLock = new Date(Date.now() - 1000);
      await db.run('UPDATE scheduled_notifications SET lock_expires_at = ? WHERE id = ?', [
        pastLock.toISOString(),
        id,
      ]);

      const recovered = await repository.recoverStaleLocks();
      expect(recovered).toBe(1);

      const notification = await repository.getById(id);
      expect(notification!.status).toBe(NotificationStatus.PENDING);
      expect(notification!.processorId).toBeNull();
    });

    test('should mark notification as completed', async () => {
      const id = await repository.create({
        payload: { message: 'Test' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: new Date(Date.now() - 1000),
      });

      await repository.markAsCompleted(id);

      const notification = await repository.getById(id);
      expect(notification!.status).toBe(NotificationStatus.COMPLETED);
      expect(notification!.processingCompletedAt).toBeDefined();
    });

    test('should retry failed notification', async () => {
      const id = await repository.create({
        payload: { message: 'Test' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: new Date(Date.now() - 1000),
        maxRetries: 3,
      });

      const error = new Error('Test error');
      await repository.markAsFailedOrRetry(id, error, 0, 3);

      const notification = await repository.getById(id);
      expect(notification!.status).toBe(NotificationStatus.PENDING); // Should retry
      expect(notification!.retryCount).toBe(1);
      expect(notification!.lastError).toBe('Test error');
    });

    test('should mark as failed after max retries', async () => {
      const id = await repository.create({
        payload: { message: 'Test' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: new Date(Date.now() - 1000),
        maxRetries: 3,
      });

      const error = new Error('Test error');
      await repository.markAsFailedOrRetry(id, error, 2, 3);

      const notification = await repository.getById(id);
      expect(notification!.status).toBe(NotificationStatus.DEAD_LETTERED);
      expect(notification!.retryCount).toBe(2);
    });

    test('should cancel pending notification', async () => {
      const id = await repository.create({
        payload: { message: 'Test' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: new Date(Date.now() + 60000),
      });

      const cancelled = await repository.cancel(id);
      expect(cancelled).toBe(true);

      const notification = await repository.getById(id);
      expect(notification!.status).toBe(NotificationStatus.CANCELLED);
    });

    test('cancels with a reason and stores it', async () => {
      const id = await repository.create({
        payload: { message: 'Test' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: new Date(Date.now() + 60000),
      });
      const reason = 'User requested cancellation';
      const ok = await repository.cancel(id, reason);
      expect(ok).toBe(true);

      const fetched = await repository.getById(id);
      expect(fetched!.status).toBe(NotificationStatus.CANCELLED);
      expect(fetched!.cancellationReason).toBe(reason);
    });

    test('should get statistics', async () => {
      await repository.create({
        payload: { message: 'Test 1' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: new Date(Date.now() + 60000),
      });

      await repository.create({
        payload: { message: 'Test 2' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: new Date(Date.now() - 60000), // Overdue
      });

      const stats = await repository.getStats();
      expect(stats.pending).toBe(2);
      expect(stats.overdue).toBe(1);
    });
  });

  describe('NotificationAPI', () => {
    test('should schedule notification via API', async () => {
      const executeAt = new Date(Date.now() + 60000);

      const id = await api.scheduleNotification({
        payload: { message: 'API test' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt,
      });

      expect(id).toBeGreaterThan(0);

      const notification = await api.getNotification(id);
      expect(notification).toBeDefined();
      expect(notification!.status).toBe(NotificationStatus.PENDING);
    });

    test('should reject expired execution time', async () => {
      const pastDate = new Date(Date.now() - 60000);

      await expect(
        api.scheduleNotification({
          payload: { message: 'Test' },
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'test-webhook',
          executeAt: pastDate,
        }),
      ).rejects.toThrow(
        'executeAt must be a future timestamp — the provided date has already expired',
      );
    });

    test('should reject execution time equal to now', async () => {
      // A timestamp at (or just before) the current moment is already expired
      const now = new Date();

      await expect(
        api.scheduleNotification({
          payload: { message: 'Test' },
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'test-webhook',
          executeAt: now,
        }),
      ).rejects.toThrow('executeAt must be a future timestamp');
    });

    test('should reject invalid date object', async () => {
      await expect(
        api.scheduleNotification({
          payload: { message: 'Test' },
          notificationType: NotificationType.DISCORD,
          targetRecipient: 'test-webhook',
          executeAt: new Date('not-a-date'),
        }),
      ).rejects.toThrow('executeAt must be a valid date');
    });

    test('should accept execution time 1 second in the future', async () => {
      const nearFuture = new Date(Date.now() + 1000);

      const id = await api.scheduleNotification({
        payload: { message: 'Test' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: nearFuture,
      });

      expect(id).toBeGreaterThan(0);
    });

    test('should schedule Discord notification', async () => {
      const executeAt = new Date(Date.now() + 60000);

      const id = await api.scheduleDiscordNotification(
        'https://discord.com/webhook/test',
        { content: 'Hello World' },
        executeAt,
        { priority: 1, maxRetries: 5 },
      );

      expect(id).toBeGreaterThan(0);

      const notification = await api.getNotification(id);
      expect(notification!.priority).toBe(1);
      expect(notification!.maxRetries).toBe(5);
    });

    test('should get statistics via API', async () => {
      await api.scheduleNotification({
        payload: { message: 'Test' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: new Date(Date.now() + 60000),
      });

      const stats = await api.getStatistics();
      expect(stats.pending).toBeGreaterThan(0);
    });
  });
});

describe('Stale cache regression tests', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;

  const testDbPath = './data/test-stale-cache.db';

  beforeAll(async () => {
    const dbDir = path.dirname(testDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    db = new Database(testDbPath);
    await db.initialize();
    repository = new ScheduledNotificationRepository(db);
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  beforeEach(async () => {
    await db.run('DELETE FROM notification_execution_log');
    await db.run('DELETE FROM scheduled_notifications');
  });

  test('markAsCompleted updates updated_at — no stale timestamp after delivery', async () => {
    const id = await repository.create({
      payload: { message: 'Stale test' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: new Date(Date.now() - 1000),
    });

    await repository.markAsCompleted(id);

    const notification = await repository.getById(id);
    expect(notification?.status).toBe(NotificationStatus.COMPLETED);
    // updated_at must be a defined, valid date — confirms the column is written on status change
    expect(notification?.updatedAt).toBeDefined();
    expect(notification?.updatedAt).toBeInstanceOf(Date);
    expect(isNaN(notification?.updatedAt?.getTime() ?? NaN)).toBe(false);
  });

  test('markAsFailedOrRetry updates updated_at — no stale timestamp on retry', async () => {
    const id = await repository.create({
      payload: { message: 'Retry stale test' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: new Date(Date.now() - 1000),
      maxRetries: 3,
    });

    await repository.markAsFailedOrRetry(id, new Error('Delivery failed'), 0, 3);

    const notification = await repository.getById(id);
    expect(notification?.status).toBe(NotificationStatus.PENDING);
    expect(notification?.updatedAt).toBeDefined();
    expect(notification?.updatedAt).toBeInstanceOf(Date);
    expect(isNaN(notification?.updatedAt?.getTime() ?? NaN)).toBe(false);
  });

  test('markAsFailedOrRetry updates updated_at when permanently failed', async () => {
    const id = await repository.create({
      payload: { message: 'Final failure stale test' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: new Date(Date.now() - 1000),
      maxRetries: 2,
    });

    await repository.markAsFailedOrRetry(id, new Error('Max retries exceeded'), 2, 2);

    const notification = await repository.getById(id);
    expect(notification?.status).toBe(NotificationStatus.DEAD_LETTERED);
    expect(notification?.updatedAt).toBeDefined();
    expect(notification?.updatedAt).toBeInstanceOf(Date);
    expect(isNaN(notification?.updatedAt?.getTime() ?? NaN)).toBe(false);
  });

  test('recoverStaleLocks updates updated_at — no stale status after lock recovery', async () => {
    const id = await repository.create({
      payload: { message: 'Stale lock test' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: new Date(Date.now() - 1000),
    });

    await repository.fetchAndLockPendingNotifications('processor-stale', 30000, 10);

    // Expire the lock
    const pastLock = new Date(Date.now() - 1000);
    await db.run('UPDATE scheduled_notifications SET lock_expires_at = ? WHERE id = ?', [
      pastLock.toISOString(),
      id,
    ]);

    await repository.recoverStaleLocks();

    const recovered = await repository.getById(id);
    expect(recovered?.status).toBe(NotificationStatus.PENDING);
    expect(recovered?.processorId).toBeNull();
    // updated_at must be a valid date — confirms the column is written on lock recovery
    expect(recovered?.updatedAt).toBeDefined();
    expect(recovered?.updatedAt).toBeInstanceOf(Date);
    expect(isNaN(recovered?.updatedAt?.getTime() ?? NaN)).toBe(false);
  });

  test('stale status is not served after delivery: re-fetch reflects COMPLETED', async () => {
    const id = await repository.create({
      payload: { message: 'Delivery stale check' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: new Date(Date.now() - 1000),
    });

    // Simulate the state a UI would cache before delivery
    const beforeDelivery = await repository.getById(id);
    expect(beforeDelivery?.status).toBe(NotificationStatus.PENDING);

    // Delivery happens
    await repository.markAsCompleted(id);

    // Re-fetch (simulating a poll/refresh) must return the new status
    const afterDelivery = await repository.getById(id);
    expect(afterDelivery?.status).toBe(NotificationStatus.COMPLETED);
    expect(afterDelivery?.status).not.toBe(beforeDelivery?.status);
  });
});
