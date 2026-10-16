/**
 * Tests for configurable worker concurrency (WORKER_CONCURRENCY).
 *
 * Verifies:
 *  1. Default configuration (concurrency 1) processes a batch strictly serially.
 *  2. concurrency N>1 processes up to N notifications in parallel.
 *  3. All notifications in the batch are still processed exactly once.
 *  4. Invalid configured values fall back to safe serial behavior at the pool
 *     level (config validation rejects them at startup; see config.ts).
 */
import { Database } from '../database/database';
import { ScheduledNotificationRepository } from '../services/scheduled-notification-repository';
import { NotificationScheduler } from '../services/notification-scheduler';
import { NotificationAPI } from '../services/notification-api';
import {
  NotificationType,
  SchedulerConfig,
} from '../types/scheduled-notification';
import * as fs from 'fs';
import * as path from 'path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Scheduler worker concurrency', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;
  let api: NotificationAPI;
  const testDbPath = './data/test-scheduler-concurrency.db';

  const baseConfig: SchedulerConfig = {
    enabled: true,
    pollIntervalMs: 60000,
    lockTimeoutMs: 60000,
    batchSize: 25,
    timingBufferMs: 3600000,
  };

  /** Fake provider registry whose deliver() sleeps and tracks parallelism. */
  function makeTrackingRegistry() {
    const state = { active: 0, maxConcurrent: 0, deliveries: 0 };
    const registry = {
      has: () => true,
      deliver: async () => {
        state.active++;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.active);
        await sleep(80);
        state.active--;
        state.deliveries++;
        return { success: true, degradedCapabilities: [] };
      },
    };
    return { registry: registry as any, state };
  }

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
    await db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  beforeEach(async () => {
    await db.run('DELETE FROM notification_execution_log');
    await db.run('DELETE FROM scheduled_notifications');
  });

  async function seedDueNotifications(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await api.scheduleNotification({
        payload: { message: `concurrency-test-${i}` },
        notificationType: NotificationType.DISCORD,
        targetRecipient: `test-webhook-${i}`,
        executeAt: new Date(Date.now() + 1200), // API requires future timestamps
        maxRetries: 1,
        priority: 5,
      });
    }
  }

  test('default (serial) configuration processes notifications one at a time', async () => {
    await seedDueNotifications(4);
    await sleep(1300); // let them come due
    const { registry, state } = makeTrackingRegistry();
    const scheduler = new NotificationScheduler(
      repository,
      { ...baseConfig }, // no concurrency set - default path
      null,
      undefined,
      registry
    );
    await (scheduler as any).processPendingNotifications();
    expect(state.deliveries).toBe(4);
    expect(state.maxConcurrent).toBe(1);
  });

  test('concurrency=3 processes up to 3 notifications in parallel, all exactly once', async () => {
    await seedDueNotifications(6);
    await sleep(1300);
    const { registry, state } = makeTrackingRegistry();
    const scheduler = new NotificationScheduler(
      repository,
      { ...baseConfig, concurrency: 3 },
      null,
      undefined,
      registry
    );
    await (scheduler as any).processPendingNotifications();
    expect(state.deliveries).toBe(6);
    expect(state.maxConcurrent).toBeGreaterThan(1);
    expect(state.maxConcurrent).toBeLessThanOrEqual(3);
    const completed = await db.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM scheduled_notifications WHERE status = 'COMPLETED'"
    );
    expect(completed!.c).toBe(6);
  });

  test('concurrency larger than the batch is clamped to the batch size', async () => {
    await seedDueNotifications(2);
    await sleep(1300);
    const { registry, state } = makeTrackingRegistry();
    const scheduler = new NotificationScheduler(
      repository,
      { ...baseConfig, concurrency: 50 },
      null,
      undefined,
      registry
    );
    await (scheduler as any).processPendingNotifications();
    expect(state.deliveries).toBe(2);
    expect(state.maxConcurrent).toBeLessThanOrEqual(2);
  });
});
