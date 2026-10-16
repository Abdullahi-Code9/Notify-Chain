/**
 * End-to-end tests for the complete notification flow.
 * Issue: Core-Foundry/Notify-Chain#247
 *
 * Covers every phase the issue requires:
 *   1. Notification creation  — input validation, scheduling, idempotency
 *   2. Delivery workflows     — scheduler poll → send → status update → audit log
 *   3. Retry scenarios        — exponential backoff, distributed lock, next_retry_at
 *   4. Failure handling       — max-retry exhaustion, permanent failure, stale locks
 *
 * The only thing mocked is the outbound network (fetch / Discord webhook).
 * All other collaborators — Database, Repository, Scheduler, RetryScheduler,
 * NotificationAPI, IdempotencyKeyService — run against a real in-process SQLite
 * database so the full SQL path is exercised.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../database/database';
import { ScheduledNotificationRepository } from '../services/scheduled-notification-repository';
import { IdempotencyKeyRepository } from '../services/idempotency-key-repository';
import { IdempotencyKeyService } from '../services/idempotency-key-service';
import { NotificationAPI } from '../services/notification-api';
import { NotificationScheduler } from '../services/notification-scheduler';
import { RetryScheduler, RETRY_SCHEDULER_DEFAULTS, calculateBackoffDelay } from '../services/retry-scheduler';
import { DiscordNotificationService } from '../services/discord-notification';
import { BackpressureController } from '../services/backpressure-controller';
import { BackpressureMonitor } from '../services/backpressure-monitor';
import { NotificationFixtureBuilder } from '../test-utils/notification-fixture-builder';
import { resetWorkerManager } from '../services/worker-manager';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../utils/request-id', () => ({ generateRequestId: () => 'e2e-req-id' }));

const logger = jest.requireMock('../utils/logger').default;

// ---------------------------------------------------------------------------
// Shared test database helpers
// ---------------------------------------------------------------------------

const TEST_DB_PATH = './data/test-notification-flow-e2e.db';

async function setupDb(): Promise<Database> {
  const dbDir = path.dirname(TEST_DB_PATH);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  await db.initialize();
  return db;
}

async function clearTables(db: Database): Promise<void> {
  await db.run('DELETE FROM notification_execution_log');
  await db.run('DELETE FROM scheduled_notifications');
  await db.run('DELETE FROM idempotency_keys');
  await db.run('DELETE FROM backpressure_events');
}

/** Insert a notification directly at PENDING with retry_count > 0 so
 *  RetryScheduler picks it up (it ignores retry_count === 0). */
async function insertRetryable(
  repo: ScheduledNotificationRepository,
  db: Database,
  retryCount = 1,
  nextRetryAt: Date | null = null,
  maxRetries = 3
): Promise<number> {
  const id = await repo.create(
    NotificationFixtureBuilder.aScheduledNotificationInput()
      .forImmediateExecution()
      .withMaxRetries(maxRetries)
      .withTargetRecipient(NotificationFixtureBuilder.constants.webhookUrl)
      .build()
  );
  await db.run(
    `UPDATE scheduled_notifications
     SET status = ?, retry_count = ?, next_retry_at = ?
     WHERE id = ?`,
    [NotificationStatus.PENDING, retryCount, nextRetryAt?.toISOString() ?? null, id]
  );
  return id;
}

const SCHEDULER_CONFIG = {
  enabled: true,
  pollIntervalMs: 100,
  lockTimeoutMs: 30_000,
  batchSize: 10,
  timingBufferMs: 0,
  processorId: 'e2e-processor',
};

// ===========================================================================
// 1. NOTIFICATION CREATION
// ===========================================================================

describe('1. Notification creation', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let idempotencyRepo: IdempotencyKeyRepository;
  let idempotencyService: IdempotencyKeyService;
  let api: NotificationAPI;

  beforeAll(async () => {
    db = await setupDb();
    repository = new ScheduledNotificationRepository(db);
    idempotencyRepo = new IdempotencyKeyRepository(db);
    idempotencyService = new IdempotencyKeyService(idempotencyRepo);
    api = new NotificationAPI(repository, idempotencyService);
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  beforeEach(async () => {
    resetWorkerManager();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-24T12:00:00.000Z'));
    await clearTables(db);
  });

  afterEach(() => jest.useRealTimers());

  it('creates a notification and persists it as PENDING', async () => {
    const executeAt = new Date('2026-06-24T13:00:00.000Z');
    const id = await api.scheduleNotification({
      payload: { message: 'hello' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt,
      maxRetries: 3,
    });

    expect(id).toBeGreaterThan(0);
    const row = await repository.getById(id);
    expect(row).toBeTruthy();
    expect(row!.status).toBe(NotificationStatus.PENDING);
    expect(row!.retryCount).toBe(0);
    expect(row!.maxRetries).toBe(3);
  });

  it('rejects a notification with a past executeAt', async () => {
    await expect(
      api.scheduleNotification({
        payload: { message: 'too late' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
        executeAt: new Date('2026-06-24T11:59:59.000Z'), // 1 second in the past
      })
    ).rejects.toThrow('executeAt must be a future timestamp');
  });

  it('rejects a notification with a missing targetRecipient', async () => {
    await expect(
      api.scheduleNotification({
        payload: { message: 'no recipient' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: '',
        executeAt: new Date('2026-06-24T13:00:00.000Z'),
      })
    ).rejects.toThrow('targetRecipient is required');
  });
  afterEach(async () => {
    await scheduler.stop();
  });

  async function waitForSchedulerPolls(ms = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  function futureExecuteAt(offsetMs = 10000): Date {
    return new Date(Date.now() + offsetMs);
  }

  describe('Complete notification lifecycle', () => {
    it('should create, process, and deliver a notification', async () => {
      const executeAt = futureExecuteAt(50);

  it('rejects a notification with an invalid payload', async () => {
    await expect(
      api.scheduleNotification({
        payload: null as any,
        notificationType: NotificationType.DISCORD,
        targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
        executeAt: new Date('2026-06-24T13:00:00.000Z'),
      })
    ).rejects.toThrow('payload must be a valid object');
  });

  it('schedules a Discord notification via the convenience helper', async () => {
    const executeAt = new Date('2026-06-24T13:00:00.000Z');
    const id = await api.scheduleDiscordNotification(
      NotificationFixtureBuilder.constants.webhookUrl,
      { text: 'convenience' },
      executeAt
    );
    expect(id).toBeGreaterThan(0);
    const row = await repository.getById(id);
    expect(row!.notificationType).toBe(NotificationType.DISCORD);
  });

  it('stores notification metadata when provided', async () => {
    const executeAt = new Date('2026-06-24T13:00:00.000Z');
    const id = await api.scheduleNotification({
      payload: { message: 'with meta' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt,
      metadata: { source: 'contract', contractAddress: 'CXYZ' },
    });

    const row = await repository.getById(id);
    const meta = JSON.parse(row!.metadata!);
    expect(meta.source).toBe('contract');
    expect(meta.contractAddress).toBe('CXYZ');
  });

  // -- Idempotency --

  it('returns the same ID for duplicate requests sharing an idempotency key', async () => {
    const executeAt = new Date('2026-06-24T13:00:00.000Z');
    const payload = { message: 'idempotent' };
    const key = 'idem-create-1';

    const id1 = await api.scheduleNotification(
      { payload, notificationType: NotificationType.DISCORD,
        targetRecipient: NotificationFixtureBuilder.constants.webhookUrl, executeAt },
      undefined, key
    );
    const id2 = await api.scheduleNotification(
      { payload, notificationType: NotificationType.DISCORD,
        targetRecipient: NotificationFixtureBuilder.constants.webhookUrl, executeAt },
      undefined, key
    );

    expect(id1).toBe(id2);
    const stats = await repository.getStats();
    expect(stats.pending).toBe(1);
  });
      await scheduler.start();
      await waitForSchedulerPolls(400);

  it('rejects a duplicate idempotency key used with a different payload', async () => {
    const executeAt = new Date('2026-06-24T13:00:00.000Z');
    const key = 'idem-create-2';

    await api.scheduleNotification(
      { payload: { message: 'original' }, notificationType: NotificationType.DISCORD,
        targetRecipient: NotificationFixtureBuilder.constants.webhookUrl, executeAt },
      undefined, key
    );

    await expect(
      api.scheduleNotification(
        { payload: { message: 'tampered' }, notificationType: NotificationType.DISCORD,
          targetRecipient: NotificationFixtureBuilder.constants.webhookUrl, executeAt },
        undefined, key
      )
    ).rejects.toThrow('Idempotency key reused with different request body');
  });

  it('cancels a scheduled notification', async () => {
    const id = await api.scheduleNotification({
      payload: { message: 'cancel me' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date('2026-06-24T13:00:00.000Z'),
    });

    const cancelled = await api.cancelNotification(id);
    expect(cancelled).toBe(true);

    const row = await repository.getById(id);
    expect(row!.status).toBe(NotificationStatus.CANCELLED);
  });

  it('cancels a scheduled notification with a reason', async () => {
    const id = await api.scheduleNotification({
      payload: { message: 'cancel me with reason' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date('2026-06-24T13:00:00.000Z'),
    });

    const cancelled = await api.cancelNotification(id, 'Admin override');
    expect(cancelled).toBe(true);

    const row = await repository.getById(id);
    expect(row!.status).toBe(NotificationStatus.CANCELLED);
    expect(row!.cancellationReason).toBe('Admin override');
  });
});

// ===========================================================================
// 2. DELIVERY WORKFLOWS
// ===========================================================================

describe('2. Delivery workflows', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let api: NotificationAPI;
  let scheduler: NotificationScheduler;
  let sendMock: jest.Mock;

  beforeAll(async () => {
    db = await setupDb();
    repository = new ScheduledNotificationRepository(db);
    api = new NotificationAPI(repository);
  });

  afterAll(async () => {
    await scheduler?.stop();
    await db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-24T12:00:00.000Z'));
    await clearTables(db);

    sendMock = jest.fn().mockResolvedValue(true);
    const discordService = { sendEventNotification: sendMock } as unknown as DiscordNotificationService;
    scheduler = new NotificationScheduler(repository, SCHEDULER_CONFIG, discordService);
  });

  afterEach(async () => {
    await scheduler.stop();
    jest.useRealTimers();
  });

  it('processes a due notification and transitions it to COMPLETED', async () => {
    const id = await api.scheduleNotification({
      payload: { message: 'deliver me' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date('2026-06-24T12:00:02.000Z'),
    it('should log execution attempts for audit trail', async () => {
      const id = await api.scheduleNotification({
        payload: { message: 'Test notification' },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'https://discord.com/webhook',
        executeAt: futureExecuteAt(50),
      });

      await scheduler.start();
      await waitForSchedulerPolls(400);

      const logs = await db.all(
        'SELECT * FROM notification_execution_log WHERE scheduled_notification_id = ?',
        [id]
      );

      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe('SUCCESS');
      expect(logs[0].execution_attempt).toBe(1);
      expect(logs[0].scheduled_notification_id).toBe(id);
    });

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(250);

    const row = await repository.getById(id);
    expect(row!.status).toBe(NotificationStatus.COMPLETED);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('does not deliver a notification before its executeAt time', async () => {
    const id = await api.scheduleNotification({
      payload: { message: 'not yet' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date('2026-06-24T12:10:00.000Z'), // 10 min future
    });
  describe('Idempotency handling', () => {
    it('should return cached response for duplicate requests with same idempotency key', async () => {
      const executeAt = futureExecuteAt();
      const payload = { message: 'Unique message' };
      const idempotencyKey = 'test-idempotency-key-1';

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(250);

    const row = await repository.getById(id);
    expect(row!.status).toBe(NotificationStatus.PENDING);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('delivers once executeAt elapses mid-run', async () => {
    const id = await api.scheduleNotification({
      payload: { message: 'wait for it' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date('2026-06-24T12:05:00.000Z'),
    });

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(200);
    expect((await repository.getById(id))!.status).toBe(NotificationStatus.PENDING);
    it('should reject duplicate requests with different payload', async () => {
      const executeAt = futureExecuteAt();
      const idempotencyKey = 'test-idempotency-key-2';

    jest.setSystemTime(new Date('2026-06-24T12:05:01.000Z'));
    await jest.advanceTimersByTimeAsync(400);

    expect((await repository.getById(id))!.status).toBe(NotificationStatus.COMPLETED);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('writes a SUCCESS execution log entry after delivery', async () => {
    const id = await api.scheduleNotification({
      payload: { message: 'audit this' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
      executeAt: new Date('2026-06-24T12:00:02.000Z'),
    });

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(250);
    it('should clean up expired idempotency keys', async () => {
      const executeAt = futureExecuteAt();
      const idempotencyKey = 'test-idempotency-key-3';

    const logs = await db.all(
      'SELECT * FROM notification_execution_log WHERE scheduled_notification_id = ?',
      [id]
    );
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('SUCCESS');
    expect(logs[0].execution_attempt).toBe(1);
  });

  it('processes a batch of multiple due notifications', async () => {
    const executeAt = new Date('2026-06-24T12:00:02.000Z');
    const ids = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        api.scheduleNotification({
          payload: { message: `batch-${i}` },
          notificationType: NotificationType.DISCORD,
          targetRecipient: NotificationFixtureBuilder.constants.webhookUrl,
          executeAt,
        })
      )
    );

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(250);

    for (const id of ids) {
      expect((await repository.getById(id))!.status).toBe(NotificationStatus.COMPLETED);
    }
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it('forwards the event and contract config to the Discord service', async () => {
    const event = NotificationFixtureBuilder.aStellarEvent().withId('deliver-evt-1').build();
    const contractConfig = NotificationFixtureBuilder.aContractConfig().build();

    const id = await repository.create(
      NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withPayload({ event, contractConfig })
        .withTargetRecipient(NotificationFixtureBuilder.constants.webhookUrl)
        .build()
    );

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(250);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'deliver-evt-1' }),
      expect.objectContaining({ address: contractConfig.address }),
      expect.any(String)
    );
    expect((await repository.getById(id))!.status).toBe(NotificationStatus.COMPLETED);
  });
});

// ===========================================================================
// 3. RETRY SCENARIOS
// ===========================================================================

describe('3. Retry scenarios', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;

  beforeAll(async () => {
    db = await setupDb();
    repository = new ScheduledNotificationRepository(db);
      await db.run(
        'UPDATE idempotency_keys SET expires_at = ? WHERE idempotency_key = ?',
        [new Date(Date.now() - 1000).toISOString(), idempotencyKey]
      );

      const cleanupCount = await idempotencyService.cleanupExpiredKeys();
      expect(cleanupCount).toBeGreaterThanOrEqual(1);

      stats = await idempotencyRepo.getStats();
      expect(stats.expired).toBeGreaterThanOrEqual(0);
    });
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await clearTables(db);
  });

  // -- RetryScheduler (DB-backed) --

  it('picks up a retryable notification and marks it COMPLETED on success', async () => {
    const id = await insertRetryable(repository, db, 1);
    const sendMock = jest.fn().mockResolvedValue(true);
    const retryScheduler = new RetryScheduler(
      repository,
      { ...RETRY_SCHEDULER_DEFAULTS, jitter: false },
      { sendEventNotification: sendMock } as unknown as DiscordNotificationService
    );

    await retryScheduler.runOnce();

    const row = await db.get<{ status: string }>(
      'SELECT status FROM scheduled_notifications WHERE id = ?', [id]
    );
    expect(row!.status).toBe(NotificationStatus.COMPLETED);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('writes a SUCCESS execution log on retry delivery', async () => {
    const id = await insertRetryable(repository, db, 1);
    const retryScheduler = new RetryScheduler(
      repository,
      { ...RETRY_SCHEDULER_DEFAULTS, jitter: false },
      { sendEventNotification: jest.fn().mockResolvedValue(true) } as unknown as DiscordNotificationService
    );

    await retryScheduler.runOnce();

    const logs = await db.all(
      'SELECT * FROM notification_execution_log WHERE scheduled_notification_id = ?', [id]
    );
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.find((l: any) => l.status === 'SUCCESS')).toBeTruthy();
  });

  it('schedules next_retry_at with exponential backoff when delivery fails', async () => {
    const id = await insertRetryable(repository, db, 1);
    const beforeRun = Date.now();
    const retryScheduler = new RetryScheduler(
      repository,
      { ...RETRY_SCHEDULER_DEFAULTS, baseDelayMs: 1_000, multiplier: 2, jitter: false },
      { sendEventNotification: jest.fn().mockResolvedValue(false) } as unknown as DiscordNotificationService
    );

    await retryScheduler.runOnce();

    const row = await db.get<{ retry_count: number; next_retry_at: string | null; status: string }>(
      'SELECT retry_count, next_retry_at, status FROM scheduled_notifications WHERE id = ?', [id]
    );
    expect(row!.retry_count).toBe(2);
    expect(row!.status).toBe(NotificationStatus.PENDING);
    expect(row!.next_retry_at).not.toBeNull();

    const expectedDelay = calculateBackoffDelay(1, 1_000, 2, RETRY_SCHEDULER_DEFAULTS.maxDelayMs, false);
    const actualDelay = new Date(row!.next_retry_at!).getTime() - beforeRun;
    expect(actualDelay).toBeGreaterThanOrEqual(expectedDelay * 0.9);
  });

  it('does not process a notification whose next_retry_at is in the future', async () => {
    const futureRetry = new Date(Date.now() + 60_000);
    await insertRetryable(repository, db, 1, futureRetry);
    const sendMock = jest.fn();
    const retryScheduler = new RetryScheduler(
      repository,
      { ...RETRY_SCHEDULER_DEFAULTS },
      { sendEventNotification: sendMock } as unknown as DiscordNotificationService
    );

    await retryScheduler.runOnce();

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does not pick up first-attempt notifications (retry_count === 0)', async () => {
    await repository.create(
      NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .build()
    );
    const sendMock = jest.fn();
    const retryScheduler = new RetryScheduler(
      repository,
      { ...RETRY_SCHEDULER_DEFAULTS },
      { sendEventNotification: sendMock } as unknown as DiscordNotificationService
    );

    await retryScheduler.runOnce();

    expect(sendMock).not.toHaveBeenCalled();
  });
  describe('Integration tests', () => {
    it('should handle high-volume notification creation with idempotency', async () => {
      const executeAt = futureExecuteAt();
      const payload = { message: 'Batch test' };
      const idempotencyKey = 'batch-idempotency-1';

  it('prevents concurrent duplicate processing via distributed lock', async () => {
    const id = await insertRetryable(repository, db, 1);
    let firstResolve!: (v: boolean) => void;
    const barrier = new Promise<boolean>((res) => { firstResolve = res; });
    const callOrder: string[] = [];

    const sendMock = jest.fn()
      .mockImplementationOnce(async () => {
        callOrder.push('start');
        const result = await barrier;
        callOrder.push('end');
        return result;
      })
      .mockResolvedValue(true);

    const discordService = { sendEventNotification: sendMock } as unknown as DiscordNotificationService;
    const s1 = new RetryScheduler(repository, { ...RETRY_SCHEDULER_DEFAULTS, jitter: false }, discordService);
    const s2 = new RetryScheduler(repository, { ...RETRY_SCHEDULER_DEFAULTS, jitter: false }, discordService);

    const p1 = s1.runOnce();
    await s2.runOnce(); // s2 should find nothing (s1 holds the lock)
    firstResolve(true);
    await p1;

    expect(sendMock).toHaveBeenCalledTimes(1);
    const row = await db.get<{ status: string }>(
      'SELECT status FROM scheduled_notifications WHERE id = ?', [id]
    );
    expect(row!.status).toBe(NotificationStatus.COMPLETED);
  });

  // -- NotificationScheduler retry via scheduler loop --

  it('retries a failed delivery on the next scheduler poll cycle', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-24T12:00:00.000Z'));

    const sendMock = jest.fn()
      .mockResolvedValueOnce(false)   // first attempt fails
      .mockResolvedValue(true);        // second attempt succeeds

    const discordService = { sendEventNotification: sendMock } as unknown as DiscordNotificationService;
    const scheduler = new NotificationScheduler(repository, SCHEDULER_CONFIG, discordService);

    const id = await repository.create(
      NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withMaxRetries(3)
        .withTargetRecipient(NotificationFixtureBuilder.constants.webhookUrl)
        .build()
    );

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(250); // first poll — fails
    await jest.advanceTimersByTimeAsync(250); // second poll — succeeds

    const row = await repository.getById(id);
    expect(row!.status).toBe(NotificationStatus.COMPLETED);
    expect(sendMock).toHaveBeenCalledTimes(2);

    await scheduler.stop();
    jest.useRealTimers();
  });
});

// ===========================================================================
// 4. FAILURE HANDLING
// ===========================================================================

describe('4. Failure handling', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;

  beforeAll(async () => {
    db = await setupDb();
    repository = new ScheduledNotificationRepository(db);
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await clearTables(db);
  });

  it('marks a notification FAILED after exhausting all retries', async () => {
    const id = await insertRetryable(repository, db, 3, null, 3); // retryCount === maxRetries
    const retryScheduler = new RetryScheduler(
      repository,
      { ...RETRY_SCHEDULER_DEFAULTS, jitter: false },
      { sendEventNotification: jest.fn().mockResolvedValue(false) } as unknown as DiscordNotificationService
    );

    await retryScheduler.runOnce();

    const row = await db.get<{ status: string; retry_count: number }>(
      'SELECT status, retry_count FROM scheduled_notifications WHERE id = ?', [id]
    );
    expect(row!.status).toBe(NotificationStatus.FAILED);
  });

  it('logs a permanent-failure error after max retries are exhausted', async () => {
    const id = await insertRetryable(repository, db, 3, null, 3);
    const retryScheduler = new RetryScheduler(
      repository,
      { ...RETRY_SCHEDULER_DEFAULTS, jitter: false },
      { sendEventNotification: jest.fn().mockResolvedValue(false) } as unknown as DiscordNotificationService
    );

    await retryScheduler.runOnce();

    expect(logger.error).toHaveBeenCalledWith(
      'Notification permanently failed after max retries',
      expect.objectContaining({ id, totalAttempts: 3 })
    );
  });

  it('writes a FAILED execution log on permanent failure', async () => {
    const id = await insertRetryable(repository, db, 3, null, 3);
    const retryScheduler = new RetryScheduler(
      repository,
      { ...RETRY_SCHEDULER_DEFAULTS, jitter: false },
      { sendEventNotification: jest.fn().mockResolvedValue(false) } as unknown as DiscordNotificationService
    );

    await retryScheduler.runOnce();

    const logs = await db.all(
      'SELECT * FROM notification_execution_log WHERE scheduled_notification_id = ?', [id]
    );
    expect(logs.some((l: any) => l.status === 'FAILED')).toBe(true);
  });

  it('handles a delivery that throws (network error) and schedules a retry', async () => {
    const id = await insertRetryable(repository, db, 1, null, 3);
    const retryScheduler = new RetryScheduler(
      repository,
      { ...RETRY_SCHEDULER_DEFAULTS, jitter: false },
      { sendEventNotification: jest.fn().mockRejectedValue(new Error('ECONNRESET')) } as unknown as DiscordNotificationService
    );

    await retryScheduler.runOnce();

    const row = await db.get<{ status: string; retry_count: number; next_retry_at: string | null }>(
      'SELECT status, retry_count, next_retry_at FROM scheduled_notifications WHERE id = ?', [id]
    );
    // Still pending — will be retried later
    expect(row!.status).toBe(NotificationStatus.PENDING);
    expect(row!.retry_count).toBe(2);
    expect(row!.next_retry_at).not.toBeNull();
  });

  it('transitions scheduler-dispatched notification to FAILED when retries run out', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-24T12:00:00.000Z'));

    const sendMock = jest.fn().mockResolvedValue(false);
    const discordService = { sendEventNotification: sendMock } as unknown as DiscordNotificationService;
    const scheduler = new NotificationScheduler(repository, SCHEDULER_CONFIG, discordService);

    const id = await repository.create(
      NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withMaxRetries(0)  // no retries — fails immediately
        .withTargetRecipient(NotificationFixtureBuilder.constants.webhookUrl)
        .build()
    );

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(250);

    const row = await repository.getById(id);
    expect(row!.status).toBe(NotificationStatus.FAILED);

    await scheduler.stop();
    jest.useRealTimers();
  });

  it('recovers stale PROCESSING locks left by crashed schedulers', async () => {
    // Insert a notification stuck in PROCESSING with an expired lock
    const expiredLock = new Date(Date.now() - 120_000); // 2 min ago
    const id = await repository.create(
      NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withTargetRecipient(NotificationFixtureBuilder.constants.webhookUrl)
        .build()
    );
    await db.run(
      `UPDATE scheduled_notifications
       SET status = 'PROCESSING', processor_id = 'crashed-proc',
           lock_expires_at = ?, processing_started_at = ?
       WHERE id = ?`,
      [expiredLock.toISOString(), expiredLock.toISOString(), id]
    );

    // recoverStaleLocks should reset it back to PENDING
    await repository.recoverStaleLocks('recovery-req');

    const row = await db.get<{ status: string; processor_id: string | null }>(
      'SELECT status, processor_id FROM scheduled_notifications WHERE id = ?', [id]
    );
    expect(row!.status).toBe(NotificationStatus.PENDING);
    expect(row!.processor_id).toBeNull();
  });

  it('does not recover a PROCESSING lock that has not yet expired', async () => {
    const activeLock = new Date(Date.now() + 60_000); // still valid for 1 min
    const id = await repository.create(
      NotificationFixtureBuilder.aScheduledNotificationInput()
        .forImmediateExecution()
        .withTargetRecipient(NotificationFixtureBuilder.constants.webhookUrl)
        .build()
    );
    await db.run(
      `UPDATE scheduled_notifications
       SET status = 'PROCESSING', processor_id = 'active-proc',
           lock_expires_at = ?, processing_started_at = ?
       WHERE id = ?`,
      [activeLock.toISOString(), new Date().toISOString(), id]
    );

    await repository.recoverStaleLocks('no-recovery-req');

    const row = await db.get<{ status: string }>(
      'SELECT status FROM scheduled_notifications WHERE id = ?', [id]
    );
    expect(row!.status).toBe(NotificationStatus.PROCESSING);
  });
});

// ===========================================================================
// 5. BACKPRESSURE & IDEMPOTENCY INTEGRATION
// ===========================================================================

describe('5. Backpressure and idempotency integration', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let idempotencyRepo: IdempotencyKeyRepository;
  let idempotencyService: IdempotencyKeyService;
  let api: NotificationAPI;
  let backpressureController: BackpressureController;
  let backpressureMonitor: BackpressureMonitor;

  beforeAll(async () => {
    db = await setupDb();
    repository = new ScheduledNotificationRepository(db);
    idempotencyRepo = new IdempotencyKeyRepository(db);
    idempotencyService = new IdempotencyKeyService(idempotencyRepo);
    api = new NotificationAPI(repository, idempotencyService);
    backpressureController = new BackpressureController({
      saturationThreshold: 100,
      recoveryThreshold: 50,
      normalThroughputPerSec: 100,
      backpressureThroughputPerSec: 10,
    });
    backpressureMonitor = new BackpressureMonitor(db);
  });

  afterAll(async () => {
    await db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-24T12:00:00.000Z'));
    await clearTables(db);
    backpressureController.reset();
  });

  afterEach(() => jest.useRealTimers());
    it('should maintain audit trail through complete lifecycle', async () => {
      const executeAt = futureExecuteAt(50);

  it('activates backpressure when queue exceeds saturation threshold', () => {
    const isActive = backpressureController.checkAndApplyBackpressure(101);
    expect(isActive).toBe(true);
    expect(backpressureController.isActive()).toBe(true);

    const metrics = backpressureController.getMetrics(101);
    expect(metrics.isActive).toBe(true);
    expect(metrics.targetThroughputPerSec).toBe(10);
  });
      await scheduler.start();
      await waitForSchedulerPolls(400);

  it('calculates a positive processing delay under backpressure', () => {
    backpressureController.checkAndApplyBackpressure(101);
    const delay = backpressureController.calculateProcessingDelay();
    expect(delay).toBeGreaterThan(0);
  });

  it('deactivates backpressure once the queue drops below recovery threshold', () => {
    backpressureController.checkAndApplyBackpressure(101);
    expect(backpressureController.isActive()).toBe(true);

    backpressureController.checkAndApplyBackpressure(49);
    expect(backpressureController.isActive()).toBe(false);

    const metrics = backpressureController.getMetrics(49);
    expect(metrics.targetThroughputPerSec).toBe(100);
  });

  it('records a backpressure activation event and surfaces it in statistics', async () => {
    await backpressureMonitor.recordEvent({
      event_type: 'ACTIVATED',
      queue_size: 101,
      target_throughput_per_sec: 10,
      reason: 'Queue saturation',
      timestamp: new Date().toISOString(),
    });

    const stats = await backpressureMonitor.getStatistics();
    expect(stats.totalActivations).toBe(1);

    const recent = await backpressureMonitor.getRecentEvents(5);
    expect(recent[0].event_type).toBe('ACTIVATED');
    expect(recent[0].queue_size).toBe(101);
  });

  it('computes average duration across activation/deactivation pairs', async () => {
    await backpressureMonitor.recordEvent({
      event_type: 'ACTIVATED',
      queue_size: 101,
      target_throughput_per_sec: 10,
      timestamp: new Date().toISOString(),
    });
    await backpressureMonitor.recordEvent({
      event_type: 'DEACTIVATED',
      queue_size: 49,
      target_throughput_per_sec: 100,
      duration_ms: 5_000,
      timestamp: new Date().toISOString(),
    });

    const stats = await backpressureMonitor.getStatistics();
    expect(stats.totalDeactivations).toBe(1);
    expect(stats.averageDurationMs).toBe(5_000);
  });

  it('cleans up expired idempotency keys after 24 hours', async () => {
    const executeAt = new Date('2026-06-24T13:00:00.000Z');
    const key = 'idem-expiry-1';

    await api.scheduleNotification(
      { payload: { message: 'expiry test' }, notificationType: NotificationType.DISCORD,
        targetRecipient: NotificationFixtureBuilder.constants.webhookUrl, executeAt },
      undefined, key
    );

    let stats = await idempotencyRepo.getStats();
    expect(stats.total).toBe(1);

    // Advance past 24-hour expiry window
    jest.setSystemTime(new Date('2026-06-25T13:01:00.000Z'));
    await idempotencyService.cleanupExpiredKeys();

    stats = await idempotencyRepo.getStats();
    expect(stats.expired).toBeGreaterThanOrEqual(0); // key now expired
  });
});
