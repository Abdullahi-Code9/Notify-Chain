/**
 * Missed-schedule recovery: overdue notifications execute, expire, or wait
 * for an operator depending on SCHEDULER missedSchedulePolicy.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../database/database';
import { ScheduledNotificationRepository } from '../services/scheduled-notification-repository';
import { NotificationScheduler } from '../services/notification-scheduler';
import { NotificationAPI } from '../services/notification-api';
import { DiscordNotificationService } from '../services/discord-notification';
import { resetWorkerManager } from '../services/worker-manager';
import { NotificationStatus, NotificationType, MissedSchedulePolicy } from '../types/scheduled-notification';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('missed-schedule recovery', () => {
  const testDbPath = './data/test-missed-schedule-recovery.db';
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let api: NotificationAPI;
  let scheduler: NotificationScheduler;
  let sendEventMock: jest.Mock;

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
  });

  afterEach(async () => {
    await scheduler?.stop();
  });

  function startScheduler(policy: MissedSchedulePolicy) {
    const discordService = {
      sendEventNotification: sendEventMock,
    } as unknown as DiscordNotificationService;
    scheduler = new NotificationScheduler(
      repository,
      {
        enabled: true,
        pollIntervalMs: 50,
        lockTimeoutMs: 30_000,
        batchSize: 10,
        timingBufferMs: 0,
        processorId: `missed-${policy}`,
        missedSchedulePolicy: policy,
      },
      discordService,
    );
    return scheduler.start();
  }

  async function createOverdue(): Promise<number> {
    return repository.create({
      payload: { message: 'overdue reminder', event: { id: 'missed-1' }, contractConfig: { address: 'CABC' } },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'discord_channel_alpha',
      executeAt: new Date(Date.now() - 60_000),
      maxRetries: 1,
    });
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1500): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('timed out waiting for scheduler');
  }

  it('delivers an overdue notification when the policy is execute', async () => {
    const id = await createOverdue();
    await startScheduler('execute');

    await waitFor(async () => (await repository.getById(id))?.status === NotificationStatus.COMPLETED);
    expect(sendEventMock).toHaveBeenCalledTimes(1);
  });

  it('expires an overdue notification without delivering it', async () => {
    const id = await createOverdue();
    await startScheduler('expire');

    await waitFor(async () => (await repository.getById(id))?.status === NotificationStatus.EXPIRED);
    expect(sendEventMock).not.toHaveBeenCalled();
    const row = await repository.getById(id);
    expect(row?.lastError).toMatch(/expired by recovery policy/);
  });

  it('holds an overdue notification until an operator resumes it', async () => {
    const id = await createOverdue();
    await startScheduler('intervene');

    await waitFor(async () => {
      const row = await repository.getById(id);
      return row?.status === NotificationStatus.PENDING && row.nextRetryAt != null;
    });
    expect(sendEventMock).not.toHaveBeenCalled();

    await expect(api.releaseMissedSchedule(id)).resolves.toBe(true);

    await waitFor(async () => (await repository.getById(id))?.status === NotificationStatus.COMPLETED);
    expect(sendEventMock).toHaveBeenCalledTimes(1);
  });
});
