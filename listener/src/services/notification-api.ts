import { ScheduledNotificationRepository } from './scheduled-notification-repository';
import { QueueOperationalMetrics, NotificationStats } from './notification-stats-cache';
import { IdempotencyKeyService } from './idempotency-key-service';
import {
  CreateScheduledNotificationInput,
  NotificationType,
} from '../types/scheduled-notification';
import {
  validatePayloadSize,
  DEFAULT_MAX_PAYLOAD_SIZE_BYTES,
} from '../utils/payload-size-validator';
import { validateNotificationMetadata } from '../utils/metadata-validator';
import { ensureNotificationVersion } from '../utils/notification-version';
import logger from '../utils/logger';
import {
  InputValidator,
  isNonEmptyString,
  isNonNegativeInteger,
  isOneOf,
  isPlainObject,
  isInRange,
  isInteger,
} from '../utils/validation';

const PRIORITY_MIN = 1;
const PRIORITY_MAX = 10;
import { buildRetryStatisticsPayload } from './retry-statistics';

function parseExpiresAt(value: Date | string | number): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * High-level API for scheduling notifications
 * This is the main interface that application code should use
 * Includes support for idempotent request handling
 */
export class NotificationAPI {
  /** Maximum allowed serialised payload size in bytes. */
  readonly maxPayloadSizeBytes: number = DEFAULT_MAX_PAYLOAD_SIZE_BYTES;

  constructor(
    private repository: ScheduledNotificationRepository,
    maxPayloadSizeBytesOrIdempotency?: number | IdempotencyKeyService,
    private idempotencyService?: IdempotencyKeyService,
  ) {
    if (typeof maxPayloadSizeBytesOrIdempotency === 'number') {
      this.maxPayloadSizeBytes = maxPayloadSizeBytesOrIdempotency;
    } else {
      this.maxPayloadSizeBytes = DEFAULT_MAX_PAYLOAD_SIZE_BYTES;
      // Support legacy two-argument form: new NotificationAPI(repo, idempotencyService)
      if (maxPayloadSizeBytesOrIdempotency != null) {
        this.idempotencyService = maxPayloadSizeBytesOrIdempotency;
      }
    }
  }

  /**
   * Schedule a notification for future delivery
   * Supports idempotent request handling via idempotency keys
   */
  async scheduleNotification(
    input: CreateScheduledNotificationInput,
    requestId?: string,
    idempotencyKey?: string,
  ): Promise<number> {
    // Validate input
    if (
      !input.executeAt ||
      !(input.executeAt instanceof Date) ||
      isNaN(input.executeAt.getTime())
    ) {
      throw new Error('executeAt must be a valid date');
    }

    if (input.executeAt <= new Date()) {
      throw new Error(
        'executeAt must be a future timestamp — the provided date has already expired',
      );
    }

    if (!isPlainObject(input.payload)) {
      throw new Error('payload must be a valid object');
    }

    if (!isNonEmptyString(input.targetRecipient)) {
      throw new Error('targetRecipient is required and must be a non-empty string');
    }

    const v = new InputValidator();
    v.check(
      isOneOf(input.notificationType, Object.values(NotificationType)),
      'notificationType',
      `must be one of: ${Object.values(NotificationType).join(', ')}`,
    );
    if (input.maxRetries !== undefined) {
      v.check(
        isNonNegativeInteger(input.maxRetries),
        'maxRetries',
        'must be a non-negative integer',
      );
    }
    if (input.priority !== undefined) {
      v.check(
        isInteger(input.priority) && isInRange(input.priority, PRIORITY_MIN, PRIORITY_MAX),
        'priority',
        `must be an integer between ${PRIORITY_MIN} and ${PRIORITY_MAX}`,
      );
    }
    if (input.eventId !== undefined) {
      v.check(isNonEmptyString(input.eventId), 'eventId', 'must be a non-empty string');
    }
    if (input.contractAddress !== undefined) {
      v.check(
        isNonEmptyString(input.contractAddress),
        'contractAddress',
        'must be a non-empty string',
      );
    }
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      const expiresAt = parseExpiresAt(input.expiresAt);
      v.check(expiresAt !== null, 'expiresAt', 'must be a valid ISO-8601 timestamp or epoch');
      if (expiresAt) input = { ...input, expiresAt };
    }
    if (input.metadata !== undefined) {
      v.check(isPlainObject(input.metadata), 'metadata', 'must be an object');
    }
    v.throwIfInvalid();
    // Stamp / verify protocol version on the payload.
    input = {
      ...input,
      payload: ensureNotificationVersion(input.payload as Record<string, unknown>),
    };

    // Validate metadata before any storage write.
    validateNotificationMetadata(input.metadata ?? null);

    // Validate payload size BEFORE any storage or heavy processing operations.
    validatePayloadSize(input.payload, this.maxPayloadSizeBytes);

    logger.info('Scheduling new notification', {
      requestId,
      idempotencyKey,
      type: input.notificationType,
      executeAt: input.executeAt,
      recipient: input.targetRecipient,
      version: (input.payload as Record<string, unknown>).version,
    });

    // If idempotency service is available, use it for deduplication
    if (this.idempotencyService && idempotencyKey) {
      const { result, isDuplicate, notificationId } =
        await this.idempotencyService.processWithIdempotency(idempotencyKey, input, async () => {
          return await this.repository.create(input, requestId);
        });

      if (isDuplicate) {
        logger.info('Returned duplicate notification response', {
          requestId,
          idempotencyKey,
          notificationId,
        });
      }

      return typeof result === 'number' ? result : (result as { id: number }).id;
    }

    return await this.repository.create(input, requestId);
  }

  /**
   * Schedule a Discord notification.
   */
  async scheduleDiscordNotification(
    webhookUrl: string,
    message: any,
    executeAt: Date,
    options?: {
      maxRetries?: number;
      priority?: number;
      metadata?: Record<string, any>;
    },
  ): Promise<number> {
    return await this.scheduleNotification({
      payload: { message, webhookUrl },
      notificationType: NotificationType.DISCORD,
      targetRecipient: webhookUrl,
      executeAt,
      maxRetries: options?.maxRetries,
      priority: options?.priority,
      metadata: options?.metadata,
    });
  }

  /**
   * Schedule a generic HTTP webhook notification.
   *
   * The `payload` is POSTed as JSON to `targetUrl` at `executeAt`.
   * Failed deliveries (5xx, timeouts, network errors) are automatically
   * re-queued by the RetryScheduler with exponential backoff.
   *
   * @param targetUrl  - Full URL that will receive the POST request.
   * @param payload    - JSON-serialisable body to deliver.
   * @param executeAt  - When to make the first delivery attempt.
   * @param options    - Optional overrides for retries, priority, and metadata.
   */
  async scheduleWebhookNotification(
    targetUrl: string,
    payload: Record<string, any>,
    executeAt: Date,
    options?: {
      maxRetries?: number;
      priority?: number;
      metadata?: Record<string, any>;
    },
  ): Promise<number> {
    return await this.scheduleNotification({
      payload,
      notificationType: NotificationType.WEBHOOK,
      targetRecipient: targetUrl,
      executeAt,
      maxRetries: options?.maxRetries,
      priority: options?.priority,
      metadata: options?.metadata,
    });
  }

  /**
   * Cancel a scheduled notification.
   * @param id - The ID of the notification
   * @param reason - An optional reason for cancellation
   * @param requestId - Optional request ID for logging
   */
  async cancelNotification(id: number, reason?: string, requestId?: string): Promise<boolean> {
    logger.info('Cancelling scheduled notification', { requestId, id, reason });
    return await this.repository.cancel(id, reason);
  }

  /**
   * Get notification by ID.
   */
  async getNotification(id: number) {
    return await this.repository.getById(id);
  }

  /**
   * Get scheduler statistics.
   */
  async getStatistics(): Promise<NotificationStats> {
    return await this.repository.getStats();
  }

  /**
   * Get operational metrics for notification queue activity (#797).
   */
  async getQueueOperationalMetrics(): Promise<QueueOperationalMetrics> {
    return await this.repository.getQueueOperationalMetrics();
  }

  /**
   * List pending jobs for queue visibility.
   * Returns jobs currently waiting in the queue with their id, type,
   * enqueue time (createdAt), scheduled delivery time (executeAt),
   * priority, and retry count.
   */
  async getPendingJobs(limit?: number) {
    return await this.repository.getPendingJobs(limit);
  }

  /**
   * Get execution metrics with deduplication
   * Use this for dashboard metrics to prevent double-counting retried notifications
   */
  async getExecutionMetrics() {
    return await this.repository.getExecutionMetrics();
  }

  /**
   * Get retry distribution breakdown
   */
  async getRetryDistribution() {
    return await this.repository.getRetryDistribution();
  }

  /**
   * Get all notifications currently in the dead-letter queue.
   */
  async getDeadLetterQueue() {
    return await this.repository.getDeadLetterQueue();
  }

  /**
   * Requeue a dead-lettered notification so it can be retried again.
   */
  async retryDeadLetterNotification(id: number, requestId?: string): Promise<boolean> {
    return await this.repository.retryDeadLetterNotification(id, requestId);
  }

  /**
   * Aggregated retry statistics for delivery monitoring dashboards.
   */
  async getRetryStatistics() {
    const [metrics, distribution] = await Promise.all([
      this.getExecutionMetrics(),
      this.getRetryDistribution(),
    ]);

    return buildRetryStatisticsPayload({
      totalNotifications: metrics.totalNotifications,
      successfulFirstAttempt: metrics.successfulFirstAttempt,
      successfulAfterRetry: metrics.successfulAfterRetry,
      permanentFailures: metrics.permanentFailures,
      totalRetryAttempts: metrics.totalRetryAttempts,
      averageRetriesPerNotification: metrics.averageRetriesPerNotification,
      distribution,
    });
  }
}
