/**
 * End-to-end tests for the scheduled notification lifecycle:
 * creation → delayed execution → delivery → cleanup.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../database/database';
import { ScheduledNotificationRepository } from '../services/scheduled-notification-repository';
import { NotificationScheduler } from '../services/notification-scheduler';
import { NotificationAPI } from '../services/notification-api';
import { ScheduleAuditTrail } from '../services/schedule-audit-trail';
import { DiscordNotificationService } from '../services/discord-notification';
import { CleanupService } from '../services/cleanup-service';
import { resetWorkerManager } from '../services/worker-manager';
import { EventRegistry } from '../store/event-registry';
import { NotificationFixtureBuilder } from '../test-utils/notification-fixture-builder';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('Scheduled notification lifecycle (e2e)', () => {
  const testDbPath = './data/test-scheduled-lifecycle.db';
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let api: NotificationAPI;
  let scheduler: NotificationScheduler;
  let sendEventMock: jest.Mock;

  const schedulerConfig = {
    enabled: true,
    pollIntervalMs: 100,
    lockTimeoutMs: 30000,
    batchSize: 10,
    timingBufferMs: 0,
    processorId: 'e2e-processor',
  };

  beforeAll(async () => {
    const dbDir = path.dirname(testDbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    db = new Database(testDbPath);
    await db.initialize();
    repository = new ScheduledNotificationRepository(db);
    api = new NotificationAPI(repository);
  });

  afterAll(async () => {
    await scheduler?.stop();
    await db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  beforeEach(async () => {
    resetWorkerManager();
    jest.clearAllMocks();

    await db.run('DELETE FROM notification_execution_log');
    await db.run('DELETE FROM scheduled_notifications');

    sendEventMock = jest.fn().mockResolvedValue(true);
    const discordService = {
      sendEventNotification: sendEventMock,
    } as unknown as DiscordNotificationService;

    scheduler = new NotificationScheduler(repository, schedulerConfig, discordService);
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  async function waitForSchedulerPolls(ms = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  function schedulerPayload() {
    const event = NotificationFixtureBuilder.aStellarEvent().withId('sched-e2e-1').build();
    const contractConfig = NotificationFixtureBuilder.aContractConfig().build();
    return { event, contractConfig, message: 'Scheduled bounty alert' };
  }

  async function createDueNotification() {
    return repository.create(
      NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withPayload(schedulerPayload())
        .withTargetRecipient(NotificationFixtureBuilder.constants.webhookUrl)
        .build()
    );
  }

  it('schedules a notification and delivers it after the poll interval', async () => {
    const executeAt = new Date(Date.now() + 50);

    const id = await api.scheduleNotification({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt,
      maxRetries: 2,
    });

    let notification = await repository.getById(id);
    expect(notification!.status).toBe(NotificationStatus.PENDING);

    await scheduler.start();
    await waitForSchedulerPolls(400);

    notification = await repository.getById(id);
    expect(notification!.status).toBe(NotificationStatus.COMPLETED);
    expect(sendEventMock).toHaveBeenCalledTimes(1);

    const logs = await db.all(
      'SELECT * FROM notification_execution_log WHERE scheduled_notification_id = ?',
      [id]
    );
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('SUCCESS');
  });

  it('does not deliver notifications before their executeAt time', async () => {
    const executeAt = new Date(Date.now() + 60_000);

    const id = await api.scheduleNotification({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt,
    });

    await scheduler.start();
    await waitForSchedulerPolls(250);

    const notification = await repository.getById(id);
    expect(notification!.status).toBe(NotificationStatus.PENDING);
    expect(sendEventMock).not.toHaveBeenCalled();
  });

  it('delivers when executeAt elapses after scheduling', async () => {
    const executeAt = new Date(Date.now() + 200);

    const id = await api.scheduleNotification({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt,
    });

    await scheduler.start();
    await waitForSchedulerPolls(150);
    const currentStatus = (await repository.getById(id))!.status;
expect([NotificationStatus.PENDING, NotificationStatus.PROCESSING]).toContain(currentStatus);

    await new Promise((resolve) => setTimeout(resolve, 250));
    await waitForSchedulerPolls(300);

    expect((await repository.getById(id))!.status).toBe(NotificationStatus.COMPLETED);
    expect(sendEventMock).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup after completed notifications age past retention', async () => {
    const id = await createDueNotification();

    await scheduler.start();
    await waitForSchedulerPolls(300);
    expect((await repository.getById(id))!.status).toBe(NotificationStatus.COMPLETED);

    const registry = new EventRegistry();
    const cleanup = new CleanupService(db, registry, {
      intervalMs: 60_000,
      notificationRetentionMs: 1,
      rateLimitEventRetentionMs: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await cleanup.runDbCleanup();

    expect(result.notifications).toBeGreaterThanOrEqual(1);
    expect(await repository.getById(id)).toBeNull();
  });
  it('applies EXPIRE recovery once and keeps the schedule expired on rerun', async () => {
    const id = await repository.create({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date(Date.now() - 60_000),
    });
    expect(await repository.recoverOverdueSchedules('EXPIRE')).toBe(1);
    expect(await repository.recoverOverdueSchedules('EXPIRE')).toBe(0);
    expect((await repository.getById(id))!.status).toBe(NotificationStatus.EXPIRED);
  });

  it('holds overdue schedules for intervention until an operator resolves them', async () => {
    const id = await repository.create({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date(Date.now() - 60_000),
    });
    expect(await repository.recoverOverdueSchedules('REQUIRE_INTERVENTION')).toBe(1);
    expect((await repository.getById(id))!.status).toBe(NotificationStatus.AWAITING_INTERVENTION);
    expect(await repository.fetchAndLockPendingNotifications('test-worker', 30000, 10)).toHaveLength(0);
    expect(await repository.resolveAwaitingIntervention(id, 'EXECUTE')).toBe(true);
    expect((await repository.getById(id))!.status).toBe(NotificationStatus.PENDING);
  });

  it('applies the configured recovery policy when the scheduler starts after downtime', async () => {
    const id = await repository.create({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date(Date.now() - 60_000),
    });
    scheduler = new NotificationScheduler(
      repository,
      { ...schedulerConfig, recoveryPolicy: 'EXPIRE' },
      { sendEventNotification: sendEventMock } as unknown as DiscordNotificationService,
    );

    await scheduler.start();

    expect((await repository.getById(id))!.status).toBe(NotificationStatus.EXPIRED);
    expect(sendEventMock).not.toHaveBeenCalled();
  });

  it('keeps overdue schedules pending for default EXECUTE recovery', async () => {
    const id = await repository.create({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date(Date.now() - 60_000),
    });
    expect(await repository.recoverOverdueSchedules('EXECUTE')).toBe(1);
    expect((await repository.getById(id))!.status).toBe(NotificationStatus.PENDING);
  });

  it('modifies pending schedules atomically and rejects a stale version', async () => {
    const id = await api.scheduleNotification({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date(Date.now() + 60_000),
    });
    const current = (await repository.getById(id))!;
    const updated = await api.modifyNotification(id, current.version ?? 1, {
      executeAt: new Date(Date.now() + 120_000),
      priority: 3,
    });
    expect(updated!.version).toBe((current.version ?? 1) + 1);
    await expect(api.modifyNotification(id, current.version ?? 1, { priority: 4 })).rejects.toMatchObject({
      code: 'SCHEDULE_VERSION_CONFLICT',
      statusCode: 409,
    });
  });

  it('allows only one of two simultaneous updates using the same version', async () => {
    const id = await api.scheduleNotification({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date(Date.now() + 60_000),
    });
    const current = (await repository.getById(id))!;
    const results = await Promise.allSettled([
      api.modifyNotification(id, current.version ?? 1, { priority: 2 }),
      api.modifyNotification(id, current.version ?? 1, { priority: 3 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rejects modification for every non-pending state', async () => {
    const states = [
      NotificationStatus.PROCESSING,
      NotificationStatus.COMPLETED,
      NotificationStatus.FAILED,
      NotificationStatus.DEAD_LETTERED,
      NotificationStatus.CANCELLED,
      NotificationStatus.EXPIRED,
      NotificationStatus.AWAITING_INTERVENTION,
    ];
    for (const status of states) {
      const id = await repository.create({
        payload: schedulerPayload(),
        notificationType: NotificationType.DISCORD,
        targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
        executeAt: new Date(Date.now() + 60_000),
      });
      if (status === NotificationStatus.AWAITING_INTERVENTION) {
        await db.run(
          "UPDATE scheduled_notifications SET recovery_state = 'AWAITING_INTERVENTION' WHERE id = ?",
          [id],
        );
      } else {
        await db.run('UPDATE scheduled_notifications SET status = ? WHERE id = ?', [status, id]);
      }
      await expect(api.modifyNotification(id, 1, { priority: 2 })).rejects.toMatchObject({
        code: 'SCHEDULE_NOT_MODIFIABLE',
        statusCode: 409,
      });
    }
  });

  it('returns not found for modification of a missing schedule', async () => {
    await expect(api.modifyNotification(999999, 1, { priority: 2 })).resolves.toBeNull();
  });

  it('rejects invalid modification payloads', async () => {
    const id = await api.scheduleNotification({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date(Date.now() + 60_000),
    });
    const current = (await repository.getById(id))!;
    await expect(api.modifyNotification(id, current.version ?? 1, { priority: 100 })).rejects.toThrow(
      'priority must be an integer between 1 and 10',
    );
  });

  it('can expire an intervention hold without delivering it', async () => {
    const id = await repository.create({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date(Date.now() - 60_000),
    });
    await repository.recoverOverdueSchedules('REQUIRE_INTERVENTION');
    expect(await repository.resolveAwaitingIntervention(id, 'EXPIRE')).toBe(true);
    expect((await repository.getById(id))!.status).toBe(NotificationStatus.EXPIRED);
  });

  it('makes modification race safely with an execution claim', async () => {
    const id = await repository.create({
      payload: schedulerPayload(),
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date(Date.now() - 1000),
    });
    const current = (await repository.getById(id))!;
    const outcomes = await Promise.all([
      repository.updatePending(id, current.version ?? 1, {
        payload: schedulerPayload(),
        notificationType: NotificationType.DISCORD,
        targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
        executeAt: new Date(Date.now() + 120_000),
      }),
      repository.fetchAndLockPendingNotifications('race-worker', 30000, 1),
    ]);
    const refreshed = (await repository.getById(id))!;
    expect(['PENDING', 'PROCESSING']).toContain(refreshed.status);
    if (refreshed.status === NotificationStatus.PROCESSING) {
      expect(outcomes[0]).toBe(false);
    } else {
      expect(outcomes[0]).toBe(true);
    }
  });


  it('retains terminal notifications referenced by immutable schedule audit records', async () => {
    const auditDb = new Database(':memory:');
    await auditDb.initialize();

    try {
      const auditRepository = new ScheduledNotificationRepository(auditDb);
      const auditTrail = new ScheduleAuditTrail(auditDb);
      auditRepository.setScheduleAuditTrail(auditTrail);
      const id = await auditRepository.create({
        payload: { message: 'Audited notification' },
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: 'https://example.test/hook',
        executeAt: new Date(Date.now() + 60_000),
      });
      await auditDb.run(
        'UPDATE scheduled_notifications SET status = ?, updated_at = ? WHERE id = ?',
        [NotificationStatus.COMPLETED, '2000-01-01T00:00:00.000Z', id],
      );
      await auditTrail.record({
        scheduledNotificationId: id,
        action: 'EXECUTED',
        fromStatus: NotificationStatus.PROCESSING,
        toStatus: NotificationStatus.COMPLETED,
      });

      expect(await auditRepository.deleteExpiredNotifications(1)).toBe(0);
      expect(await auditRepository.getById(id)).not.toBeNull();
      expect(await auditTrail.getByNotificationId(id)).toHaveLength(1);
    } finally {
      await auditDb.close();
    }
  });
});
