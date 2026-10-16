/**
 * Durable notification queue semantics on top of the `scheduled_notifications`
 * table (GitHub issue #780).
 *
 * The in-process schedulers treat the table as the queue: `create()` enqueues,
 * `fetchAndLockPendingNotifications()` dequeues with an atomic claim, and the
 * claim lease is renewed while the job is being delivered. These tests pin the
 * three acceptance criteria:
 *
 *   1. queued notifications survive an application restart;
 *   2. a job cannot be processed by two workers at the same time;
 *   3. a failed job retains its processing state.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { Database } from '../database/database';
import { ScheduledNotificationRepository } from './scheduled-notification-repository';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';

const testDbPath = path.join(__dirname, '../../test-data/test-scheduled-notification-queue.db');

function dueNow(offsetMs = -1_000): Date {
  return new Date(Date.now() + offsetMs);
}

async function removeTestDatabase(): Promise<void> {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    await fs.unlink(`${testDbPath}${suffix}`).catch(() => undefined);
  }
}

describe('Durable notification queue', () => {
  let db: Database;
  let repository: ScheduledNotificationRepository;

  beforeEach(async () => {
    await removeTestDatabase();

    db = new Database(testDbPath);
    await db.initialize();
    repository = new ScheduledNotificationRepository(db);

    await db.run('DELETE FROM notification_execution_log');
    await db.run('DELETE FROM dead_letter_queue');
    await db.run('DELETE FROM scheduled_notifications');
  });

  afterEach(async () => {
    await db.close();
    await removeTestDatabase();
  });

  // -------------------------------------------------------------------------
  // 1. Queued notifications survive restarts
  // -------------------------------------------------------------------------

  it('returns a job enqueued before a restart from a fresh database handle', async () => {
    const id = await repository.create({
      payload: { message: 'survives the restart' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: dueNow(),
    });

    // Simulated application restart: tear the connection down completely and
    // come back with a brand new Database instance over the same file.
    await db.close();
    db = new Database(testDbPath);
    await db.initialize();
    repository = new ScheduledNotificationRepository(db);

    const claimed = await repository.fetchAndLockPendingNotifications('restarted-worker', 30_000, 10);

    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(id);
    expect(claimed[0].status).toBe(NotificationStatus.PROCESSING);
    expect(claimed[0].processorId).toBe('restarted-worker');
    expect(JSON.parse(claimed[0].payload)).toEqual({ message: 'survives the restart' });
  });

  it('requeues a job whose worker died mid-flight after a restart', async () => {
    const id = await repository.create({
      payload: { message: 'interrupted delivery' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: dueNow(),
      maxRetries: 3,
    });

    await repository.fetchAndLockPendingNotifications('doomed-worker', 30_000, 10);

    // The worker is killed before it can complete: the lease it left behind is
    // already in the past when the process comes back up.
    await db.run('UPDATE scheduled_notifications SET lock_expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 1_000).toISOString(),
      id,
    ]);

    await db.close();
    db = new Database(testDbPath);
    await db.initialize();
    repository = new ScheduledNotificationRepository(db);

    const recovered = await repository.recoverStaleLocks();
    expect(recovered).toBe(1);

    const requeued = await repository.getById(id);
    expect(requeued!.status).toBe(NotificationStatus.PENDING);
    expect(requeued!.processorId).toBeNull();
    expect(requeued!.lockExpiresAt).toBeNull();
    expect(requeued!.retryCount).toBe(1);

    // ...and the job is claimable again rather than lost.
    const reClaimed = await repository.fetchAndLockPendingNotifications('next-worker', 30_000, 10);
    expect(reClaimed).toHaveLength(1);
    expect(reClaimed[0].id).toBe(id);
  });

  it('reports queued depth through getPendingJobs across a restart', async () => {
    for (let i = 0; i < 3; i++) {
      await repository.create({
        payload: { message: `job-${i}` },
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: 'https://example.test/hook',
        executeAt: dueNow(),
      });
    }

    await db.close();
    db = new Database(testDbPath);
    await db.initialize();
    repository = new ScheduledNotificationRepository(db);

    const pending = await repository.getPendingJobs();
    expect(pending).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 2. A job cannot be claimed by two workers
  // -------------------------------------------------------------------------

  it('hands each due job to exactly one worker', async () => {
    for (let i = 0; i < 3; i++) {
      await repository.create({
        payload: { message: `job-${i}` },
        notificationType: NotificationType.DISCORD,
        targetRecipient: 'test-webhook',
        executeAt: dueNow(),
      });
    }

    const first = await repository.fetchAndLockPendingNotifications('worker-1', 30_000, 10);
    const second = await repository.fetchAndLockPendingNotifications('worker-2', 30_000, 10);

    expect(first).toHaveLength(3);
    expect(second).toHaveLength(0);
    expect(new Set(first.map((job) => job.id)).size).toBe(3);
    expect(first.every((job) => job.processorId === 'worker-1')).toBe(true);
  });

  it('does not steal a job whose lease the owning worker keeps renewing', async () => {
    const keepAliveId = await repository.create({
      payload: { message: 'long but alive' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: dueNow(),
    });
    const deadId = await repository.create({
      payload: { message: 'worker died' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: dueNow(),
    });

    // Short lease, both delivered for longer than it lasts.
    const claimed = await repository.fetchAndLockPendingNotifications('worker-1', 30, 10);
    expect(claimed.map((job) => job.id).sort()).toEqual([keepAliveId, deadId].sort());

    await new Promise((resolve) => setTimeout(resolve, 80));

    // The live worker renews its own lease; the dead one cannot.
    await expect(repository.renewLock(keepAliveId, 'worker-1', 60_000)).resolves.toBe(true);

    const recovered = await repository.recoverStaleLocks();
    expect(recovered).toBe(1);

    const alive = await repository.getById(keepAliveId);
    expect(alive!.status).toBe(NotificationStatus.PROCESSING);
    expect(alive!.processorId).toBe('worker-1');

    const dead = await repository.getById(deadId);
    expect(dead!.status).toBe(NotificationStatus.PENDING);
    expect(dead!.processorId).toBeNull();
  });

  it('refuses to renew a lease owned by another worker or already finished', async () => {
    const id = await repository.create({
      payload: { message: 'owner check' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: dueNow(),
    });

    await repository.fetchAndLockPendingNotifications('worker-1', 30_000, 10);
    const before = (await repository.getById(id))!.lockExpiresAt!.getTime();

    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(repository.renewLock(id, 'worker-1', 30_000)).resolves.toBe(true);
    const after = (await repository.getById(id))!.lockExpiresAt!.getTime();
    expect(after).toBeGreaterThan(before);

    await expect(repository.renewLock(id, 'worker-2', 30_000)).resolves.toBe(false);

    await repository.markAsCompleted(id);
    await expect(repository.renewLock(id, 'worker-1', 30_000)).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. Failed jobs keep their state (and their backoff)
  // -------------------------------------------------------------------------

  it('does not dequeue a retry that is still inside its backoff window', async () => {
    const id = await repository.create({
      payload: { message: 'retry me later' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: dueNow(),
      maxRetries: 3,
    });

    await repository.fetchAndLockPendingNotifications('worker-1', 30_000, 10);
    await repository.markAsFailedOrRetry(id, new Error('webhook 503'), 0, 3, new Date(Date.now() + 60_000));

    const stored = await repository.getById(id);
    expect(stored!.status).toBe(NotificationStatus.PENDING);
    expect(stored!.retryCount).toBe(1);
    expect(stored!.lastError).toBe('webhook 503');
    expect(stored!.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());

    // Neither dequeue path may jump the persisted backoff.
    await expect(repository.fetchAndLockPendingNotifications('worker-1', 30_000, 10)).resolves.toEqual([]);
    await expect(repository.fetchDueRetries('retry-worker', 30_000, 10)).resolves.toEqual([]);

    // The failed job is still queued, with its retry state intact.
    const stillQueued = await repository.getById(id);
    expect(stillQueued!.retryCount).toBe(1);
    expect(stillQueued!.lastError).toBe('webhook 503');

    // Once the window elapses the retry path picks it up.
    await db.run('UPDATE scheduled_notifications SET next_retry_at = ? WHERE id = ?', [
      new Date(Date.now() - 1_000).toISOString(),
      id,
    ]);

    const due = await repository.fetchDueRetries('retry-worker', 30_000, 10);
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe(id);
    expect(due[0].retryCount).toBe(1);
  });

  it('retains the terminal processing state of a permanently failed job', async () => {
    const id = await repository.create({
      payload: { message: 'never delivers' },
      notificationType: NotificationType.DISCORD,
      targetRecipient: 'test-webhook',
      executeAt: dueNow(),
      maxRetries: 3,
    });

    const claimed = await repository.fetchAndLockPendingNotifications('worker-1', 30_000, 10);
    expect(claimed[0].processingStartedAt).toBeInstanceOf(Date);

    // Second failure of a three-attempt budget: terminal.
    await repository.markAsFailedOrRetry(id, new Error('permanent outage'), 2, 3);

    const failed = await repository.getById(id);
    expect(failed!.status).toBe(NotificationStatus.FAILED);
    expect(failed!.retryCount).toBe(2);
    expect(failed!.lastError).toBe('permanent outage');
    expect(failed!.errorDetails).toContain('permanent outage');
    expect(failed!.processingStartedAt).toBeInstanceOf(Date);
    expect(failed!.processingCompletedAt).toBeInstanceOf(Date);
    expect(failed!.processorId).toBeNull();
    expect(failed!.lockExpiresAt).toBeNull();

    // A terminal job is not claimable, not renewable and not silently retried.
    await expect(repository.fetchAndLockPendingNotifications('worker-1', 30_000, 10)).resolves.toEqual([]);
    await expect(repository.renewLock(id, 'worker-1', 30_000)).resolves.toBe(false);

    const deadLettered = await db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM dead_letter_queue WHERE scheduled_notification_id = ?',
      [id],
    );
    expect(deadLettered!.count).toBe(1);
  });
});
