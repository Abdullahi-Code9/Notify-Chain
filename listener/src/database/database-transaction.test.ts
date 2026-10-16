/**
 * Database transaction rollback tests (#785)
 *
 * Verifies that failed multi-step operations do not leave partially persisted
 * notification state. Uses an in-memory SQLite database so no file system
 * state is needed and every test gets a clean schema.
 *
 * Acceptance criteria:
 *  - Successful transactions commit all writes correctly.
 *  - Failed operations roll back every write made inside the transaction.
 *  - Partial notification records are not left behind after a failure.
 */

import { Database } from './database';
import { ScheduledNotificationRepository } from '../services/scheduled-notification-repository';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupDb(): Promise<Database> {
  const db = new Database(':memory:');
  await db.initialize();
  return db;
}

async function countRows(db: Database, table: string): Promise<number> {
  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row!.n;
}

async function insertNotification(
  db: Database,
  overrides: Partial<{
    status: string;
    retryCount: number;
    maxRetries: number;
    nextRetryAt: string | null;
  }> = {}
): Promise<number> {
  const result = await db.run(
    `INSERT INTO scheduled_notifications
       (payload, notification_type, target_recipient, execute_at,
        status, retry_count, max_retries, next_retry_at)
     VALUES (?, ?, ?, datetime('now', '-1 second'), ?, ?, ?, ?)`,
    [
      JSON.stringify({ test: true }),
      NotificationType.DISCORD,
      'https://discord.com/api/webhooks/test',
      overrides.status ?? NotificationStatus.PENDING,
      overrides.retryCount ?? 0,
      overrides.maxRetries ?? 3,
      overrides.nextRetryAt ?? null,
    ]
  );
  return result.lastID;
}

// ---------------------------------------------------------------------------
// 1. db.transaction() — core primitive
// ---------------------------------------------------------------------------

describe('Database.transaction()', () => {
  let db: Database;

  beforeEach(async () => {
    db = await setupDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('commits all writes when the callback succeeds', async () => {
    await db.transaction(async () => {
      await db.run(
        `INSERT INTO scheduled_notifications
           (payload, notification_type, target_recipient, execute_at)
         VALUES (?, ?, ?, datetime('now'))`,
        [JSON.stringify({ step: 1 }), NotificationType.DISCORD, 'r1']
      );
      await db.run(
        `INSERT INTO scheduled_notifications
           (payload, notification_type, target_recipient, execute_at)
         VALUES (?, ?, ?, datetime('now'))`,
        [JSON.stringify({ step: 2 }), NotificationType.DISCORD, 'r2']
      );
    });

    const count = await countRows(db, 'scheduled_notifications');
    expect(count).toBe(2);
  });

  it('rolls back all writes when the callback throws', async () => {
    await expect(
      db.transaction(async () => {
        await db.run(
          `INSERT INTO scheduled_notifications
             (payload, notification_type, target_recipient, execute_at)
           VALUES (?, ?, ?, datetime('now'))`,
          [JSON.stringify({ step: 1 }), NotificationType.DISCORD, 'r1']
        );
        // Second write violates NOT NULL — triggers rollback
        await db.run(
          `INSERT INTO scheduled_notifications
             (payload, notification_type, target_recipient, execute_at)
           VALUES (NULL, ?, ?, datetime('now'))`,
          [NotificationType.DISCORD, 'r2']
        );
      })
    ).rejects.toThrow();

    // Neither row must be present after the rollback
    const count = await countRows(db, 'scheduled_notifications');
    expect(count).toBe(0);
  });

  it('re-throws the original error after rolling back', async () => {
    const sentinel = new Error('deliberate-failure');

    await expect(
      db.transaction(async () => {
        await db.run(
          `INSERT INTO scheduled_notifications
             (payload, notification_type, target_recipient, execute_at)
           VALUES (?, ?, ?, datetime('now'))`,
          [JSON.stringify({}), NotificationType.DISCORD, 'r1']
        );
        throw sentinel;
      })
    ).rejects.toBe(sentinel);
  });

  it('does not leave a partial notification record behind on rollback', async () => {
    // Pre-existing row before the failed transaction
    const existingId = await insertNotification(db);

    await expect(
      db.transaction(async () => {
        await db.run(
          `INSERT INTO scheduled_notifications
             (payload, notification_type, target_recipient, execute_at)
           VALUES (?, ?, ?, datetime('now'))`,
          [JSON.stringify({ partial: true }), NotificationType.DISCORD, 'partial-recipient']
        );
        throw new Error('abort');
      })
    ).rejects.toThrow('abort');

    const rows = await db.all<{ id: number }>(
      'SELECT id FROM scheduled_notifications'
    );
    // Only the pre-existing row should remain
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(existingId);
  });

  it('allows a subsequent transaction to succeed after a prior rollback', async () => {
    // First transaction — fails
    await expect(
      db.transaction(async () => {
        await db.run(
          `INSERT INTO scheduled_notifications
             (payload, notification_type, target_recipient, execute_at)
           VALUES (?, ?, ?, datetime('now'))`,
          [JSON.stringify({}), NotificationType.DISCORD, 'r1']
        );
        throw new Error('first-failure');
      })
    ).rejects.toThrow();

    // Second transaction — must succeed cleanly
    await db.transaction(async () => {
      await db.run(
        `INSERT INTO scheduled_notifications
           (payload, notification_type, target_recipient, execute_at)
         VALUES (?, ?, ?, datetime('now'))`,
        [JSON.stringify({}), NotificationType.DISCORD, 'r2']
      );
    });

    const count = await countRows(db, 'scheduled_notifications');
    expect(count).toBe(1);
  });

  it('keeps the database fully usable after a rollback', async () => {
    // Cause a rollback
    await expect(
      db.transaction(async () => { throw new Error('x'); })
    ).rejects.toThrow();

    // Non-transactional write must still work
    await db.run(
      `INSERT INTO scheduled_notifications
         (payload, notification_type, target_recipient, execute_at)
       VALUES (?, ?, ?, datetime('now'))`,
      [JSON.stringify({}), NotificationType.DISCORD, 'r1']
    );

    const count = await countRows(db, 'scheduled_notifications');
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. recoverStaleLocks() — transacted multi-row update
// ---------------------------------------------------------------------------

describe('ScheduledNotificationRepository.recoverStaleLocks()', () => {
  let db: Database;
  let repo: ScheduledNotificationRepository;

  beforeEach(async () => {
    db = await setupDb();
    repo = new ScheduledNotificationRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('atomically recovers all stale-locked notifications in one transaction', async () => {
    const lockExpiredAt = new Date(Date.now() - 5_000).toISOString();

    // Two notifications stuck in PROCESSING with an expired lock
    const id1 = await insertNotification(db, { status: NotificationStatus.PROCESSING });
    const id2 = await insertNotification(db, { status: NotificationStatus.PROCESSING });

    await db.run(
      `UPDATE scheduled_notifications
       SET lock_expires_at = ?, processor_id = 'dead-worker'
       WHERE id IN (?, ?)`,
      [lockExpiredAt, id1, id2]
    );

    const recovered = await repo.recoverStaleLocks();

    expect(recovered).toBe(2);

    const rows = await db.all<{ id: number; status: string }>(
      `SELECT id, status FROM scheduled_notifications WHERE id IN (?, ?)`,
      [id1, id2]
    );
    for (const row of rows) {
      // Both must have been moved out of PROCESSING; no partial state
      expect(row.status).not.toBe(NotificationStatus.PROCESSING);
    }
  });

  it('leaves no partial state when an error occurs mid-transaction', async () => {
    const lockExpiredAt = new Date(Date.now() - 5_000).toISOString();

    const id = await insertNotification(db, { status: NotificationStatus.PROCESSING, retryCount: 0, maxRetries: 3 });
    await db.run(
      `UPDATE scheduled_notifications SET lock_expires_at = ?, processor_id = 'worker-1' WHERE id = ?`,
      [lockExpiredAt, id]
    );

    // Spy on db.run to throw on the *second* write inside the transaction
    // (the logExecution INSERT) so the notification UPDATE was already issued
    // but must be rolled back.
    let runCallCount = 0;
    const originalRun = db.run.bind(db);
    jest.spyOn(db, 'run').mockImplementation(async (sql: string, params?: any[]) => {
      // Let BEGIN/COMMIT/ROLLBACK and the initial UPDATE through (calls 1-3),
      // then throw on the execution-log INSERT to simulate a mid-transaction failure.
      runCallCount++;
      if (runCallCount === 4) {
        throw new Error('simulated log write failure');
      }
      return originalRun(sql, params);
    });

    await expect(repo.recoverStaleLocks()).rejects.toThrow('simulated log write failure');

    jest.restoreAllMocks();

    // The notification must still be in PROCESSING — the status update was rolled back
    const row = await db.get<{ status: string; processor_id: string }>(
      'SELECT status, processor_id FROM scheduled_notifications WHERE id = ?',
      [id]
    );
    expect(row!.status).toBe(NotificationStatus.PROCESSING);
    expect(row!.processor_id).toBe('worker-1');
  });

  it('does not modify notifications that are not stale-locked', async () => {
    // One stale-locked notification and one healthy PENDING notification
    const staleId = await insertNotification(db, { status: NotificationStatus.PROCESSING });
    await db.run(
      `UPDATE scheduled_notifications SET lock_expires_at = ?, processor_id = 'dead-worker' WHERE id = ?`,
      [new Date(Date.now() - 5_000).toISOString(), staleId]
    );

    const pendingId = await insertNotification(db, { status: NotificationStatus.PENDING });

    await repo.recoverStaleLocks();

    const pendingRow = await db.get<{ status: string }>(
      'SELECT status FROM scheduled_notifications WHERE id = ?',
      [pendingId]
    );
    expect(pendingRow!.status).toBe(NotificationStatus.PENDING);
  });
});

// ---------------------------------------------------------------------------
// 3. retryDeadLetterNotification() — two-table transacted update
// ---------------------------------------------------------------------------

describe('ScheduledNotificationRepository.retryDeadLetterNotification()', () => {
  let db: Database;
  let repo: ScheduledNotificationRepository;

  beforeEach(async () => {
    db = await setupDb();
    repo = new ScheduledNotificationRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedDeadLetter(db: Database, notificationId: number): Promise<number> {
    const result = await db.run(
      `INSERT INTO dead_letter_queue
         (scheduled_notification_id, notification_type, target_recipient,
          payload, failure_reason, retry_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        notificationId,
        NotificationType.DISCORD,
        'https://discord.com/api/webhooks/test',
        JSON.stringify({ test: true }),
        'max retries exceeded',
        3,
      ]
    );
    return result.lastID;
  }

  it('commits both the notification reset and DLQ update on success', async () => {
    const notifId = await insertNotification(db, { status: NotificationStatus.FAILED, retryCount: 3 });
    const dlqId = await seedDeadLetter(db, notifId);

    const requeued = await repo.retryDeadLetterNotification(dlqId);

    expect(requeued).toBe(true);

    const notifRow = await db.get<{ status: string; retry_count: number }>(
      'SELECT status, retry_count FROM scheduled_notifications WHERE id = ?',
      [notifId]
    );
    expect(notifRow!.status).toBe(NotificationStatus.PENDING);
    expect(notifRow!.retry_count).toBe(0);

    const dlqRow = await db.get<{ last_retried_at: string | null; retry_count: number }>(
      'SELECT last_retried_at, retry_count FROM dead_letter_queue WHERE id = ?',
      [dlqId]
    );
    expect(dlqRow!.last_retried_at).not.toBeNull();
    expect(dlqRow!.retry_count).toBe(4);
  });

  it('rolls back the notification reset when the DLQ update fails', async () => {
    const notifId = await insertNotification(db, { status: NotificationStatus.FAILED, retryCount: 3 });
    const dlqId = await seedDeadLetter(db, notifId);

    // Force the DLQ UPDATE to fail so the notification reset must be rolled back too
    let runCallCount = 0;
    const originalRun = db.run.bind(db);
    jest.spyOn(db, 'run').mockImplementation(async (sql: string, params?: any[]) => {
      runCallCount++;
      // The DLQ update is the second db.run() call inside the transaction callback
      if (sql.includes('dead_letter_queue')) {
        throw new Error('simulated DLQ write failure');
      }
      return originalRun(sql, params);
    });

    await expect(repo.retryDeadLetterNotification(dlqId)).rejects.toThrow(
      'simulated DLQ write failure'
    );

    jest.restoreAllMocks();

    // The notification must still be FAILED — the reset was rolled back
    const notifRow = await db.get<{ status: string; retry_count: number }>(
      'SELECT status, retry_count FROM scheduled_notifications WHERE id = ?',
      [notifId]
    );
    expect(notifRow!.status).toBe(NotificationStatus.FAILED);
    expect(notifRow!.retry_count).toBe(3);

    // The DLQ row must be unmodified (last_retried_at still null)
    const dlqRow = await db.get<{ last_retried_at: string | null; retry_count: number }>(
      'SELECT last_retried_at, retry_count FROM dead_letter_queue WHERE id = ?',
      [dlqId]
    );
    expect(dlqRow!.last_retried_at).toBeNull();
    expect(dlqRow!.retry_count).toBe(3);
  });

  it('leaves zero partial records when retrying a non-existent DLQ entry', async () => {
    const before = await countRows(db, 'scheduled_notifications');
    const result = await repo.retryDeadLetterNotification(99999);

    expect(result).toBe(false);
    expect(await countRows(db, 'scheduled_notifications')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 4. markAsFailedOrRetry() + moveToDeadLetterQueue() — untransacted pair
// ---------------------------------------------------------------------------

describe('ScheduledNotificationRepository.markAsFailedOrRetry() — partial-state documentation', () => {
  let db: Database;
  let repo: ScheduledNotificationRepository;

  beforeEach(async () => {
    db = await setupDb();
    repo = new ScheduledNotificationRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('commits the status change and creates a DLQ entry on permanent failure', async () => {
    const id = await insertNotification(db, { retryCount: 2, maxRetries: 3 });

    await repo.markAsFailedOrRetry(id, new Error('delivery failed'), 2, 3);

    const row = await db.get<{ status: string; retry_count: number }>(
      'SELECT status, retry_count FROM scheduled_notifications WHERE id = ?',
      [id]
    );
    expect(row!.status).toBe(NotificationStatus.FAILED);

    const dlqCount = await countRows(db, 'dead_letter_queue');
    expect(dlqCount).toBe(1);
  });

  it('updates to PENDING and sets next_retry_at when retries remain', async () => {
    const id = await insertNotification(db, { retryCount: 0, maxRetries: 3 });
    const nextRetry = new Date(Date.now() + 5_000);

    await repo.markAsFailedOrRetry(id, new Error('temporary failure'), 0, 3, nextRetry);

    const row = await db.get<{ status: string; retry_count: number; next_retry_at: string | null }>(
      'SELECT status, retry_count, next_retry_at FROM scheduled_notifications WHERE id = ?',
      [id]
    );
    expect(row!.status).toBe(NotificationStatus.PENDING);
    expect(row!.retry_count).toBe(1);
    expect(row!.next_retry_at).not.toBeNull();

    // No DLQ entry for a non-final failure
    const dlqCount = await countRows(db, 'dead_letter_queue');
    expect(dlqCount).toBe(0);
  });

  it('documents that the status update persists even when the DLQ insert throws', async () => {
    // This test documents the current (known) atomicity gap between the
    // scheduled_notifications UPDATE and the dead_letter_queue INSERT inside
    // markAsFailedOrRetry(). They are sequential db.run() calls with no
    // wrapping transaction, so a failure in the DLQ step leaves the
    // notification marked FAILED with no corresponding DLQ record.
    const id = await insertNotification(db, { retryCount: 2, maxRetries: 3 });

    const originalRun = db.run.bind(db);
    jest.spyOn(db, 'run').mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes('dead_letter_queue')) {
        throw new Error('DLQ table unavailable');
      }
      return originalRun(sql, params);
    });

    await expect(
      repo.markAsFailedOrRetry(id, new Error('delivery failed'), 2, 3)
    ).rejects.toThrow('DLQ table unavailable');

    jest.restoreAllMocks();

    // Status IS persisted (the UPDATE ran before the DLQ insert threw)
    const row = await db.get<{ status: string }>(
      'SELECT status FROM scheduled_notifications WHERE id = ?',
      [id]
    );
    expect(row!.status).toBe(NotificationStatus.FAILED);

    // DLQ has NO record — partial state is present
    const dlqCount = await countRows(db, 'dead_letter_queue');
    expect(dlqCount).toBe(0);
  });
});
