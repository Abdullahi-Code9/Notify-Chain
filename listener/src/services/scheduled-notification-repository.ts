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
} from '../types/scheduled-notification';
import { hashPayload } from '../utils/payload-integrity';
import {
  NotificationStatsCache,
  getStatsCache,
  NotificationStats,
  QueueOperationalMetrics,
} from './notification-stats-cache';

/**
 * Repository for scheduled notifications database operations
 * Handles all CRUD operations and queries
 */
export class ScheduledNotificationRepository {
  private statsCache: NotificationStatsCache;

  constructor(
    private db: Database,
    statsCache?: NotificationStatsCache,
    private defaultTtlSeconds: number = 0,
  ) {
    this.statsCache = statsCache ?? getStatsCache();
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
        event_id, contract_address, priority, metadata, next_retry_at, deduplication_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      if (
        input.deduplicationKey &&
        (err as any)?.message?.includes('UNIQUE constraint failed')
      ) {
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
   * Dequeue pending notifications due for execution with distributed locking.
   * Uses a single atomic UPDATE ... WHERE id IN (SELECT ...) so two workers
   * polling at the same time can never claim the same row.
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
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + lockTimeoutMs);

    // First, atomically lock available notifications
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
          AND execute_at <= ?
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY priority ASC, execute_at ASC
        LIMIT ?
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
      batchSize,
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
    requestId?: string
  ): Promise<boolean> {
    const lockExpiresAt = new Date(Date.now() + lockTimeoutMs).toISOString();

    const result = await this.db.run(
      `
        UPDATE scheduled_notifications
        SET lock_expires_at = ?
        WHERE id = ? AND processor_id = ? AND status = ?
      `,
      [lockExpiresAt, id, processorId, NotificationStatus.PROCESSING]
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
  async markAsCompleted(id: number, requestId?: string): Promise<void> {
    const sql = `
      UPDATE scheduled_notifications
      SET 
        status = ?,
        processing_completed_at = ?,
        updated_at = ?,
        processor_id = NULL,
        lock_expires_at = NULL
      WHERE id = ?
    `;

    const now = new Date().toISOString();
    await this.db.run(sql, [NotificationStatus.COMPLETED, now, now, id]);

    // Invalidate stats cache after completion
    this.statsCache.invalidate();

    logger.info('Notification marked as completed', { requestId, id });
  }

  /** Mark a notification expired and release its processing lock. */
  async markAsExpired(id: number): Promise<void> {
    const now = new Date().toISOString();
    const errorMessage = 'Notification expired before delivery';
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
   * Get notification by ID
   */
  async getById(id: number): Promise<ScheduledNotification | null> {
    const sql = 'SELECT * FROM scheduled_notifications WHERE id = ?';
    const row = await this.db.get<ScheduledNotificationRow>(sql, [id]);
    return row ? this.rowToModel(row) : null;
  }

  /**
   * Cancel a scheduled notification
   */
  async cancel(id: number, reason?: string): Promise<boolean> {
    // Store cancellation reason inside error_details as JSON.
    const errorDetails = reason ? JSON.stringify({ cancellationReason: reason }) : null;

    const sql = `
      UPDATE scheduled_notifications
      SET status = ?, updated_at = ?, error_details = ?
      WHERE id = ? AND status = ?
    `;

    const result = await this.db.run(sql, [
      NotificationStatus.CANCELLED,
      new Date().toISOString(),
      errorDetails,
      id,
      NotificationStatus.PENDING,
    ]);

    if (result.changes > 0) {
      logger.info('Notification cancelled', { id, reason });
      return true;
    }

    return false;
  }

  /**
   * Log notification execution attempt
   */
  async logExecution(log: NotificationExecutionLog): Promise<void> {
    const sql = `
      INSERT INTO notification_execution_log (
        scheduled_notification_id, execution_attempt, status,
        error_message, response_data, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `;

    await this.db.run(sql, [
      log.scheduledNotificationId,
      log.executionAttempt,
      log.status,
      log.errorMessage ?? null,
      log.responseData ?? null,
      log.durationMs ?? null,
    ]);
  }

  /**
   * Delete terminal notifications older than the retention window.
   */
  async deleteExpiredNotifications(retentionDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Math.max(1, retentionDays));

    const sql = `
      DELETE FROM scheduled_notifications
      WHERE status IN (?, ?, ?, ?, ?)
        AND updated_at < ?
    `;

    const result = await this.db.run(sql, [
      NotificationStatus.COMPLETED,
      NotificationStatus.FAILED,
      NotificationStatus.DEAD_LETTERED,
      NotificationStatus.CANCELLED,
      NotificationStatus.EXPIRED,
      cutoff.toISOString(),
    ]);

    if (result.changes > 0) {
      logger.info('Deleted expired scheduled notifications', {
        deleted: result.changes,
        retentionDays,
      });
    }

    return result.changes;
  }

  /**
   * Delete execution log rows older than the retention window.
   */
  async deleteExpiredExecutionLogs(retentionDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Math.max(1, retentionDays));

    const result = await this.db.run(
      'DELETE FROM notification_execution_log WHERE execution_time < ?',
      [cutoff.toISOString()],
    );

    if (result.changes > 0) {
      logger.info('Deleted expired notification execution logs', {
        deleted: result.changes,
        retentionDays,
      });
    }

    return result.changes;
  }

  /**
   * List pending jobs for queue visibility.
   * Returns notifications in PENDING status ordered by priority then enqueue
   * time (execute_at), with each entry carrying the minimum fields needed for
   * queue inspection: id, notificationType, createdAt (enqueue time),
   * executeAt (scheduled delivery time), priority, and retryCount.
   */
  async getPendingJobs(limit: number = 100): Promise<
    Array<{
      id: number;
      notificationType: string;
      createdAt: string;
      executeAt: string;
      priority: number;
      retryCount: number;
    }>
  > {
    const sql = `
      SELECT id, notification_type, created_at, execute_at, priority, retry_count
      FROM scheduled_notifications
      WHERE status = ?
      ORDER BY priority ASC, execute_at ASC
      LIMIT ?
    `;

    const rows = await this.db.all<{
      id: number;
      notification_type: string;
      created_at: string;
      execute_at: string;
      priority: number;
      retry_count: number;
    }>(sql, [NotificationStatus.PENDING, limit]);

    return rows.map((row) => ({
      id: row.id,
      notificationType: row.notification_type,
      createdAt: row.created_at,
      executeAt: row.execute_at,
      priority: row.priority,
      retryCount: row.retry_count,
    }));
  }

  /**
   * Get statistics about scheduled notifications
   */
  async getStats(): Promise<NotificationStats> {
    // Use cache with getOrLoad pattern
    return await this.statsCache.getOrLoad(async () => {
      const now = new Date().toISOString();

      const countBySql = `
        SELECT 
          CASE 
            WHEN status = 'PROCESSING' AND lock_expires_at IS NOT NULL AND lock_expires_at < ? THEN 'PENDING'
            ELSE status
          END AS adjusted_status,
          COUNT(*) as count
        FROM scheduled_notifications
        GROUP BY adjusted_status
      `;

      const overdueSql = `
        SELECT COUNT(*) as count
        FROM scheduled_notifications
        WHERE (status = 'PENDING' OR (status = 'PROCESSING' AND lock_expires_at IS NOT NULL AND lock_expires_at < ?))
          AND execute_at < ?
      `;

      const counts = await this.db.all<{ adjusted_status: string; count: number }>(countBySql, [
        now,
      ]);
      const overdueResult = await this.db.get<{ count: number }>(overdueSql, [now, now]);
      const dlqResult = await this.db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM dead_letter_queue',
      );

      let retryAttempts = 0;
      try {
        const retryResult = await this.db.get<{ log_retries: number; sn_retries: number }>(`
          SELECT
            COALESCE((SELECT COUNT(*) FROM notification_execution_log WHERE status = 'RETRY'), 0) as log_retries,
            COALESCE((SELECT SUM(retry_count) FROM scheduled_notifications), 0) as sn_retries
        `);
        retryAttempts = Math.max(retryResult?.log_retries ?? 0, retryResult?.sn_retries ?? 0);
      } catch {
        try {
          const snRetry = await this.db.get<{ sn_retries: number }>(
            'SELECT COALESCE(SUM(retry_count), 0) as sn_retries FROM scheduled_notifications',
          );
          retryAttempts = snRetry?.sn_retries ?? 0;
        } catch {
          retryAttempts = 0;
        }
      }

      const stats: NotificationStats = {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        overdue: overdueResult?.count ?? 0,
        deadLetterQueue: dlqResult?.count ?? 0,
        pendingNotifications: 0,
        processingNotifications: 0,
        successfulDeliveries: 0,
        failedDeliveries: 0,
        retryAttempts,
      };

      counts.forEach((row) => {
        const status = row.adjusted_status.toLowerCase();
        if (status in stats) {
          (stats as any)[status] = row.count;
        }
      });

      stats.pendingNotifications = stats.pending;
      stats.processingNotifications = stats.processing;
      stats.successfulDeliveries = stats.completed;
      stats.failedDeliveries = stats.failed;

      return stats;
    });
  }

  /**
   * Get operational metrics for notification queue activity (#797).
   */
  async getQueueOperationalMetrics(): Promise<QueueOperationalMetrics> {
    const stats = await this.getStats();
    return {
      pendingNotifications: stats.pendingNotifications ?? 0,
      processingNotifications: stats.processingNotifications ?? 0,
      successfulDeliveries: stats.successfulDeliveries ?? 0,
      failedDeliveries: stats.failedDeliveries ?? 0,
      retryAttempts: stats.retryAttempts ?? 0,
    };
  }

  /**
   * Get cached notification stats synchronously if present.
   */
  getStatsCached(): NotificationStats | undefined {
    return this.statsCache.get();
  }

  /**
   * Get execution metrics with proper deduplication
   * Returns ONE result per notification, representing the FINAL outcome
   * This prevents double-counting of retried notifications
   */
  async getExecutionMetrics(): Promise<{
    totalNotifications: number;
    successfulFirstAttempt: number;
    successfulAfterRetry: number;
    permanentFailures: number;
    totalRetryAttempts: number;
    averageRetriesPerNotification: number;
    averageSuccessDurationMs: number;
    averageFailureDurationMs: number;
  }> {
    // Get final outcome for each notification (one row per notification)
    const finalOutcomeSql = `
      WITH final_outcomes AS (
        SELECT 
          sn.id,
          sn.status,
          sn.retry_count,
          log.status as final_execution_status,
          log.duration_ms
        FROM scheduled_notifications sn
        LEFT JOIN notification_execution_log log 
          ON log.scheduled_notification_id = sn.id 
          AND log.execution_attempt = (
            SELECT MAX(execution_attempt) 
            FROM notification_execution_log 
            WHERE scheduled_notification_id = sn.id
          )
        WHERE sn.status IN (?, ?)
      )
      SELECT
        COUNT(*) as total_notifications,
        SUM(CASE WHEN final_execution_status = 'SUCCESS' AND retry_count = 0 THEN 1 ELSE 0 END) as success_first_attempt,
        SUM(CASE WHEN final_execution_status = 'SUCCESS' AND retry_count > 0 THEN 1 ELSE 0 END) as success_after_retry,
        SUM(CASE WHEN status = 'FAILED' OR final_execution_status = 'FAILED' THEN 1 ELSE 0 END) as permanent_failures,
        SUM(retry_count) as total_retry_attempts,
        AVG(CASE WHEN final_execution_status = 'SUCCESS' THEN duration_ms ELSE NULL END) as avg_success_duration,
        AVG(CASE WHEN status = 'FAILED' OR final_execution_status = 'FAILED' THEN duration_ms ELSE NULL END) as avg_failure_duration
      FROM final_outcomes
    `;

    const result = await this.db.get<{
      total_notifications: number;
      success_first_attempt: number;
      success_after_retry: number;
      permanent_failures: number;
      total_retry_attempts: number;
      avg_success_duration: number | null;
      avg_failure_duration: number | null;
    }>(finalOutcomeSql, [NotificationStatus.COMPLETED, NotificationStatus.FAILED]);

    const totalNotifications = result?.total_notifications ?? 0;
    const totalRetryAttempts = result?.total_retry_attempts ?? 0;

    return {
      totalNotifications,
      successfulFirstAttempt: result?.success_first_attempt ?? 0,
      successfulAfterRetry: result?.success_after_retry ?? 0,
      permanentFailures: result?.permanent_failures ?? 0,
      totalRetryAttempts,
      averageRetriesPerNotification:
        totalNotifications > 0 ? totalRetryAttempts / totalNotifications : 0,
      averageSuccessDurationMs: result?.avg_success_duration ?? 0,
      averageFailureDurationMs: result?.avg_failure_duration ?? 0,
    };
  }

  /**
   * Get detailed execution breakdown by retry count
   * Shows distribution of notifications by number of retries needed
   */
  async getRetryDistribution(): Promise<
    Array<{
      retryCount: number;
      successCount: number;
      failureCount: number;
    }>
  > {
    const sql = `
      SELECT 
        retry_count,
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as failure_count
      FROM scheduled_notifications
      WHERE status IN (?, ?)
      GROUP BY retry_count
      ORDER BY retry_count ASC
    `;

    const rows = await this.db.all<{
      retry_count: number;
      success_count: number;
      failure_count: number;
    }>(sql, [
      NotificationStatus.COMPLETED,
      NotificationStatus.FAILED,
      NotificationStatus.COMPLETED,
      NotificationStatus.FAILED,
    ]);

    return rows.map((row) => ({
      retryCount: row.retry_count,
      successCount: row.success_count,
      failureCount: row.failure_count,
    }));
  }

  /**
   * Convert database row to model
   */
  private rowToModel(row: ScheduledNotificationRow): ScheduledNotification {
    // SQLite CURRENT_TIMESTAMP produces "YYYY-MM-DD HH:MM:SS" (UTC, no Z suffix).
    // Appending Z ensures JS parses the value as UTC rather than local time,
    // which prevents timezone-shifted timestamps in rowToModel output.
    const parseUtc = (value: string | null | undefined): Date | undefined => {
      if (!value) return undefined;
      const normalized =
        value.includes('T') || value.endsWith('Z') ? value : value.replace(' ', 'T') + 'Z';
      return new Date(normalized);
    };

    return {
      id: row.id,
      payload: decompressPayload(row.payload),
      payloadHash: row.payload_hash,
      notificationType: row.notification_type as any,
      targetRecipient: row.target_recipient,
      executeAt: parseUtc(row.execute_at) as Date,
      expiresAt: parseUtc(row.expires_at) ?? null,
      createdAt: parseUtc(row.created_at),
      updatedAt: parseUtc(row.updated_at),
      status: row.status as NotificationStatus,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      processingStartedAt: parseUtc(row.processing_started_at) ?? null,
      processingCompletedAt: parseUtc(row.processing_completed_at) ?? null,
      processorId: row.processor_id,
      lockExpiresAt: parseUtc(row.lock_expires_at) ?? null,
      lastError: row.last_error,
      errorDetails: row.error_details,
      // Parse cancellation reason from stored JSON, if present.
      cancellationReason: (() => {
        if (!row.error_details) return null;
        try {
          const parsed = JSON.parse(row.error_details);
          return typeof parsed.cancellationReason === 'string'
            ? parsed.cancellationReason
            : null;
        } catch {
          return null;
        }
      })(),
      eventId: row.event_id,
      contractAddress: row.contract_address,
      priority: row.priority,
      metadata: row.metadata,
      nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at) : null,
      deduplicationKey: row.deduplication_key ?? null,
    };
  }
}
