/**
 * Refactored NotificationScheduler Tests
 *
 * Uses NotificationFixtureBuilder to eliminate duplicate fixtures
 * and provide deterministic, type-safe test data.
 */

import { Database } from '../database/database';
import { ScheduledNotificationRepository } from '../services/scheduled-notification-repository';
import { NotificationScheduler } from '../services/notification-scheduler';
import { NotificationAPI } from '../services/notification-api';
import { NotificationType, NotificationStatus } from '../types/scheduled-notification';
import { NotificationFixtureBuilder } from '../test-utils/notification-fixture-builder';
import * as fs from 'fs';
import * as path from 'path';

describe('NotificationScheduler (Refactored)', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let scheduler: NotificationScheduler;
  let api: NotificationAPI;

  const testDbPath = './data/test-notifications-refactored.db';

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
    api = new NotificationAPI(repository);
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

  describe('ScheduledNotificationRepository', () => {
    test('should create a scheduled notification', async () => {
      // ✅ Using fixture builder - no more hardcoded fixture
      const input = NotificationFixtureBuilder.aScheduledNotificationInput().build();

      const id = await repository.create(input);
      expect(id).toBeGreaterThan(0);

      const notification = await repository.getById(id);
      expect(notification).toBeDefined();
      expect(notification!.status).toBe(NotificationStatus.PENDING);
      expect(notification!.retryCount).toBe(0);
    });

    test('should fetch and lock pending notifications', async () => {
      // ✅ Using deterministic date - always same result
      const input1 = NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution() // Past date for immediate processing
        .withPayload({ message: 'Test 1' })
        .build();

      const input2 = NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withPayload({ message: 'Test 2' })
        .build();

      await repository.create(input1);
      await repository.create(input2);

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

    test('should prevent race conditions with distributed locking', async () => {
      // ✅ Single fixture creation, easy to read
      const input = NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .build();

      await repository.create(input);

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
      const input = NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .build();

      const id = await repository.create(input);

      // Lock the notification
      await repository.fetchAndLockPendingNotifications('processor-1', 30000, 10);

      // Manually expire the lock
      const pastLock = NotificationFixtureBuilder.dates.past(1000);
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
      const input = NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .build();

      const id = await repository.create(input);
      await repository.markAsCompleted(id);

      const notification = await repository.getById(id);
      expect(notification!.status).toBe(NotificationStatus.COMPLETED);
      expect(notification!.processingCompletedAt).toBeDefined();
    });

    test('should retry failed notification', async () => {
      const input = NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withMaxRetries(3)
        .build();

      const id = await repository.create(input);

      const error = new Error('Test error');
      await repository.markAsFailedOrRetry(id, error, 0, 3);

      const notification = await repository.getById(id);
      expect(notification!.status).toBe(NotificationStatus.PENDING); // Should retry
      expect(notification!.retryCount).toBe(1);
      expect(notification!.lastError).toBe('Test error');
    });

    test('should mark as failed after max retries', async () => {
      const input = NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withMaxRetries(3)
        .build();

      const id = await repository.create(input);

      const error = new Error('Test error');
      await repository.markAsFailedOrRetry(id, error, 3, 3);

      const notification = await repository.getById(id);
      expect(notification!.status).toBe(NotificationStatus.FAILED);
      expect(notification!.retryCount).toBe(4);
    });

    test('should cancel pending notification', async () => {
      // ✅ Future execution - easy to express intent
      const input = NotificationFixtureBuilder.aScheduledNotificationInput()
        .forFutureExecution()
        .build();

      const id = await repository.create(input);
      const cancelled = await repository.cancel(id);

      expect(cancelled).toBe(true);

      const notification = await repository.getById(id);
      expect(notification!.status).toBe(NotificationStatus.CANCELLED);
    });

    test('should get statistics', async () => {
      // ✅ Create multiple with different scenarios
      await repository.create(
        NotificationFixtureBuilder.aScheduledNotificationInput()
          .withExecuteAt(new Date(Date.now() + 3600000))
          .build(),
      );

      await repository.create(
        NotificationFixtureBuilder.aScheduledNotificationInput()
          .forImmediateExecution() // Overdue
          .build(),
      );

      const stats = await repository.getStats();
      expect(stats.pending).toBe(2);
      expect(stats.overdue).toBe(1);
    });

    test('should increment retry_count and log attempt on lock recovery', async () => {
      const input = NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withMaxRetries(3)
        .build();

      const id = await repository.create(input);

      // Lock the notification
      await repository.fetchAndLockPendingNotifications('processor-1', 30000, 10);

      // Manually expire the lock
      const pastLock = NotificationFixtureBuilder.dates.past(1000);
      await db.run('UPDATE scheduled_notifications SET lock_expires_at = ? WHERE id = ?', [
        pastLock.toISOString(),
        id,
      ]);

      const recovered = await repository.recoverStaleLocks();
      expect(recovered).toBe(1);

      const notification = await repository.getById(id);
      expect(notification!.status).toBe(NotificationStatus.PENDING);
      expect(notification!.retryCount).toBe(1);
      expect(notification!.lastError).toBe('Lock expired/Processor timeout');

      // Verify execution log
      const logs = await db.all(
        'SELECT * FROM notification_execution_log WHERE scheduled_notification_id = ?',
        [id],
      );
      expect(logs.length).toBe(1);
      expect(logs[0].status).toBe('RETRY');
      expect(logs[0].error_message).toBe('Lock expired/Processor timeout');
    });

    test('should mark as failed if retry_count reaches max_retries on lock recovery', async () => {
      const input = NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withMaxRetries(1)
        .build();

      const id = await repository.create(input);

      // Lock the notification
      await repository.fetchAndLockPendingNotifications('processor-1', 30000, 10);

      // Manually expire the lock
      const pastLock = NotificationFixtureBuilder.dates.past(1000);
      await db.run('UPDATE scheduled_notifications SET lock_expires_at = ? WHERE id = ?', [
        pastLock.toISOString(),
        id,
      ]);

      const recovered = await repository.recoverStaleLocks();
      expect(recovered).toBe(1);

      const notification = await repository.getById(id);
      expect(notification!.status).toBe(NotificationStatus.FAILED);
      expect(notification!.retryCount).toBe(1);

      // Verify execution log
      const logs = await db.all(
        'SELECT * FROM notification_execution_log WHERE scheduled_notification_id = ?',
        [id],
      );
      expect(logs.length).toBe(1);
      expect(logs[0].status).toBe('FAILED');
    });

    test('should return correct statistics accounting for stale locks', async () => {
      // 1. Create a notification in the future (pending, not overdue)
      await repository.create(
        NotificationFixtureBuilder.aScheduledNotificationInput()
          .withExecuteAt(new Date(Date.now() + 3600000))
          .build(),
      );

      // 2. Create a notification in the past (overdue, pending)
      const overdueId = await repository.create(
        NotificationFixtureBuilder.aScheduledNotificationInput().forImmediateExecution().build(),
      );

      // 3. Create a notification in the past that is currently PROCESSING but lock is expired
      const staleId = await repository.create(
        NotificationFixtureBuilder.aScheduledNotificationInput().forImmediateExecution().build(),
      );
      const pastLock = NotificationFixtureBuilder.dates.past(1000);
      await db.run(
        `UPDATE scheduled_notifications
         SET status = ?, processor_id = ?, lock_expires_at = ?, processing_started_at = ?
         WHERE id = ?`,
        [
          NotificationStatus.PROCESSING,
          'processor-1',
          pastLock.toISOString(),
          pastLock.toISOString(),
          staleId,
        ],
      );

      // 3. Create a notification in the past (overdue, pending) - created AFTER locking to remain in PENDING status
      await repository.create(
        NotificationFixtureBuilder.aScheduledNotificationInput().forImmediateExecution().build(),
      );
      // Lock only the stale notification — fetchAndLock picks up past items by priority order,
      // so we lock both past items then restore item 2 to PENDING to isolate the stale case.
      await repository.fetchAndLockPendingNotifications('processor-1', 30000, 10);
      await db.run(
        "UPDATE scheduled_notifications SET status = 'PENDING', processor_id = NULL, lock_expires_at = NULL WHERE id = ?",
        [overdueId],
      );
      const pastLock = NotificationFixtureBuilder.dates.past(1000);
      await db.run('UPDATE scheduled_notifications SET lock_expires_at = ? WHERE id = ?', [
        pastLock.toISOString(),
        staleId,
      ]);

      // Get stats BEFORE recovery:
      // - item 1: PENDING (future)
      // - item 2: PENDING (restored, overdue)
      // - item 3: PROCESSING with expired lock → getStats adjusts to PENDING
      const stats = await repository.getStats();

      expect(stats.pending).toBe(3);
      expect(stats.overdue).toBe(2);
      expect(stats.processing).toBe(0);
    });
  });

  describe('NotificationAPI', () => {
    test('should schedule notification via API', async () => {
      const input = NotificationFixtureBuilder.aScheduledNotificationInput()
        .withExecuteAt(new Date(Date.now() + 3600000))
        .withPayload({ message: 'API test' })
        .build();

      const id = await api.scheduleNotification(input);
      expect(id).toBeGreaterThan(0);

      const notification = await api.getNotification(id);
      expect(notification).toBeDefined();
      expect(notification!.status).toBe(NotificationStatus.PENDING);
    });

    test('should reject past execution time', async () => {
      // ✅ Deterministic past date
      const pastInput = NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withExecuteAt(NotificationFixtureBuilder.dates.past(60000))
        .build();

      await expect(api.scheduleNotification(pastInput)).rejects.toThrow(
        'executeAt must be a future timestamp',
      );
    });

    test('should schedule Discord notification', async () => {
      // ✅ Using deterministic constants
      const webhookUrl = NotificationFixtureBuilder.constants.webhookUrl;
      const executeAt = new Date(Date.now() + 3600000);

      const id = await api.scheduleDiscordNotification(
        webhookUrl,
        { content: 'Hello World' },
        executeAt,
        { priority: 1, maxRetries: 5 },
      );

      expect(id).toBeGreaterThan(0);

      const notification = await api.getNotification(id);
      expect(notification!.priority).toBe(1);
      expect(notification!.maxRetries).toBe(5);
    });

    test('should schedule different notification types', async () => {
      // ✅ Test all types easily
      const types = [
        NotificationType.DISCORD,
        NotificationType.EMAIL,
        NotificationType.WEBHOOK,
        NotificationType.SMS,
      ];

      for (const type of types) {
        const input = NotificationFixtureBuilder.aScheduledNotificationInput()
          .withType(type)
          .withExecuteAt(new Date(Date.now() + 3600000))
          .build();

        const id = await api.scheduleNotification(input);
        expect(id).toBeGreaterThan(0);

        const notification = await api.getNotification(id);
        expect(notification!.notificationType).toBe(type);
      }
    });

    test('should get statistics via API', async () => {
      await api.scheduleNotification(
        NotificationFixtureBuilder.aScheduledNotificationInput()
          .withExecuteAt(new Date(Date.now() + 3600000))
          .build(),
      );

      const stats = await api.getStatistics();
      expect(stats.pending).toBeGreaterThan(0);
    });
  });
});
