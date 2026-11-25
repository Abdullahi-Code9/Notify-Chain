import { Database } from '../database/database';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';
import { ScheduledNotificationRepository } from './scheduled-notification-repository';

describe('recurring notification persistence and lifecycle', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  const startAt = new Date('2026-01-01T12:00:00.000Z');

  beforeAll(async () => {
    db = new Database(':memory:');
    await db.initialize();
    repository = new ScheduledNotificationRepository(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    repository.setScheduleAuditTrail(null);
    await db.run('DELETE FROM notification_execution_log');
    await db.run('DELETE FROM scheduled_notifications');
  });

  afterEach(() => {
    repository.setScheduleAuditTrail(null);
  });

  async function createRecurring(count: number, executeAt = startAt): Promise<number> {
    return repository.create({
      payload: { message: 'Recurring delivery' },
      notificationType: NotificationType.WEBHOOK,
      targetRecipient: 'https://example.test/hook',
      executeAt,
      recurrence: { frequency: 'daily', count },
    });
  }

  async function markProcessing(id: number, executeAt?: Date): Promise<void> {
    await db.run(
      'UPDATE scheduled_notifications SET status = ?, execute_at = COALESCE(?, execute_at) WHERE id = ?',
      [NotificationStatus.PROCESSING, executeAt?.toISOString() ?? null, id],
    );
  }

  it('persists the recurrence and atomically advances a successful occurrence', async () => {
    const id = await createRecurring(3);
    const initial = await repository.getById(id);
    expect(initial).toMatchObject({
      recurrence: { frequency: 'daily', interval: 1, count: 3 },
      occurrenceCount: 0,
    });

    await markProcessing(id);
    await repository.markAsCompleted(id, undefined, new Date('2026-01-01T12:01:00.000Z'));

    const advanced = await repository.getById(id);
    expect(advanced).toMatchObject({
      status: NotificationStatus.PENDING,
      executeAt: new Date('2026-01-02T12:00:00.000Z'),
      occurrenceCount: 1,
      lastRunAt: startAt,
    });
  });

  it('audits a continuing occurrence with its actual pending status', async () => {
    const record = jest.fn().mockResolvedValue(1);
    repository.setScheduleAuditTrail({ record } as any);
    const id = await createRecurring(3);

    await markProcessing(id);
    await repository.markAsCompleted(id, 'request-1', new Date('2026-01-01T12:01:00.000Z'));

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledNotificationId: id,
        action: 'EXECUTED',
        fromStatus: NotificationStatus.PROCESSING,
        toStatus: NotificationStatus.PENDING,
      }),
    );
  });

  it('completes a series by count and ignores duplicate completion after advancement', async () => {
    const id = await createRecurring(2);
    await markProcessing(id);
    await repository.markAsCompleted(id, undefined, new Date('2026-01-01T12:01:00.000Z'));

    const nextAt = new Date('2026-01-02T12:00:00.000Z');
    await markProcessing(id, nextAt);
    await repository.markAsCompleted(id, undefined, nextAt);
    const completed = await repository.getById(id);
    expect(completed).toMatchObject({ status: NotificationStatus.COMPLETED, occurrenceCount: 2 });

    await repository.markAsCompleted(id, undefined, new Date('2026-01-02T12:01:00.000Z'));
    expect(await repository.getById(id)).toMatchObject({
      status: NotificationStatus.COMPLETED,
      occurrenceCount: 2,
      executeAt: nextAt,
    });
  });

  it('completes a series when until is exhausted', async () => {
    const id = await repository.create({
      payload: { message: 'Until-bound series' },
      notificationType: NotificationType.WEBHOOK,
      targetRecipient: 'https://example.test/hook',
      executeAt: startAt,
      recurrence: { frequency: 'daily', until: '2026-01-02T12:00:00.000Z' },
    });

    await markProcessing(id);
    await repository.markAsCompleted(id, undefined, new Date('2026-01-01T12:01:00.000Z'));
    await markProcessing(id, new Date('2026-01-02T12:00:00.000Z'));
    await repository.markAsCompleted(id, undefined, new Date('2026-01-02T12:01:00.000Z'));

    expect(await repository.getById(id)).toMatchObject({
      status: NotificationStatus.COMPLETED,
      occurrenceCount: 2,
    });
  });

  it('keeps a failed occurrence for retry and does not advance it twice', async () => {
    const id = await createRecurring(3);
    await markProcessing(id);
    await repository.markAsFailedOrRetry(
      id,
      new Error('temporary delivery failure'),
      0,
      3,
      new Date('2026-01-01T12:05:00.000Z'),
    );
    expect(await repository.getById(id)).toMatchObject({
      status: NotificationStatus.PENDING,
      executeAt: startAt,
      occurrenceCount: 0,
    });

    await markProcessing(id);
    const completedAt = new Date('2026-01-01T12:06:00.000Z');
    await repository.markAsCompleted(id, undefined, completedAt);
    await repository.markAsCompleted(id, undefined, completedAt);
    expect(await repository.getById(id)).toMatchObject({
      status: NotificationStatus.PENDING,
      executeAt: new Date('2026-01-02T12:00:00.000Z'),
      occurrenceCount: 1,
      retryCount: 0,
    });
  });

  it('cancels before the first run and between occurrences, but not after completion', async () => {
    const beforeFirst = await createRecurring(3);
    expect(await repository.cancel(beforeFirst, 'stop before first')).toBe(true);
    expect(await repository.getById(beforeFirst)).toMatchObject({
      status: NotificationStatus.CANCELLED,
    });

    const betweenRuns = await createRecurring(3, new Date(startAt.getTime() + 10_000));
    await markProcessing(betweenRuns);
    await repository.markAsCompleted(betweenRuns, undefined, new Date(startAt.getTime() + 11_000));
    expect(await repository.cancel(betweenRuns, 'stop remaining runs')).toBe(true);
    expect(await repository.getById(betweenRuns)).toMatchObject({
      status: NotificationStatus.CANCELLED,
    });

    const completed = await createRecurring(1, new Date(startAt.getTime() + 20_000));
    await markProcessing(completed);
    await repository.markAsCompleted(completed, undefined, new Date(startAt.getTime() + 21_000));
    expect(await repository.cancel(completed)).toBe(false);
  });

  it('does not cancel an in-flight occurrence', async () => {
    const id = await createRecurring(3);
    await markProcessing(id);
    expect(await repository.cancel(id)).toBe(false);
    await repository.markAsCompleted(id, undefined, new Date('2026-01-01T12:01:00.000Z'));
    expect(await repository.getById(id)).toMatchObject({
      status: NotificationStatus.PENDING,
      occurrenceCount: 1,
    });
  });
});
