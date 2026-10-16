import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';
import { generateRequestId } from '../utils/request-id';
import { ScheduledNotificationRepository } from './scheduled-notification-repository';
import { ScheduledNotification, NotificationStatus } from '../types/scheduled-notification';
import { DiscordNotificationService } from './discord-notification';
import { WebhookDeliveryService, DEFAULT_WEBHOOK_TIMEOUT_MS } from './webhook-delivery-service';
import { getWorkerManager } from './worker-manager';
import { DeliveryReceiptRepository } from './delivery-receipt-repository';
import { DeliveryResult } from '../types/provider-capabilities';
import {
  computeBackoffDelay,
  DeliveryError,
  RetryFailureType,
  RetryPolicy,
  classifyError,
  classifyHttpStatus,
} from './retry-policy';
import { startClaimLease } from './notification-claim-lease';

export interface RetrySchedulerConfig {
  /** Whether the scheduler is enabled. */
  enabled: boolean;
  /** How often to poll for due retries (ms). */
  pollIntervalMs: number;
  /** How long to hold a distributed lock before it is considered stale (ms). */
  lockTimeoutMs: number;
  /** Unique identifier for this scheduler instance (used in distributed locking). */
  processorId?: string;
  /** Maximum notifications to process per poll cycle. */
  batchSize: number;
  /** Backoff base delay (ms). Delay = base * multiplier^attempt */
  baseDelayMs: number;
  /** Backoff multiplier. Default: 2. */
  multiplier: number;
  /** Maximum delay cap (ms). Default: 1 hour. */
  maxDelayMs: number;
  /** Add ±25 % random jitter to prevent thundering herd. Default: true. */
  jitter: boolean;
/**
   * Timeout (ms) applied to outbound webhook requests (`WEBHOOK_TIMEOUT_MS`).
   * Default: DEFAULT_WEBHOOK_TIMEOUT_MS.
   */
  webhookTimeoutMs: number;
  /**
   * Hard ceiling on total delivery attempts, including the first one.
   * `undefined` (default) leaves each notification's own `maxRetries` in
   * control. `1` disables retries entirely.
   */
  maxAttempts?: number;
  /**
   * Failure types eligible for retry. Defaults to the transient set in
   * `RETRY_POLICY_DEFAULTS`; permanent failures (auth, not-found, client and
   * configuration errors) fail on the first attempt.
   */
  retryableFailureTypes?: readonly RetryFailureType[];
}

/**
 * Defaults for the DB-backed scheduler. Scheduling-specific fields are
 * retained here; backoff defaults are inherited from the shared
 * `RETRY_BACKOFF_DEFAULTS` and can still be overridden per-instance via
 * `RetrySchedulerConfig.backoff`.
 */
export const RETRY_SCHEDULER_DEFAULTS: Readonly<Omit<RetrySchedulerConfig, 'backoff'> & {
  backoff: Readonly<RetryBackoffConfig>;
}> = {
  enabled: true,
  pollIntervalMs: 15_000,
  lockTimeoutMs: 60_000,
  batchSize: 10,
  baseDelayMs: 5_000,
  multiplier: 2,
  maxDelayMs: 60 * 60 * 1_000,
  jitter: true,
webhookTimeoutMs: DEFAULT_WEBHOOK_TIMEOUT_MS,
};

/**
 * Calculates exponential backoff delay with optional jitter.
 *
 * Retained as a standalone export for callers that only need the curve; the
 * {@link RetryPolicy} used by the scheduler itself delegates to the same
 * implementation, so both can never drift apart.
 *
 * Formula: delay = min(base * multiplier^attempt, maxDelayMs)
 * Jitter:  delay *= (0.75 + Math.random() * 0.5)  → ±25 %
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  multiplier: number,
  maxDelayMs: number,
  jitter: boolean
): number {
  return computeBackoffDelay(attempt, baseDelayMs, multiplier, maxDelayMs, jitter);
}

/**
 * DB-backed retry scheduler.
 *
 * On each poll cycle it:
 *  1. Atomically claims PENDING notifications with retry_count > 0 that are due
 *     (next_retry_at ≤ now) using the repository's pessimistic lock.
 *  2. Re-executes the notification delivery.
 *  3. On success → marks COMPLETED.
 *  4. On failure  → if retries remain, computes next backoff delay, writes
 *     next_retry_at, and resets status to PENDING.  Otherwise marks FAILED.
 *
 * The distributed lock (processor_id + lock_expires_at) prevents two concurrent
 * scheduler instances from retrying the same notification.
 */
export class RetryScheduler {
  private readonly config: RetrySchedulerConfig;
  private readonly policy: RetryPolicy;
  private readonly processorId: string;
  private repository: ScheduledNotificationRepository;
  private discordService: DiscordNotificationService | null;
  private webhookDeliveryService: WebhookDeliveryService;
  private deliveryReceiptRepository?: DeliveryReceiptRepository;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    repository: ScheduledNotificationRepository,
    config: Partial<RetrySchedulerConfig> = {},
    discordService?: DiscordNotificationService | null,
    webhookDeliveryService?: WebhookDeliveryService,
    deliveryReceiptRepository?: DeliveryReceiptRepository,
  ) {
    this.config = { ...RETRY_SCHEDULER_DEFAULTS, ...config };
    this.policy = new RetryPolicy({
      maxAttempts: this.config.maxAttempts,
      baseDelayMs: this.config.baseDelayMs,
      multiplier: this.config.multiplier,
      maxDelayMs: this.config.maxDelayMs,
      jitter: this.config.jitter,
      retryableFailureTypes: this.config.retryableFailureTypes,
    });
    this.processorId = this.config.processorId ?? `retry-${uuidv4()}`;
    this.repository = repository;
    this.discordService = discordService ?? null;
this.webhookDeliveryService =
      webhookDeliveryService ??
      new WebhookDeliveryService({ timeoutMs: this.config.webhookTimeoutMs });
    this.deliveryReceiptRepository = deliveryReceiptRepository;
  }

  /** Exposed for health checks and tests: the policy driving every retry decision. */
  getRetryPolicy(): RetryPolicy {
    return this.policy;
  }

  async start(): Promise<void> {
    if (this.running) {
      logger.warn('RetryScheduler already running', { processorId: this.processorId });
      return;
    }
    if (!this.config.enabled) {
      logger.info('RetryScheduler is disabled');
      return;
    }

    this.running = true;
    logger.info('RetryScheduler started', {
      processorId: this.processorId,
      pollIntervalMs: this.config.pollIntervalMs,
      baseDelayMs: this.config.baseDelayMs,
      multiplier: this.config.multiplier,
      maxDelayMs: this.config.maxDelayMs,
      jitter: this.config.jitter,
      maxAttempts: this.config.maxAttempts,
      retryableFailureTypes: this.policy.getConfig().retryableFailureTypes,
    });

    await this.repository.recoverStaleLocks();
    this.scheduleNextPoll();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Wait for all active jobs to complete
    const workerManager = getWorkerManager();
    await workerManager.initiateGracefulShutdown();

    logger.info('RetryScheduler stopped', { processorId: this.processorId });
  }

  /** Exposed for testing. */
  async runOnce(): Promise<void> {
    await this.processDueRetries();
  }

  private scheduleNextPoll(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.processDueRetries();
      this.scheduleNextPoll();
    }, this.config.pollIntervalMs);
  }

  private async processDueRetries(): Promise<void> {
    const requestId = generateRequestId();

    try {
      await this.repository.recoverStaleLocks(requestId);

      const notifications = await this.repository.fetchDueRetries(
        this.processorId,
        this.config.lockTimeoutMs,
        this.config.batchSize,
        requestId
      );

      if (notifications.length === 0) return;

      // Check if shutdown is in progress - don't accept new jobs
      const workerManager = getWorkerManager();
      if (workerManager.isShutdownInProgress()) {
        logger.info('Shutdown in progress - releasing unprocessed retries', {
          requestId,
          count: notifications.length,
        });
        // Release locks on unprocessed retries
        for (const notification of notifications) {
          await this.repository.markAsFailedOrRetry(
            notification.id!,
            new Error('Retry scheduler shutting down'),
            notification.retryCount,
            notification.maxRetries
          );
        }
        return;
      }

      logger.info('RetryScheduler processing batch', {
        requestId,
        processorId: this.processorId,
        count: notifications.length,
      });

      for (const notification of notifications) {
        const jobId = `retry-${notification.id}`;
        if (!workerManager.startJob(jobId)) {
          // Shutdown is in progress, don't process new jobs
          logger.info('Job rejected - retry scheduler shutting down', { jobId });
          await this.repository.markAsFailedOrRetry(
            notification.id!,
            new Error('Retry scheduler shutting down'),
            notification.retryCount,
            notification.maxRetries
          );
          continue;
        }

        const lease = startClaimLease({
          repository: this.repository,
          notificationId: notification.id!,
          processorId: this.processorId,
          lockTimeoutMs: this.config.lockTimeoutMs,
          onLeaseLost: (id) => {
            logger.warn('Retry claim lease was lost before delivery finished', {
              requestId,
              id,
              processorId: this.processorId,
            });
          },
          onRenewalError: (id, error) => {
            logger.warn('Failed to renew retry claim lease', { requestId, id, error });
          },
        });

        try {
          await this.processRetry(notification, requestId);
        } finally {
          await lease?.stop();
          workerManager.completeJob(jobId);
        }
      }
    } catch (err) {
      logger.error('RetryScheduler poll error', { requestId, error: err });
    }
  }

  private async processRetry(
    notification: ScheduledNotification,
    requestId: string
  ): Promise<void> {
    const priorFailures = notification.retryCount;
    const executionAttempt = priorFailures + 1;
    const startMs = Date.now();
    let receiptRecorded = false;

    if (notification.expiresAt && notification.expiresAt.getTime() <= startMs) {
      const errorMessage = 'Notification expired before delivery';
      await this.repository.markAsExpired(notification.id!);
      await this.repository.logExecution({
        scheduledNotificationId: notification.id!,
        executionAttempt,
        executionTime: new Date(startMs),
        status: 'FAILED',
        errorMessage,
        durationMs: 0,
      });
      logger.info('Expired retry skipped before delivery', {
        requestId,
        id: notification.id,
      });
      return;
    }

    logger.info('Retrying notification', {
      requestId,
      id: notification.id,
      type: notification.notificationType,
      attempt: executionAttempt,
      maxRetries: notification.maxRetries,
    });

    try {
      const deliveryResult = await this.deliver(notification, requestId);
      await this.recordDeliveryReceipt(notification, executionAttempt, deliveryResult);
      receiptRecorded = true;
      const durationMs = Date.now() - startMs;

      if (deliveryResult.success) {
        await this.repository.markAsCompleted(notification.id!, requestId);
        await this.repository.logExecution({
          scheduledNotificationId: notification.id!,
          executionAttempt,
          executionTime: new Date(),
          status: 'SUCCESS',
          durationMs,
        });
        logger.info('Retry succeeded', { requestId, id: notification.id, attempt: executionAttempt });
        return;
      }

      throw new Error(deliveryResult.errorMessage ?? 'Delivery returned false');
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const error = err as Error;
      if (!receiptRecorded) {
        const providerCode = (err as NodeJS.ErrnoException)?.code;
        const isTimeout = error?.name === 'AbortError';
        await this.recordDeliveryReceipt(notification, executionAttempt, {
          success: false,
          degradedCapabilities: [],
          errorCode: isTimeout ? 'TIMEOUT' : typeof providerCode === 'string' ? providerCode : 'DELIVERY_FAILED',
          errorMessage: isTimeout ? 'Provider request timed out' : 'Provider delivery failed',
        }).catch((receiptError) => {
          logger.error('Failed to persist delivery receipt', {
            requestId,
            notificationId: notification.id,
            error: receiptError,
          });
        });
      }
      const failureType = classifyError(err);

      const decision = this.policy.evaluate(
        failureType,
        executionAttempt,
        notification.maxRetries,
      );
      const isFinalAttempt = !decision.shouldRetry;

      const nextRetryAt =
        decision.shouldRetry && decision.delayMs !== undefined
          ? new Date(Date.now() + decision.delayMs)
          : undefined;

      // `markAsFailedOrRetry` decides between PENDING and FAILED purely by
      // comparing `retryCount + 1` against the budget it is handed. A permanent
      // failure must retire the row now, so hand it the attempt that just failed
      // as its budget; otherwise a row with budget left would stay PENDING with
      // a NULL `next_retry_at` and `fetchDueRetries` would pick it straight back
      // up, burning the remaining budget on a failure that can never succeed.
      const effectiveMaxAttempts =
        decision.reason === 'permanent' ? executionAttempt : decision.maxAttempts;

      await this.repository.markAsFailedOrRetry(
        notification.id!,
        error,
        priorFailures,
        effectiveMaxAttempts,
        nextRetryAt,
      );

      await this.repository.logExecution({
        scheduledNotificationId: notification.id!,
        executionAttempt,
        executionTime: new Date(),
        status: isFinalAttempt ? 'FAILED' : 'RETRY',
        errorMessage: error.message,
        durationMs,
      });

      if (decision.reason === 'permanent') {
        logger.error('Notification failed permanently, not retried', {
          requestId,
          id: notification.id,
          totalAttempts: executionAttempt,
          failureType,
          maxAttempts: decision.maxAttempts,
        });
      } else if (decision.reason === 'exhausted') {
        logger.error('Notification permanently failed after max retries', {
          requestId,
          id: notification.id,
          totalAttempts: executionAttempt,
          failureType,
        });
      } else {
        logger.warn('Retry failed, scheduling next attempt', {
          requestId,
          id: notification.id,
          attempt: executionAttempt,
          failureType,
          nextRetryAt: nextRetryAt?.toISOString(),
        });
      }
    }
  }

  private async deliver(
    notification: ScheduledNotification,
    requestId: string
  ): Promise<DeliveryResult> {
    const payload = JSON.parse(notification.payload);

    switch (notification.notificationType) {
      case 'discord':
        if (!this.discordService) throw new Error('Discord service not configured');
        return {
          success: await this.discordService.sendEventNotification(
            payload.event,
            payload.contractConfig,
            `retry-${notification.id}-${requestId}`
          ),
          degradedCapabilities: [],
        };

      case 'webhook': {
        const targetUrl: string = notification.targetRecipient;
        if (!targetUrl) {
          throw new DeliveryError(
            'Webhook notification missing targetRecipient URL',
            RetryFailureType.ConfigurationError,
          );
        }
        const result = await this.webhookDeliveryService.deliver(
          targetUrl,
          payload,
          `retry-${notification.id}-${requestId}`,
        );
        if (!result.success) {
          const failureType = classifyHttpStatus(result.statusCode);
          throw new DeliveryError(
            result.errorReason ?? `Webhook delivery failed (HTTP ${result.statusCode ?? 'unknown'})`,
            failureType,
            { statusCode: result.statusCode },
          );
        }
        return {
          success: result.success,
          degradedCapabilities: [],
          statusCode: result.statusCode,
          providerMessageId: result.providerMessageId,
          providerResponse: result.providerResponse,
          errorCode: result.errorCode,
          errorMessage: result.errorReason,
        };
      }

      default:
        throw new DeliveryError(
          `Unsupported notification type: ${notification.notificationType}`,
          RetryFailureType.ConfigurationError,
        );
    }
  }

  private async recordDeliveryReceipt(
    notification: ScheduledNotification,
    attemptCount: number,
    result: DeliveryResult,
  ): Promise<void> {
    if (!this.deliveryReceiptRepository || notification.id == null) return;
    await this.deliveryReceiptRepository.create({
      notificationId: notification.id,
      channel: notification.notificationType,
      status: result.success ? 'delivered' : result.statusCode && result.statusCode >= 400 && result.statusCode < 500
        ? 'rejected'
        : 'failed',
      attemptCount,
      providerMessageId: result.providerMessageId ?? null,
      providerResponse: result.providerResponse ?? null,
      errorCode: result.errorCode ?? null,
      errorMessage: result.success ? null : result.errorMessage ?? 'Provider delivery failed',
    });
  }
}
