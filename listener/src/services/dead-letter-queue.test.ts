import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../database/database';
import { ScheduledNotificationRepository } from './scheduled-notification-repository';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';

describe('Dead letter queue processing', () => {
  const dbPath = './data/test-dead-letter-queue.db';
  let db: Database;
  let repository: ScheduledNotificationRepository;

  beforeEach(async () => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    db = new Database(dbPath);
    await db.initialize();
    repository = new ScheduledNotificationRepository(db);
  });

  afterEach(async () => {
    await db.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('moves exhausted notifications into the dead letter queue', async () => {
    const notificationId = await repository.create({
      payload: { message: 'hello' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'https://example.test/hook',
      executeAt: new Date(Date.now() + 60_000),
      maxRetries: 1,
    });

    await repository.markAsFailedOrRetry(
      notificationId,
      new Error('permanent failure'),
      0,
      1,
      new Date(Date.now() + 5_000)
    );

    const dlqEntries = await repository.getDeadLetterQueue();
    expect(dlqEntries).toHaveLength(1);
    expect(dlqEntries[0].originalNotificationId).toBe(notificationId);
    expect(dlqEntries[0].failureReason).toBe('permanent failure');

    const row = await repository.getById(notificationId);
    expect(row?.status).toBe(NotificationStatus.DEAD_LETTERED);
  });

  it('requeues a dead-lettered notification for retry', async () => {
    const notificationId = await repository.create({
      payload: { message: 'retry me' },
      notificationType: NotificationType.EMAIL,
      targetRecipient: 'test@example.com',
      executeAt: new Date(Date.now() + 60_000),
      maxRetries: 1,
    });

    await repository.markAsFailedOrRetry(
      notificationId,
      new Error('permanent failure'),
      0,
      1,
      new Date(Date.now() + 5_000)
    );

    const [entry] = await repository.getDeadLetterQueue();
    const requeued = await repository.retryDeadLetterNotification(entry.id!, 'req-2');

    expect(requeued).toBe(true);

    const row = await repository.getById(notificationId);
    expect(row?.status).toBe(NotificationStatus.PENDING);
    expect(row?.retryCount).toBe(0);
    expect(row?.nextRetryAt).toBeNull();

    // After requeueing, the entry is NOT removed from DLQ in the current implementation,
    // it's just updated. The test should reflect that.
    const remainingEntries = await repository.getDeadLetterQueue();
    expect(remainingEntries).toHaveLength(1);
    expect(remainingEntries[0].id).toBe(entry.id);
  });
});
