import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';
import { generateRequestId } from '../utils/request-id';
import { ScheduledNotificationRepository } from './scheduled-notification-repository';
import { SchedulerConfig, ScheduledNotification } from '../types/scheduled-notification';
import { DiscordNotificationService } from './discord-notification';
import { BatchValidationService } from './batch-validation-service';
import { NotificationChannel } from '../utils/batch-validator';
import { getWorkerManager } from './worker-manager';
import { getJobMonitor } from './job-monitor';
import { ProviderRegistry, getProviderRegistry } from './provider-registry';
import { verifyPayloadIntegrity } from '../utils/payload-integrity';
import { DeliveryReceiptRepository } from './delivery-receipt-repository';
import { DeliveryResult } from '../types/provider-capabilities';
import { NotificationClaimLease, startClaimLease } from './notification-claim-lease';

/**
 * Background scheduler that processes scheduled notifications
 * Features:
 * - Distributed lock to prevent race conditions
 * - Automatic recovery of stale locks
 * - Retry logic with exponential backoff
 * - Catch-up for missed schedules after downtime
 */
export class NotificationScheduler {
  private repository: ScheduledNotificationRepository;
  private discordService: DiscordNotificationService | null;
  private config: SchedulerConfig;
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private processorId: string;
  private batchValidator: BatchValidationService;
  /**
   * Provider registry used for all notification dispatch.
   * When not supplied the module-level singleton is used.
   */
  private providerRegistry: ProviderRegistry;
  private deliveryReceiptRepository?: DeliveryReceiptRepository;

  constructor(
    repository: ScheduledNotificationRepository,
    config: SchedulerConfig,
    discordService?: DiscordNotificationService | null,
    batchValidator?: BatchValidationService,
    providerRegistry?: ProviderRegistry,
    deliveryReceiptRepository?: DeliveryReceiptRepository
  ) {
    this.repository = repository;
    this.config = { retryDelayMs: 5_000, ...config };
    this.discordService = discordService ?? null;
    this.processorId = config.processorId || uuidv4();
    this.batchValidator = batchValidator ?? new BatchValidationService();
    this.providerRegistry = providerRegistry ?? getProviderRegistry();
    this.deliveryReceiptRepository = deliveryReceiptRepository;
  }

  /**
   * Start the scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Scheduler already running');
      return;
    }

    if (!this.config.enabled) {
      logger.info('Scheduler is disabled in configuration');
      return;
    }

    this.isRunning = true;
    logger.info('Starting notification scheduler', {
      processorId: this.processorId,
      pollIntervalMs: this.config.pollIntervalMs,
      batchSize: this.config.batchSize,
    });

    // Recover stale locks on startup
    await this.repository.recoverStaleLocks();

    // Start processing loop
    this.scheduleNextPoll();
  }

  /**
   * Stop the scheduler gracefully
   * Waits for all in-flight jobs to complete before returning
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping notification scheduler', { processorId: this.processorId });
    this.isRunning = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Wait for all active jobs to complete
    const workerManager = getWorkerManager();
    await workerManager.initiateGracefulShutdown();
  }

  /**
   * Schedule next poll cycle
   */
  private scheduleNextPoll(): void {
    if (!this.isRunning) return;

    this.timer = setTimeout(async () => {
      await this.processPendingNotifications();
      this.scheduleNextPoll();
    }, this.config.pollIntervalMs);
  }

  /**
   * Main processing loop
   */
  private async processPendingNotifications(): Promise<void> {
    const requestId = generateRequestId();
    const batchStart = Date.now();

    try {
      // Recover any stale locks from crashed processors
      await this.repository.recoverStaleLocks(requestId);

      // Fetch and lock pending notifications
      const notifications = await this.repository.fetchAndLockPendingNotifications(
        this.processorId,
        this.config.lockTimeoutMs,
        this.config.batchSize,
        requestId
      );

      if (notifications.length === 0) {
        logger.debug('Scheduler poll cycle complete', {
          requestId,
          processorId: this.processorId,
          count: 0,
          durationMs: Date.now() - batchStart,
        });
        return;
      }

      const activeNotifications: ScheduledNotification[] = [];
      for (const notification of notifications) {
        if (await this.expireIfPastDeadline(notification, requestId)) continue;
        activeNotifications.push(notification);
      }
      if (activeNotifications.length === 0) return;

      const batchRejection = this.batchValidator.rejectIfInvalid(
        this.toValidationBatch(activeNotifications)
      );

      if (batchRejection) {
        logger.error('Scheduled notification batch rejected by validation', {
          requestId,
          processorId: this.processorId,
          errors: batchRejection.errors,
        });

        for (const notification of activeNotifications) {
          await this.repository.markAsFailedOrRetry(
            notification.id!,
            new Error(`Batch validation failed: ${batchRejection.errors.map((e) => e.message).join('; ')}`),
            notification.retryCount,
            notification.maxRetries
          );
        }
        return;
      }

      logger.info('Processing batch of scheduled notifications', {
        requestId,
        count: activeNotifications.length,
        processorId: this.processorId,
      });

      // Check if shutdown is in progress - don't accept new jobs
      const workerManager = getWorkerManager();
      if (workerManager.isShutdownInProgress()) {
        logger.info('Shutdown in progress - releasing unprocessed notifications', {
          requestId,
          count: activeNotifications.length,
        });
        // Release locks on unprocessed notifications
        for (const notification of activeNotifications) {
          await this.repository.markAsFailedOrRetry(
            notification.id!,
            new Error('Scheduler shutting down'),
            notification.retryCount,
            notification.maxRetries
          );
        }
        return;
      }

      // Process each notification with job tracking + monitoring.
      // WORKER_CONCURRENCY (config.concurrency, default 1) bounds how many
      // notifications are processed in parallel per poll cycle; 1 preserves
      // the original serial behavior exactly.
      const jobMonitor = getJobMonitor();
      const concurrency = Math.max(1, Math.floor(this.config.concurrency ?? 1));
      const queue = [...activeNotifications];
      const processOne = async (notification: ScheduledNotification): Promise<void> => {
        const jobId = `notification-${notification.id}`;
        if (!workerManager.startJob(jobId)) {
          // Shutdown is in progress, don't process new jobs
          logger.info('Job rejected - scheduler shutting down', { jobId });
          await this.repository.markAsFailedOrRetry(
            notification.id!,
            new Error('Scheduler shutting down'),
            notification.retryCount,
            notification.maxRetries
          );
          return;
        }

        jobMonitor.startJob(jobId, 'scheduled-notification', {
          notificationId: notification.id,
          type: notification.notificationType,
          requestId,
        });

        const lease = this.startClaimLease(notification, requestId);

        try {
          await this.processNotification(notification, requestId, jobId);
        } finally {
          await lease?.stop();
          workerManager.completeJob(jobId);
        }
      };
      const workers = Array.from(
        { length: Math.min(concurrency, queue.length) },
        async () => {
          // Array.shift() is atomic in the single-threaded event loop, so each
          // notification is claimed by exactly one worker.
          let next: ScheduledNotification | undefined;
          while ((next = queue.shift()) !== undefined) {
            await processOne(next);
          }
        }
      );
      await Promise.all(workers);

      logger.info('Scheduler batch complete', {
        requestId,
        processorId: this.processorId,
        count: activeNotifications.length,
        durationMs: Date.now() - batchStart,
      });
    } catch (error) {
      logger.error('Error in scheduler processing loop', {
        requestId,
        error,
        processorId: this.processorId,
        durationMs: Date.now() - batchStart,
      });
    }
  }

  /**
   * Keep the claim on `notification` alive for as long as this worker is
   * actually delivering it.
   *
   * The lease is renewed at a third of the lock window, so a delivery that
   * outlives `lockTimeoutMs` is no longer handed back to the queue by the
   * `recoverStaleLocks()` call that opens every poll cycle. Renewal is
   * owner-checked, so a worker that did lose its claim stops renewing rather
   * than taking the job back from its new owner.
   */
  private startClaimLease(
    notification: ScheduledNotification,
    requestId: string
  ): NotificationClaimLease | null {
    return startClaimLease({
      repository: this.repository,
      notificationId: notification.id!,
      processorId: this.processorId,
      lockTimeoutMs: this.config.lockTimeoutMs,
      onLeaseLost: (id) => {
        logger.warn('Notification claim lease was lost before delivery finished', {
          requestId,
          id,
          processorId: this.processorId,
        });
      },
      onRenewalError: (id, error) => {
        logger.warn('Failed to renew notification claim lease', { requestId, id, error });
      },
    });
  }

  /**
   * Process a single notification
   */
  private async processNotification(
    notification: ScheduledNotification,
    requestId: string,
    jobId?: string
  ): Promise<void> {
    const startTime = Date.now();
    const executionAttempt = notification.retryCount + 1;
    const jobMonitor = getJobMonitor();
    let receiptRecorded = false;

    try {
      if (await this.expireIfPastDeadline(notification, requestId, jobId)) return;

      logger.info('Processing scheduled notification', {
        requestId,
        id: notification.id,
        type: notification.notificationType,
        executeAt: notification.executeAt,
        attempt: executionAttempt,
      });

      // Check if notification is within timing buffer
      const now = new Date();
      const timeDiff = now.getTime() - notification.executeAt.getTime();

      if (timeDiff < -this.config.timingBufferMs) {
        // Notification is not yet due (clock skew or early fetch)
        logger.warn('Notification not yet due, releasing lock', {
          requestId,
          id: notification.id,
          executeAt: notification.executeAt,
          now,
        });
        await this.repository.markAsFailedOrRetry(
          notification.id!,
          new Error('Not yet due for execution'),
          notification.retryCount,
          notification.maxRetries
        );
        if (jobId) {
          jobMonitor.failJob(jobId, 'Not yet due for execution', {
            notificationId: notification.id,
          });
        }
        return;
      }

      if (timeDiff > this.config.timingBufferMs) {
        logger.warn('Missed scheduled notification detected; dispatching catch-up delivery', {
          requestId,
          id: notification.id,
          executeAt: notification.executeAt,
          now,
          missedByMs: timeDiff,
        });
      }

      // Verify payload integrity before executing
      const secret = process.env.PAYLOAD_INTEGRITY_SECRET;
      if (secret) {
        if (!notification.payloadHash) {
          logger.warn('Payload integrity check skipped — no hash stored', {
            requestId,
            id: notification.id,
          });
        } else if (!verifyPayloadIntegrity(notification.payload, notification.payloadHash, secret)) {
          logger.error('Payload integrity verification failed — rejecting notification', {
            requestId,
            id: notification.id,
            type: notification.notificationType,
          });
          await this.repository.markAsFailedOrRetry(
            notification.id!,
            new Error('Payload integrity check failed: hash mismatch'),
            notification.maxRetries, // exhaust retries — don't retry a tampered payload
            notification.maxRetries
          );
          if (jobId) {
            jobMonitor.failJob(jobId, 'Payload integrity check failed: hash mismatch', {
              notificationId: notification.id,
            });
          }
          return;
        }
      }

      // Execute notification based on type
      const deliveryResult = await this.executeNotification(notification, requestId);
      await this.recordDeliveryReceipt(notification, executionAttempt, deliveryResult);
      receiptRecorded = true;
      const success = deliveryResult.success;

      const durationMs = Date.now() - startTime;

      if (success) {
        await this.repository.markAsCompleted(notification.id!, requestId);
        await this.repository.logExecution({
          scheduledNotificationId: notification.id!,
          executionAttempt,
          executionTime: new Date(),
          status: 'SUCCESS',
          durationMs,
        });

        if (jobId) {
          jobMonitor.completeJob(jobId, {
            notificationId: notification.id,
            durationMs,
          });
        }

        logger.info('Notification delivered successfully', {
          requestId,
          id: notification.id,
          type: notification.notificationType,
          durationMs,
        });
      } else {
        throw new Error(deliveryResult.errorMessage ?? 'Notification delivery returned false');
      }
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error('Failed to process notification', {
        requestId,
        id: notification.id,
        error,
        attempt: executionAttempt,
        durationMs,
      });

      if (!receiptRecorded) {
        const providerCode = (error as NodeJS.ErrnoException)?.code;
        const isTimeout = (error as Error)?.name === 'AbortError';
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

      if (jobId) {
        jobMonitor.failJob(jobId, (error as Error).message, {
          notificationId: notification.id,
          attempt: executionAttempt,
        });
      }

      const willRetry = notification.retryCount + 1 < notification.maxRetries;
      const nextRetryAt = willRetry
        ? new Date(Date.now() + (this.config.retryDelayMs ?? 5_000))
        : undefined;

      await this.repository.markAsFailedOrRetry(
        notification.id!,
        error as Error,
        notification.retryCount,
        notification.maxRetries,
        nextRetryAt
      );

      await this.repository.logExecution({
        scheduledNotificationId: notification.id!,
        executionAttempt,
        executionTime: new Date(),
        status: willRetry ? 'RETRY' : 'FAILED',
        errorMessage: (error as Error).message,
        durationMs,
      });
    }
  }

  private async expireIfPastDeadline(
    notification: ScheduledNotification,
    requestId: string,
    jobId?: string,
  ): Promise<boolean> {
    if (!notification.expiresAt || notification.expiresAt.getTime() > Date.now()) return false;

    const errorMessage = 'Notification expired before delivery';
    await this.repository.markAsExpired(notification.id!);
    await this.repository.logExecution({
      scheduledNotificationId: notification.id!,
      executionAttempt: notification.retryCount + 1,
      executionTime: new Date(),
      status: 'FAILED',
      errorMessage,
      durationMs: 0,
    });
    if (jobId) {
      getJobMonitor().failJob(jobId, errorMessage, { notificationId: notification.id });
    }
    logger.info('Expired notification skipped before delivery', {
      requestId,
      id: notification.id,
    });
    return true;
  }

  /**
   * Execute notification delivery based on type.
   *
   * The registry is queried first. When a registered provider exists for the
   * notification type it is used for all delivery — including Discord and
   * webhook notifications. This keeps the scheduler decoupled from any
   * concrete provider implementation.
   *
   * Legacy path: when no provider is registered for the type, the scheduler
   * falls back to the directly-injected `discordService` so that existing
   * deployments that have not yet bootstrapped the registry continue to work.
   */
  private async executeNotification(
    notification: ScheduledNotification,
    requestId: string
  ): Promise<DeliveryResult> {
    const payload = JSON.parse(notification.payload);
    const type = notification.notificationType;

    // ------------------------------------------------------------------
    // Registry-based dispatch (preferred path)
    // ------------------------------------------------------------------
    if (this.providerRegistry.has(type)) {
      const result = await this.providerRegistry.deliver(type, {
        payload,
        targetRecipient: notification.targetRecipient,
        notificationType: type,
        requestId,
      });

      if (result.degradedCapabilities.length > 0) {
        logger.info('Notification delivered with degraded capabilities', {
          requestId,
          id: notification.id,
          type,
          degradedCapabilities: result.degradedCapabilities,
        });
      }

      return result;
    }

    // ------------------------------------------------------------------
    // Legacy fallback: direct Discord service injection
    // ------------------------------------------------------------------
    switch (type) {
      case 'discord':
        if (!this.discordService) {
          throw new Error(
            'Discord service not configured and no Discord provider registered in the registry'
          );
        }
        return {
          success: await this.discordService.sendEventNotification(
          payload.event,
          payload.contractConfig,
          `scheduler-${notification.id}-${requestId}`
          ),
          degradedCapabilities: [],
        };

      case 'webhook':
        throw new Error(
          'Webhook delivery not yet implemented. Register a WebhookNotificationProvider in the ProviderRegistry.'
        );

      case 'email':
        throw new Error(
          'Email delivery not yet implemented. Register an email NotificationProvider in the ProviderRegistry.'
        );

      case 'sms':
        throw new Error(
          'SMS delivery not yet implemented. Register an SMS NotificationProvider in the ProviderRegistry.'
        );

      default:
        throw new Error(
          `Unsupported notification type: "${type}". Register a provider for this type in the ProviderRegistry.`
        );
    }
  }

  /**
   * Get scheduler statistics
   */
  async getStats() {
    return await this.repository.getStats();
  }

  private toValidationBatch(notifications: ScheduledNotification[]) {
    return notifications.map((notification) => ({
      id: String(notification.id),
      recipient: notification.targetRecipient,
      channel: notification.notificationType as NotificationChannel,
      message: this.extractValidationMessage(notification.payload),
    }));
  }

  private extractValidationMessage(payloadJson: string): string {
    try {
      const payload = JSON.parse(payloadJson);
      if (typeof payload.message === 'string' && payload.message.trim()) {
        return payload.message;
      }
      if (typeof payload.content === 'string' && payload.content.trim()) {
        return payload.content;
      }
      return JSON.stringify(payload).slice(0, 200);
    } catch {
      return payloadJson.slice(0, 200) || 'scheduled-notification';
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