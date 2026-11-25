import { Database, initializeDatabase } from '../database/database';
import { ScheduleAuditTrail } from './schedule-audit-trail';
import { NotificationType, NotificationStatus } from '../types/scheduled-notification';

describe('ScheduleAuditTrail', () => {
  let db: Database;
  let audit: ScheduleAuditTrail;

  beforeEach(async () => {
    db = await initializeDatabase(':memory:');
    audit = new ScheduleAuditTrail(db);

    await db.run(
      `INSERT INTO scheduled_notifications (
        payload, notification_type, target_recipient, execute_at, status, priority
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        JSON.stringify({ message: 'secret-should-not-appear' }),
        NotificationType.DISCORD,
        'https://example.com/hook',
        new Date(Date.now() + 60_000).toISOString(),
        NotificationStatus.PENDING,
        5,
      ],
    );
  });

  afterEach(async () => {
    await db.close();
  });

  it('records CREATE/CANCEL/EXECUTE with timestamps and identifiers', async () => {
    const createdId = await audit.record({
      scheduledNotificationId: 1,
      action: 'CREATED',
      actor: 'api',
      toStatus: 'PENDING',
      details: { notificationType: 'discord', payload: 'SENSITIVE', eventId: 'evt-1' },
    });
    expect(createdId).toBeGreaterThan(0);

    await audit.record({
      scheduledNotificationId: 1,
      action: 'CANCELLED',
      fromStatus: 'PENDING',
      toStatus: 'CANCELLED',
      details: { reason: 'user-request' },
    });

    await audit.record({
      scheduledNotificationId: 1,
      action: 'EXECUTED',
      fromStatus: 'PROCESSING',
      toStatus: 'COMPLETED',
    });

    const records = await audit.getByNotificationId(1);
    expect(records).toHaveLength(3);
    expect(records[0].action).toBe('CREATED');
    expect(records[0].timestamp).toBeInstanceOf(Date);
    expect(records[0].scheduledNotificationId).toBe(1);
    expect(records[0].details).toEqual({ notificationType: 'discord', eventId: 'evt-1' });
    expect(JSON.stringify(records[0].details)).not.toContain('SENSITIVE');
    expect(records[1].action).toBe('CANCELLED');
    expect(records[2].action).toBe('EXECUTED');
  });

  it('supports querying by action and is immutable', async () => {
    await audit.record({
      scheduledNotificationId: 1,
      action: 'CREATED',
      toStatus: 'PENDING',
    });
    await audit.record({
      scheduledNotificationId: 1,
      action: 'MODIFIED',
      fromStatus: 'PENDING',
      toStatus: 'PENDING',
      details: { field: 'executeAt' },
    });

    const modified = await audit.query({ action: 'MODIFIED' });
    expect(modified).toHaveLength(1);
    expect(modified[0].details).toEqual({ field: 'executeAt' });

    await expect(
      db.run('UPDATE schedule_audit_log SET actor = ? WHERE id = ?', ['hacker', 1]),
    ).rejects.toThrow(/immutable/i);
  });
});
