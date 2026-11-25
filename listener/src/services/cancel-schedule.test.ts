import { Database, initializeDatabase } from '../database/database';
import { NotificationAPI } from './notification-api';
import { ScheduledNotificationRepository } from './scheduled-notification-repository';
import { ScheduleAuditTrail } from './schedule-audit-trail';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';

describe('cancelSchedule (#969)', () => {
  let db: Database;
  let api: NotificationAPI;
  let repo: ScheduledNotificationRepository;

  beforeEach(async () => {
    db = await initializeDatabase(':memory:');
    repo = new ScheduledNotificationRepository(db);
    const audit = new ScheduleAuditTrail(db);
    repo.setScheduleAuditTrail(audit);
    api = new NotificationAPI(repo);
    api.setScheduleAuditTrail(audit);
  });

  afterEach(async () => {
    await db.close();
  });

  async function seed(status: NotificationStatus): Promise<number> {
    const id = await repo.create({
      payload: { message: 'x' },
      notificationType: NotificationType.WEBHOOK,
      targetRecipient: 'https://example.com/h',
      executeAt: new Date(Date.now() + 120_000),
    });
    if (status !== NotificationStatus.PENDING) {
      await db.run('UPDATE scheduled_notifications SET status = ? WHERE id = ?', [
        status,
        id,
      ]);
    }
    return id;
  }

  it('cancels a pending schedule', async () => {
    const id = await seed(NotificationStatus.PENDING);
    const result = await api.cancelSchedule(id, 'user request');
    expect(result.state).toBe('cancelled');
    expect(result.cancelled).toBe(true);
    expect(result.status).toBe(NotificationStatus.CANCELLED);
  });

  it('is idempotent for already-cancelled schedules', async () => {
    const id = await seed(NotificationStatus.PENDING);
    await api.cancelSchedule(id);
    const again = await api.cancelSchedule(id);
    expect(again.state).toBe('already_cancelled');
    expect(again.cancelled).toBe(false);
    expect(again.status).toBe(NotificationStatus.CANCELLED);
  });

  it('does not silently undo completed schedules', async () => {
    const id = await seed(NotificationStatus.COMPLETED);
    const result = await api.cancelSchedule(id);
    expect(result.state).toBe('already_final');
    expect(result.cancelled).toBe(false);
    expect(result.status).toBe(NotificationStatus.COMPLETED);
    const row = await repo.getById(id);
    expect(row?.status).toBe(NotificationStatus.COMPLETED);
  });

  it('returns not_found for unknown ids', async () => {
    const result = await api.cancelSchedule(99999);
    expect(result.state).toBe('not_found');
  });
});
