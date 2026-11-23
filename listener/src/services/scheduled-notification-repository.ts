import { Database } from '../database/database';
import logger from '../utils/logger';
import { compressPayload, decompressPayload } from '../utils/payload-compression';
import {
  ScheduledNotification,
  ScheduledNotificationRow,
  CreateScheduledNotificationInput,
  NotificationStatus,
  NotificationExecutionLog,
  DeadLetterQueueEntry,
  ScheduleRecoveryPolicy,
  RecurrenceRule,
} from '../types/scheduled-notification';
import { assertScheduleTransition } from './schedule-state-machine';
import { hashPayload } from '../utils/payload-integrity';
import {
  NotificationStatsCache,
  getStatsCache,
  NotificationStats,
  QueueOperationalMetrics,
} from './notification-stats-cache';
import { calculateNextRun } from './recurrence';
import { ScheduleAuditTrail } from './schedule-audit-trail';

/**
 * Repository for scheduled notifications database operations
 * Handles all CRUD operations and queries
 */
export class ScheduledNotificationRepository {
  private statsCache: NotificationStatsCache;
  private scheduleAudit: ScheduleAuditTrail | null = null;

  constructor(
    private db: Database,
    statsCache?: NotificationStatsCache,
    private defaultTtlSeconds: number = 0,
  ) {
    this.statsCache = statsCache ?? getStatsCache();
  }

  setScheduleAuditTrail(audit: ScheduleAuditTrail | null): void {
    this.scheduleAudit = audit;
  }

  /**
   * Create a new scheduled notification.
   * If a deduplicationKey is provided and a notification with that key already
   * exists, the existing notification's id is returned without creating a duplicate.
   */
  async create(input: CreateScheduledNotificationInput, requestId?: string): Promise<number> {
    const payloadJson = JSON.stringify(input.payload);
    const secret = process.env.PAYLOAD_INTEGRITY_SECRET;
    const payloadHash = secret ? hashPayload(payloadJson, secret) : null;
    const now = new Date().toISOString();

    const sql = `
      INSERT INTO scheduled_notifications (
        payload, payload_hash, notification_type, target_recipient, execute_at, expires_at,
        created_at, updated_at, status, retry_count, max_retries, processing_started_at,
        processing_completed_at, processor_id, lock_expires_at, last_error, error_details,
        event_id, contract_address, priority, metadata, next_retry_at, deduplication_key,
        recurrence_rule, occurrence_count, last_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const serializedPayload = compressPayload(input.payload);

    const params = [
      serializedPayload,
      payloadHash,
      input.notificationType,
      input.targetRecipient,
      input.executeAt.toISOString(),
      input.expiresAt !== undefined
        ? input.expiresAt === null
          ? null
          : this.normalizeExpiration(input.expiresAt)
        : this.defaultTtlSeconds > 0
          ? new Date(Date.now() + this.defaultTtlSeconds * 1000).toISOString()
          : null,
      now,
      now,
      NotificationStatus.PENDING,
      0,
      input.maxRetries ?? 3,
      null,
      null,
      null,
      null,
      null,
      null,
      input.eventId ?? null,
      input.contractAddress ?? null,
      input.priority ?? 5,
      input.metadata ? JSON.stringify(input.metadata) : null,
      null,
      input.deduplicationKey ?? null,
      input.recurrence
        ? JSON.stringify({ ...input.recurrence, interval: input.recurrence.interval ?? 1 })
        : null,
      0,
      null,
    ];

    try {
      const result = await this.db.run(sql, params);

      this.statsCache.invalidate();

      logger.info('Scheduled notification created', {
        requestId,
        id: result.lastID,
        executeAt: input.executeAt,
        type: input.notificationType,
      });

      return result.lastID;
    } catch (err) {
      if (input.deduplicationKey && (err as any)?.message?.includes('UNIQUE constraint failed')) {
        const existing = await this.db.get<{ id: number }>(
          'SELECT id FROM scheduled_notifications WHERE deduplication_key = ?',
          [input.deduplicationKey],
        );

        if (existing) {
          logger.info('Duplicate notification skipped — deduplication key already exists', {
            requestId,
            deduplicationKey: input.deduplicationKey,
            existingId: existing.id,
          });
          return existing.id;
        }
      }

      throw err;
    }
  }

  private normalizeExpiration(value: Date | string | number): string {
    const milliseconds =
      typeof value === 'number' && Math.abs(value) < 100_000_000_000
        ? value * 1000
        : value instanceof Date
          ? value.getTime()
          : typeof value === 'number'
            ? value
            : Date.parse(value);
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) {
      throw new Error('expiresAt must be a valid ISO-8601 timestamp or epoch');
    }
    return date.toISOString();
  }

  /**
   * Hard upper bound on scheduler claim batch size (#970).
   * Prevents a single poll from locking an unbounded due set.
   */
  static readonly MAX_SCHEDULER_BATCH_SIZE = 100;

  /**
   * Dequeue pending notifications due for execution with distributed locking.
   * Uses a single atomic UPDATE ... WHERE id IN (SELECT ...) so two workers
   * polling at the same time can never claim the same row.
   *
   * ## Fairness selection policy (#970)
   * Due jobs are grouped by `COALESCE(contract_address, event_id, notification_type, 'default')`.
   * Within each group, jobs are ordered by priority ASC, execute_at ASC, id ASC.
   * The batch is filled **round-robin across groups** (rank 1 from every group,
   * then rank 2, …) so one large due group cannot indefinitely delay other
   * eligible schedule groups. Batch size is capped at MAX_SCHEDULER_BATCH_SIZE.
   *
   * A job whose `next_retry_at` is still in the future is deliberately skipped:
   * it is waiting out its exponential backoff and is claimed by the retry path
   * (`fetchDueRetries`) once that window has elapsed. Claiming it here would
   * discard the persisted backoff state and let the main scheduler race the
   * retry scheduler for the same row.
   */
  async fetchAndLockPendingNotifications(
    processorId: string,
    lockTimeoutMs: number,
    batchSize: number = 10,
    requestId?: string,
  ): Promise<ScheduledNotification[]> {
    assertScheduleTransition(NotificationStatus.PENDING, NotificationStatus.PROCESSING);
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + lockTimeoutMs);
    const cappedBatch = Math.min(
      Math.max(1, Math.floor(batchSize) || 1),
      ScheduledNotificationRepository.MAX_SCHEDULER_BATCH_SIZE,
    );

    // Fair round-robin selection across schedule groups, then atomic lock.
    const updateSql = `
      UPDATE scheduled_notifications
      SET 
        status = ?,
        processor_id = ?,
        lock_expires_at = ?,
        processing_started_at = ?
      WHERE id IN (
        SELECT id FROM scheduled_notifications
        WHERE status = ?
          AND recovery_state IS NULL
          AND execute_at <= ?
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY priority ASC, execute_at ASC
        LIMIT ?
        WITH due AS (
          SELECT
            id,
            priority,
            execute_at,
            COALESCE(contract_address, event_id, notification_type, 'default') AS schedule_group,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(contract_address, event_id, notification_type, 'default')
              ORDER BY priority ASC, execute_at ASC, id ASC
            ) AS group_rank
          FROM scheduled_notifications
          WHERE status = ?
            AND execute_at <= ?
            AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ),
        fair AS (
          SELECT
            id,
            ROW_NUMBER() OVER (
              ORDER BY group_rank ASC, priority ASC, execute_at ASC, id ASC
            ) AS pick_order
          FROM due
        )
        SELECT id FROM fair
        WHERE pick_order <= ?
        ORDER BY pick_order
      )
    `;

    const updateParams = [
      NotificationStatus.PROCESSING,
      processorId,
      lockExpiresAt.toISOString(),
      now.toISOString(),
      NotificationStatus.PENDING,
      now.toISOString(),
      now.toISOString(),
      cappedBatch,
    ];

    const updateResult = await this.db.run(updateSql, updateParams);

    if (updateResult.changes === 0) {
      return [];
    }

    // Fetch the locked notifications
    const selectSql = `
      SELECT * FROM scheduled_notifications
      WHERE processor_id = ? AND status = ? AND lock_expires_at = ?
    `;

    const rows = await this.db.all<ScheduledNotificationRow>(selectSql, [
      processorId,
      NotificationStatus.PROCESSING,
      lockExpiresAt.toISOString(),
    ]);

    logger.info('Fetched and locked pending notifications', {
      requestId,
      count: rows.length,
      processorId,
      batchSize: cappedBatch,
      selectionPolicy: 'round-robin-by-schedule-group',
    });

    return rows.map(this.rowToModel);
  }

  /**
   * Renew the claim lease on an in-flight notification (heartbeat).
   *
   * Extends `lock_expires_at` only while this processor still owns the row, so a
   * worker that lost its claim can never take it back. Returns false when the
   * lease is no longer held — the job has already reached a terminal state, was
   * recovered by `recoverStaleLocks`, or was claimed by another worker.
   *
   * Without this heartbeat a delivery that outlives `lockTimeoutMs` is reset to
   * PENDING by the next `recoverStaleLocks` poll (both schedulers call it) while
   * the original worker is still sending, which is exactly how one job gets
   * processed by two workers at once.
   */
  async renewLock(
    id: number,
    processorId: string,
    lockTimeoutMs: number,
    requestId?: string,
  ): Promise<boolean> {
    const lockExpiresAt = new Date(Date.now() + lockTimeoutMs).toISOString();

    const result = await this.db.run(
      `
        UPDATE scheduled_notifications
        SET lock_expires_at = ?
        WHERE id = ? AND processor_id = ? AND status = ?
      `,
      [lockExpiresAt, id, processorId, NotificationStatus.PROCESSING],
    );

    const renewed = result.changes > 0;

    if (renewed) {
      logger.debug('Renewed notification claim lease', {
        requestId,
        id,
        processorId,
        lockExpiresAt,
      });
    }

    return renewed;
  }

  /**
   * Recover stale locks (when a processor crashes)
   * Returns notifications with expired locks back to PENDING
   */
  async recoverStaleLocks(requestId?: string): Promise<number> {
    const now = new Date();
    let recoveredCount = 0;

    await this.db.transaction(async () => {
      const selectSql = `
        SELECT * FROM scheduled_notifications
        WHERE status = ?
          AND lock_expires_at IS NOT NULL
          AND lock_expires_at < ?
      `;

      const rows = await this.db.all<ScheduledNotificationRow>(selectSql, [
        NotificationStatus.PROCESSING,
        now.toISOString(),
      ]);

      recoveredCount = rows.length;

      for (const row of rows) {
        const model = this.rowToModel(row);
        const newRetryCount = model.retryCount + 1;
        const isFailed = newRetryCount >= model.maxRetries;
        const newStatus = isFailed ? NotificationStatus.DEAD_LETTERED : NotificationStatus.PENDING;
        assertScheduleTransition(NotificationStatus.PROCESSING, newStatus);

        const updateSql = `
          UPDATE scheduled_notifications
          SET 
            status = ?,
            retry_count = ?,
            last_error = ?,
            error_details = ?,
            processing_completed_at = ?,
            updated_at = ?,
            processor_id = NULL,
            lock_expires_at = NULL
          WHERE id = ?
        `;

        const errorMsg = 'Lock expired/Processor timeout';
        const errorDetails = JSON.stringify({
          message: errorMsg,
          timestamp: now.toISOString(),
        });

        await this.db.run(updateSql, [
          newStatus,
          newRetryCount,
          errorMsg,
          errorDetails,
          isFailed ? now.toISOString() : null,
          now.toISOString(),
          model.id,
        ]);

        // Log execution attempt
        await this.logExecution({
          scheduledNotificationId: model.id!,
          executionAttempt: newRetryCount,
          executionTime: now,
          status: isFailed ? 'DEAD_LETTERED' : 'RETRY',
          errorMessage: errorMsg,
        });
      }
    });

    if (recoveredCount > 0) {
      logger.warn('Recovered stale locks', { requestId, count: recoveredCount });
    }

    return recoveredCount;
  }

  /**
   * Mark notification as completed
   */
  async markAsCompleted(
    id: number,
    requestId?: string,
    completedAt: Date = new Date(),
  ): Promise<void> {
    const now = completedAt.toISOString();
    let executionStatus = NotificationStatus.COMPLETED;
    let transitioned = false;
    await this.db.transaction(async () => {
      const row = await this.db.get<ScheduledNotificationRow>(
        'SELECT * FROM scheduled_notifications WHERE id = ?',
        [id],
      );
      if (!row) return;

      const notification = this.rowToModel(row);
      if (notification.recurrence) {
        const result = calculateNextRun(
          notification.recurrence,
          notification.executeAt,
          completedAt,
          (notification.occurrenceCount ?? 0) + 1,
        );
        const nextStatus = result.nextRun
          ? NotificationStatus.PENDING
          : NotificationStatus.COMPLETED;
        executionStatus = nextStatus;
        const update = await this.db.run(
          `UPDATE scheduled_notifications
           SET execute_at = ?, occurrence_count = ?, last_run_at = ?, status = ?,
               retry_count = 0, last_error = NULL, error_details = NULL,
               processing_started_at = NULL, processing_completed_at = ?, updated_at = ?,
               processor_id = NULL, lock_expires_at = NULL, next_retry_at = NULL
           WHERE id = ? AND status = ?`,
          [
            result.nextRun?.toISOString() ?? notification.executeAt.toISOString(),
            result.occurrenceCount,
            notification.executeAt.toISOString(),
            nextStatus,
            nextStatus === NotificationStatus.COMPLETED ? now : null,
            now,
            id,
            NotificationStatus.PROCESSING,
          ],
        );
        if (update.changes === 0) return;
        transitioned = true;
      } else {
        await this.db.run(
          `UPDATE scheduled_notifications
           SET status = ?, processing_completed_at = ?, updated_at = ?,
               processor_id = NULL, lock_expires_at = NULL
           WHERE id = ?`,
          [NotificationStatus.COMPLETED, now, now, id],
        );
        transitioned = true;
      }
    });

    // Invalidate stats cache after completion
    this.statsCache.invalidate();

    if (transitioned) {
      await this.scheduleAudit?.record({
        scheduledNotificationId: id,
        action: 'EXECUTED',
        actor: 'scheduler',
        fromStatus: NotificationStatus.PROCESSING,
        toStatus: executionStatus,
        details: { requestId: requestId ?? null },
      });
    }

    logger.info('Notification marked as completed', { requestId, id });
  }

  /** Mark a notification expired and release its processing lock. */
  async markAsExpired(id: number, reason = 'Notification expired before delivery'): Promise<void> {
    const now = new Date().toISOString();
    const errorMessage = reason;
    await this.db.run(
      `UPDATE scheduled_notifications
       SET status = ?, last_error = ?, error_details = ?, processing_completed_at = ?,
           updated_at = ?, processor_id = NULL, lock_expires_at = NULL, next_retry_at = NULL
       WHERE id = ? AND status = ?`,
      [
        NotificationStatus.EXPIRED,
        errorMessage,
        JSON.stringify({ message: errorMessage, timestamp: now }),
        now,
        now,
        id,
        NotificationStatus.PROCESSING,
      ],
    );
    this.statsCache.invalidate();
  }

  /**
   * Defer a notification to a future delivery time because it fell inside a
   * quiet-hours / restricted delivery window (#1227).
   *
   * The underlying event record is preserved: the row stays PENDING, its
   * payload, event_id, contract_address and metadata are untouched. Only
   * `execute_at` is pushed forward to the next window opening and
   * `next_retry_at` is cleared so the scheduler picks it up as soon as the
   * window opens. The deferral is recorded in `error_details` for observability
   * without overwriting the payload.
   *
   * Returns false when the row is not in a deferrable state (already claimed,
   * terminal, or missing).
   */
  async deferToDeliveryWindow(
    id: number,
    resumeAt: Date,
    reason: string = 'QUIET_HOURS',
    requestId?: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const details = JSON.stringify({
      code: 'DEFERRED_DELIVERY_WINDOW',
      reason,
      deferredAt: now,
      resumeAt: resumeAt.toISOString(),
    });

    const result = await this.db.run(
      `UPDATE scheduled_notifications
       SET execute_at = ?, next_retry_at = NULL, error_details = ?, updated_at = ?,
           processor_id = NULL, lock_expires_at = NULL
       WHERE id = ? AND status = ?`,
      [resumeAt.toISOString(), details, now, id, NotificationStatus.PENDING],
    );

    if (result.changes > 0) {
      this.statsCache.invalidate();
      logger.info('Notification deferred to delivery window', {
        requestId,
        id,
        resumeAt: resumeAt.toISOString(),
        reason,
      });
      return true;
    }

    return false;
  }

  /**
   * Batch variant of {@link deferToDeliveryWindow}. Each entry maps a
   * notification id to the time its delivery window next opens. Rows that are
   * no longer deferrable are skipped. Returns the number of rows deferred.
   */
  async deferManyToDeliveryWindow(
    deferrals: Array<{ id: number; resumeAt: Date; reason?: string }>,
    requestId?: string,
  ): Promise<number> {
    if (deferrals.length === 0) return 0;

    let deferred = 0;
    await this.db.transaction(async () => {
      for (const entry of deferrals) {
        const ok = await this.deferToDeliveryWindow(
          entry.id,
          entry.resumeAt,
          entry.reason ?? 'QUIET_HOURS',
          requestId,
        );
        if (ok) deferred += 1;
      }
    });

    if (deferred > 0) {
      logger.info('Batch deferred notifications to delivery windows', {
        requestId,
        deferred,
        total: deferrals.length,
      });
    }

    return deferred;
  }

  /**
   * Find PENDING notifications whose delivery window has reopened and are due
   * for delivery. Used by the scheduler to resume notifications that were
   * deferred during quiet hours without discarding the event record.
   *
   * Only rows previously deferred via {@link deferToDeliveryWindow} are
   * considered (identified by the DEFERRED_DELIVERY_WINDOW marker), so this
   * never interferes with normal scheduling.
   */
  async fetchDeferredDueForDelivery(
    now: Date = new Date(),
    limit: number = ScheduledNotificationRepository.MAX_SCHEDULER_BATCH_SIZE,
  ): Promise<ScheduledNotification[]> {
    const cappedLimit = Math.min(
      Math.max(1, Math.floor(limit) || 1),
      ScheduledNotificationRepository.MAX_SCHEDULER_BATCH_SIZE,
    );

    const rows = await this.db.all<ScheduledNotificationRow>(
      `SELECT * FROM scheduled_notifications
       WHERE status = ?
         AND recovery_state IS NULL
         AND execute_at <= ?
         AND error_details LIKE '%"code":"DEFERRED_DELIVERY_WINDOW"%'
       ORDER BY priority ASC, execute_at ASC, id ASC
       LIMIT ?`,
      [NotificationStatus.PENDING, now.toISOString(), cappedLimit],
    );

    return rows.map((row) => this.rowToModel(row));
  }

  /**
   * Hold an overdue notification until an operator resumes it.
   * `next_retry_at` is parked far in the future so the poll loop will not
   * claim the row again. Status stays PENDING so no schema migration is required.
   */
  async holdForIntervention(id: number): Promise<void> {
    const now = new Date().toISOString();
    const errorMessage = 'Missed schedule requires operator intervention';
    await this.db.run(
      `UPDATE scheduled_notifications
       SET status = ?, last_error = ?, error_details = ?, next_retry_at = ?,
           updated_at = ?, processor_id = NULL, lock_expires_at = NULL
       WHERE id = ? AND status = ?`,
      [
        NotificationStatus.PENDING,
        errorMessage,
        JSON.stringify({ code: 'MISSED_SCHEDULE_INTERVENTION', heldAt: now }),
        '9999-12-31T00:00:00.000Z',
        now,
        id,
        NotificationStatus.PROCESSING,
      ],
    );
    this.statsCache.invalidate();
  }

  /**
   * Let an operator release a notification held by the intervene policy.
   * The next poll delivers it. Returns false when the row is not held.
   */
  async releaseIntervention(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing || existing.status !== NotificationStatus.PENDING) return false;

    let details: { code?: string; releasedAt?: string; heldAt?: string };
    try {
      details = JSON.parse(existing.errorDetails ?? '');
    } catch {
      return false;
    }
    if (details.code !== 'MISSED_SCHEDULE_INTERVENTION' || details.releasedAt) return false;

    const now = new Date().toISOString();
    details.releasedAt = now;
    const result = await this.db.run(
      `UPDATE scheduled_notifications
       SET next_retry_at = NULL, error_details = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
      [JSON.stringify(details), now, id, NotificationStatus.PENDING],
    );
    this.statsCache.invalidate();
    return result.changes > 0;
  }

  /**
   * Mark notification as failed or retry (sets next_retry_at for backoff scheduling)
   */
  async markAsFailedOrRetry(
    id: number,
    error: Error,
    currentRetryCount: number,
    maxRetries: number,
    nextRetryAt?: Date,
  ): Promise<void> {
    const nextRetryCount = currentRetryCount + 1;
    const isFailed = nextRetryCount >= maxRetries;
    const newStatus = isFailed ? NotificationStatus.DEAD_LETTERED : NotificationStatus.PENDING;
    assertScheduleTransition(NotificationStatus.PROCESSING, newStatus);
    // When permanently failing, preserve currentRetryCount so the distribution
    // reflects actual retries performed (not an incremented-past-max value).
    const storedRetryCount = isFailed ? currentRetryCount : nextRetryCount;

    const sql = `
      UPDATE scheduled_notifications
      SET 
        status = ?,
        retry_count = ?,
        last_error = ?,
        error_details = ?,
        next_retry_at = ?,
        processing_completed_at = ?,
        updated_at = ?,
        processor_id = NULL,
        lock_expires_at = NULL
      WHERE id = ?
    `;

    const now = new Date().toISOString();
    const completedAt = isFailed ? new Date().toISOString() : null;
    const errorDetails = JSON.stringify({
      message: error.message,
      stack: error.stack,
      timestamp: now,
    });

    await this.db.run(sql, [
      newStatus,
      storedRetryCount,
      error.message,
      errorDetails,
      isFailed ? null : (nextRetryAt?.toISOString() ?? null),
      isFailed ? now : null,
      now,
      id,
    ]);

    if (isFailed) {
      await this.moveToDeadLetterQueue(id, error, errorDetails, nextRetryCount);
    }

    // Invalidate stats cache after status change
    this.statsCache.invalidate();

    logger.info('Notification marked for retry or failed', {
      id,
      newStatus,
      retryCount: nextRetryCount,
      maxRetries,
      nextRetryAt: nextRetryAt?.toISOString(),
    });
  }

  async moveToDeadLetterQueue(
    id: number,
    error: Error,
    errorDetails: string,
    retryCount: number,
    requestId?: string,
  ): Promise<boolean> {
    const notification = await this.getById(id);
    if (!notification) {
      return false;
    }

    const insertSql = `
      INSERT INTO dead_letter_queue (
        scheduled_notification_id, notification_type, target_recipient, payload, failure_reason, error_details, retry_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scheduled_notification_id) DO UPDATE SET
        failure_reason = excluded.failure_reason,
        error_details = excluded.error_details,
        retry_count = excluded.retry_count,
        last_retried_at = NULL
    `;

    await this.db.run(insertSql, [
      id,
      notification.notificationType,
      notification.targetRecipient,
      typeof notification.payload === 'string'
        ? notification.payload
        : JSON.stringify(notification.payload),
      error.message,
      errorDetails,
      retryCount,
    ]);

    logger.warn('Notification moved to dead letter queue', {
      requestId,
      id,
      notificationType: notification.notificationType,
      failureReason: error.message,
    });

    return true;
  }

  async getDeadLetterQueue(): Promise<DeadLetterQueueEntry[]> {
    const sql = `
      SELECT id, scheduled_notification_id, notification_type, target_recipient, payload, failure_reason, error_details, created_at, last_retried_at, retry_count
      FROM dead_letter_queue
      ORDER BY created_at DESC
    `;

    const rows = await this.db.all<{
      id: number;
      scheduled_notification_id: number;
      notification_type: string;
      target_recipient: string;
      payload: string;
      failure_reason: string;
      error_details: string | null;
      created_at: string;
      last_retried_at: string | null;
      retry_count: number;
    }>(sql);

    return rows.map((row) => ({
      id: row.id,
      originalNotificationId: row.scheduled_notification_id,
      notificationType: row.notification_type as any,
      targetRecipient: row.target_recipient,
      payload: row.payload,
      failureReason: row.failure_reason,
      errorDetails: row.error_details,
      createdAt: new Date(row.created_at),
      lastRetriedAt: row.last_retried_at ? new Date(row.last_retried_at) : null,
      retryCount: row.retry_count,
    }));
  }

  async retryDeadLetterNotification(id: number, requestId?: string): Promise<boolean> {
    const entry = await this.db.get<{ scheduled_notification_id: number }>(
      'SELECT scheduled_notification_id FROM dead_letter_queue WHERE id = ?',
      [id],
    );

    if (!entry) {
      return false;
    }

    await this.db.transaction(async () => {
      await this.db.run(
        `
          UPDATE scheduled_notifications
          SET status = ?, next_retry_at = NULL, updated_at = ?, retry_count = 0, last_error = NULL, error_details = NULL
          WHERE id = ?
        `,
        [NotificationStatus.PENDING, new Date().toISOString(), entry.scheduled_notification_id],
      );

      await this.db.run(
        `UPDATE dead_letter_queue SET last_retried_at = ?, retry_count = retry_count + 1 WHERE id = ?`,
        [new Date().toISOString(), id],
      );
    });

    logger.info('Dead-letter notification requeued', {
      requestId,
      id,
      notificationId: entry.scheduled_notification_id,
    });
    return true;
  }

  /**
   * Fetch PENDING notifications whose next_retry_at is due (or null, meaning immediately schedulable).
   * Used by RetryScheduler to pick up failed notifications for re-attempt.
   */
  async fetchDueRetries(
    processorId: string,
    lockTimeoutMs: number,
    batchSize: number = 10,
    requestId?: string,
  ): Promise<ScheduledNotification[]> {
    assertScheduleTransition(NotificationStatus.PENDING, NotificationStatus.PROCESSING);
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + lockTimeoutMs);

    const updateSql = `
      UPDATE scheduled_notifications
      SET
        status = ?,
        processor_id = ?,
        lock_expires_at = ?,
        processing_started_at = ?
      WHERE id IN (
        SELECT id FROM scheduled_notifications
        WHERE status = ?
          AND recovery_state IS NULL
          AND retry_count > 0
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY priority ASC, next_retry_at ASC
        LIMIT ?
      )
    `;

    const updateResult = await this.db.run(updateSql, [
      NotificationStatus.PROCESSING,
      processorId,
      lockExpiresAt.toISOString(),
      now.toISOString(),
      NotificationStatus.PENDING,
      now.toISOString(),
      batchSize,
    ]);

    if (updateResult.changes === 0) return [];

    const selectSql = `
      SELECT * FROM scheduled_notifications
      WHERE processor_id = ? AND status = ? AND lock_expires_at = ?
        AND retry_count > 0
    `;

    const rows = await this.db.all<ScheduledNotificationRow>(selectSql, [
      processorId,
      NotificationStatus.PROCESSING,
      lockExpiresAt.toISOString(),
    ]);

    logger.info('Fetched due retries', { requestId, count: rows.length, processorId });

    return rows.map(this.rowToModel.bind(this));
  }

  /**
   * Atomically modify a pending schedule with optimistic locking. The status,
   * recovery marker, and version predicates prevent races with competing writes
   * and scheduler claims.
   */
  async updatePending(
    id: number,
    expectedVersion: number,
    input: CreateScheduledNotificationInput,
  ): Promise<boolean> {
    const payloadJson = JSON.stringify(input.payload);
    const secret = process.env.PAYLOAD_INTEGRITY_SECRET;
    const payloadHash = secret ? hashPayload(payloadJson, secret) : null;
    const expiresAt =
      input.expiresAt === undefined || input.expiresAt === null
        ? null
        : this.normalizeExpiration(input.expiresAt);
    const now = new Date().toISOString();

    const result = await this.db.run(
      `UPDATE scheduled_notifications
       SET payload = ?, payload_hash = ?, notification_type = ?, target_recipient = ?,
           execute_at = ?, expires_at = ?, max_retries = ?, priority = ?, metadata = ?,
           updated_at = ?, version = version + 1
       WHERE id = ? AND status = ? AND recovery_state IS NULL AND version = ?`,
      [
        compressPayload(input.payload),
        payloadHash,
        input.notificationType,
        input.targetRecipient,
        input.executeAt.toISOString(),
        expiresAt,
        input.maxRetries ?? 3,
        input.priority ?? 5,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        id,
        NotificationStatus.PENDING,
        expectedVersion,
      ],
    );
    if (result.changes > 0) {
      this.statsCache.invalidate();
      logger.info('Pending notification modified', { id, expectedVersion, newVersion: expectedVersion + 1 });
      return true;
    }
    return false;
  }

  /**
   * Apply the missed-schedule policy. Conditional writes make EXPIRE and
   * REQUIRE_INTERVENTION idempotent when recovery runs more than once.
   */
  async recoverOverdueSchedules(policy: ScheduleRecoveryPolicy, now: Date = new Date()): Promise<number> {
    const timestamp = now.toISOString();
    if (policy === 'EXECUTE') {
      const result = await this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM scheduled_notifications
         WHERE status = ? AND recovery_state IS NULL AND execute_at <= ?`,
        [NotificationStatus.PENDING, timestamp],
      );
      const count = result?.count ?? 0;
      logger.info('Overdue schedules retained for catch-up execution', { policy, count, at: timestamp });
      return count;
    }

    if (policy === 'EXPIRE') {
      assertScheduleTransition(NotificationStatus.PENDING, NotificationStatus.EXPIRED);
      const result = await this.db.run(
        `UPDATE scheduled_notifications
         SET status = ?, updated_at = ?, version = version + 1
         WHERE status = ? AND recovery_state IS NULL AND execute_at <= ?`,
        [NotificationStatus.EXPIRED, timestamp, NotificationStatus.PENDING, timestamp],
      );
      if (result.changes > 0) this.statsCache.invalidate();
      logger.info('Overdue schedule recovery applied', { policy, count: result.changes, at: timestamp });
      return result.changes;
    }

    assertScheduleTransition(NotificationStatus.PENDING, NotificationStatus.AWAITING_INTERVENTION);
    const result = await this.db.run(
      `UPDATE scheduled_notifications
       SET recovery_state = 'AWAITING_INTERVENTION', updated_at = ?, version = version + 1
       WHERE status = ? AND recovery_state IS NULL AND execute_at <= ?`,
      [timestamp, NotificationStatus.PENDING, timestamp],
    );
    if (result.changes > 0) this.statsCache.invalidate();
    logger.info('Overdue schedule recovery applied', { policy, count: result.changes, at: timestamp });
    return result.changes;
  }

  /** Resolve a recovery hold, returning the schedule to normal processing or expiring it. */
  async resolveAwaitingIntervention(id: number, action: 'EXECUTE' | 'EXPIRE'): Promise<boolean> {
    const target =
      action === 'EXECUTE' ? NotificationStatus.PENDING : NotificationStatus.EXPIRED;
    assertScheduleTransition(NotificationStatus.AWAITING_INTERVENTION, target);
    const now = new Date().toISOString();
    const result = await this.db.run(
      action === 'EXECUTE'
        ? `UPDATE scheduled_notifications
           SET recovery_state = NULL, updated_at = ?, version = version + 1
           WHERE id = ? AND status = ? AND recovery_state = 'AWAITING_INTERVENTION'`
        : `UPDATE scheduled_notifications
           SET status = ?, recovery_state = NULL, updated_at = ?, version = version + 1
           WHERE id = ? AND status = ? AND recovery_state = 'AWAITING_INTERVENTION'`,
      action === 'EXECUTE'
        ? [now, id, NotificationStatus.PENDING]
        : [target, now, id, NotificationStatus.PENDING],
    );
    if (result.changes > 0) {
      this.statsCache.invalidate();
      logger.info('Intervention schedule resolved', { id, action });
    }
    return result.changes > 0;
  }

  /**
   * Get notification by ID
   */
  async getById(id: number): Promise<ScheduledNotification | null> {
    const sql = 'SELECT * FROM scheduled_notifications WHERE id = ?';
    const row = await this.db.get<ScheduledNotificationRow>(sql, [id]);
    return row ? this.rowToModel(row) : null;
  }

  /**
   * Update mutable fields on a PENDING scheduled notification.
   */
  async updatePending(
    id: number,
    updates: { executeAt?: Date