import * as StellarSDK from '@stellar/stellar-sdk';
import { ContractConfig } from '../types';
import logger from '../utils/logger';
import { generateCorrelationId } from '../utils/request-id';
import { getEventName } from '../utils/event-utils';
import { getNotificationAnalyticsAggregator, NotificationAnalyticsAggregator } from './notification-analytics-aggregator';
import { NotificationType } from '../types/scheduled-notification';
import { RetryFailureType, RetryPolicy, RetryPolicyConfig, classifyError } from './retry-policy';

export enum Priority {
  Low = 0,
  Medium = 1,
  High = 2,
}

export interface RetryQueueOptions {
  /**
   * Provider-independent retry backoff parameters.
   * All fields are optional; defaults from `RETRY_BACKOFF_DEFAULTS` are used
   * for any omitted field, and the merged result is strictly validated.
   */
  backoff?: PartialRetryBackoffConfig;
  processIntervalMs?: number;
  priorityWeights?: { high: number; medium: number; low: number };
  /**
   * Retry policy overrides for attempt budgeting and failure eligibility.
   * Anything omitted falls back to `RETRY_POLICY_DEFAULTS`.
   *
   * Note: this queue keeps its own backoff curve (`calculateDelay`), so only
   * the `maxAttempts` and `retryableFailureTypes` knobs are taken from the
   * policy here — the delay knobs are ignored by design.
   */
  retryPolicy?: Pick<Partial<RetryPolicyConfig>, 'maxAttempts' | 'retryableFailureTypes'>;
}

interface RetryItem {
  event: StellarSDK.rpc.Api.EventResponse;
  contractConfig: ContractConfig;
  retryCount: number;
  nextRetryAt: number;
  requestId?: string;
  priority: Priority;
  enqueuedAt: number;
}

const DEFAULTS = {
  processIntervalMs: 5_000,
  priorityWeights: { high: 5, medium: 2, low: 1 },
};

export type NotificationFn = (
  event: StellarSDK.rpc.Api.EventResponse,
  contractConfig: ContractConfig,
  requestId?: string
) => Promise<boolean>;

export class NotificationRetryQueue {
  private queue: RetryItem[] = [];
  private readonly queuedFingerprints: Set<string> = new Set();
  /** Provider-independent, fully-validated backoff configuration. */
  private readonly backoff: Readonly<RetryBackoffConfig>;
  private readonly processIntervalMs: number;
  private readonly priorityWeights: { high: number; medium: number; low: number };
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly notificationFn: NotificationFn;
  private readonly analytics: NotificationAnalyticsAggregator | null;
  private priorityCounters: { high: number; medium: number; low: number } = { high: 0, medium: 0, low: 0 };

  // Metrics
  private metrics = {
    totalEnqueued: 0,
    totalProcessed: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    totalSkippedPermanent: 0,
    processingTimes: [] as number[],
  };

  private readonly policy: RetryPolicy;

  constructor(notificationFn: NotificationFn, options?: RetryQueueOptions) {
    this.notificationFn = notificationFn;
    this.backoff = resolveRetryBackoffConfig(options.backoff);
    this.processIntervalMs = options.processIntervalMs ?? DEFAULTS.processIntervalMs;
    this.priorityWeights = options.priorityWeights ?? DEFAULTS.priorityWeights;
    this.analytics = getNotificationAnalyticsAggregator();
    this.policy = new RetryPolicy(options?.retryPolicy);
  }

  /** The policy governing every retry decision made by this queue. */
  getRetryPolicy(): RetryPolicy {
    return this.policy;
  }

  enqueue(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    requestId?: string,
    priority: Priority = Priority.Medium
  ): void {
    const correlationId = requestId ?? generateCorrelationId();
    const fingerprint = buildRetryFingerprint(event, contractConfig.address);

    if (this.queuedFingerprints.has(fingerprint)) {
      logger.info('Skipping duplicate retry queue entry', {
        requestId: correlationId,
        correlationId,
        eventId: event.id,
        contractAddress: contractConfig.address,
        fingerprint,
      });
      return;
    }

    const delayMs = calculateBackoffDelay(0, this.backoff);
    const nextRetryAt = Date.now() + delayMs;

    logger.info('Notification queued for retry', {
      requestId: correlationId,
      correlationId,
      eventId: event.id,
      contractAddress: contractConfig.address,
      delayMs,
      nextRetryAt: new Date(nextRetryAt).toISOString(),
      maxRetries: this.backoff.maxRetries,
      priority: Priority[priority],
    });

    this.queuedFingerprints.add(fingerprint);
    this.queue.push({ event, contractConfig, retryCount: 0, nextRetryAt, requestId, priority, enqueuedAt: Date.now() });
    this.metrics.totalEnqueued++;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.processQueue().catch((err) =>
        logger.error('Unexpected error in retry queue processor', { error: err })
      );
    }, this.processIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  size(): number {
    return this.queue.length;
  }

  private async processQueue(): Promise<void> {
    const now = Date.now();
    const due = this.queue
      .filter((item) => item.nextRetryAt <= now)
      .sort((a, b) => {
        const priorityA = this.getWeightedPriority(a);
        const priorityB = this.getWeightedPriority(b);
        if (priorityB !== priorityA) return priorityB - priorityA;
        return a.enqueuedAt - b.enqueuedAt;
      });

    this.queue = this.queue.filter((item) => item.nextRetryAt > now);

    for (const item of due) {
      if (item.priority === Priority.High) this.priorityCounters.high++;
      else if (item.priority === Priority.Medium) this.priorityCounters.medium++;
      else this.priorityCounters.low++;
    }

    for (const item of due) {
      await this.retryItem(item);
    }
  }

  private getWeightedPriority(item: RetryItem): number {
    const basePriority = item.priority;
    const age = Date.now() - item.enqueuedAt;
    const ageBonus = Math.floor(age / 60000);

    let weight = 0;
    if (item.priority === Priority.High) weight = this.priorityWeights.high;
    else if (item.priority === Priority.Medium) weight = this.priorityWeights.medium;
    else weight = this.priorityWeights.low;

    return basePriority + ageBonus + weight;
  }

  private async retryItem(item: RetryItem): Promise<void> {
    const attempt = item.retryCount + 1;
    const fingerprint = buildRetryFingerprint(item.event, item.contractConfig.address);
    const retryStart = Date.now();

    logger.info('Retrying failed notification', {
      requestId: item.requestId,
      correlationId: item.requestId,
      eventId: item.event.id,
      contractAddress: item.contractConfig.address,
      attempt,
      maxRetries: this.backoff.maxRetries,
    });

    this.analytics?.record({
      notificationType: NotificationType.DISCORD,
      contractAddress: item.contractConfig.address,
      outcome: 'retry',
      durationMs: 0,
      timestamp: retryStart,
    });

    const outcome = await this.tryNotify(item, attempt);
    const duration = Date.now() - retryStart;

    if (outcome.success) {
      this.queuedFingerprints.delete(fingerprint);
      this.metrics.totalProcessed++;
      this.metrics.totalSucceeded++;
      this.metrics.processingTimes.push(duration);
      this.analytics?.record({
        notificationType: NotificationType.DISCORD,
        contractAddress: item.contractConfig.address,
        outcome: 'success',
        durationMs: Date.now() - retryStart,
        timestamp: Date.now(),
      });
      logger.info('Retry succeeded', {
        requestId: item.requestId,
        correlationId: item.requestId,
        eventId: item.event.id,
        contractAddress: item.contractConfig.address,
        attempt,
      });
      return;
    }

    const failureType = classifyError(outcome.error);
    const decision = this.policy.evaluate(failureType, attempt, this.maxRetries);

    if (!decision.shouldRetry) {
      this.queuedFingerprints.delete(fingerprint);
      this.metrics.totalProcessed++;
      this.metrics.totalFailed++;
      if (decision.reason === 'permanent') {
        this.metrics.totalSkippedPermanent++;
      }
      this.metrics.processingTimes.push(duration);
      this.analytics?.record({
        notificationType: NotificationType.DISCORD,
        contractAddress: item.contractConfig.address,
        outcome: 'failure',
        durationMs: duration,
        errorReason:
          decision.reason === 'permanent'
            ? `permanent failure (${failureType})`
            : `exhausted ${decision.maxAttempts} retries`,
        timestamp: Date.now(),
      });

      if (decision.reason === 'permanent') {
        logger.error('Notification failed permanently, not retried', {
          requestId: item.requestId,
          correlationId: item.requestId,
          eventId: item.event.id,
          contractAddress: item.contractConfig.address,
          totalAttempts: attempt,
          failureType,
        });
        return;
      }

      logger.error('Notification permanently failed after max retries', {
        requestId: item.requestId,
        correlationId: item.requestId,
        eventId: item.event.id,
        contractAddress: item.contractConfig.address,
        totalAttempts: attempt,
        failureType,
      });
      return;
    }

    const delayMs = calculateBackoffDelay(attempt, this.backoff);
    const nextRetryAt = Date.now() + delayMs;

    logger.warn('Retry failed, scheduling next attempt', {
      requestId: item.requestId,
      correlationId: item.requestId,
      eventId: item.event.id,
      contractAddress: item.contractConfig.address,
      attempt,
      delayMs,
      failureType,
      nextRetryAt: new Date(nextRetryAt).toISOString(),
    });

    this.queue.push({ ...item, retryCount: attempt, nextRetryAt });
  }

  /**
   * Invoke the notification function, capturing any thrown error so the retry
   * policy can classify it. A thrown permanent failure is reported separately
   * from a plain `false` return so the caller can log why no further attempt
   * will be made.
   */
  private async tryNotify(
    item: RetryItem,
    attempt: number,
  ): Promise<{ success: boolean; error?: unknown }> {
    try {
      return { success: await this.notificationFn(item.event, item.contractConfig, item.requestId) };
    } catch (error) {
      const failureType = classifyError(error);
      const logCtx = {
        requestId: item.requestId,
        correlationId: item.requestId,
        eventId: item.event.id,
        contractAddress: item.contractConfig.address,
        attempt,
        failureType,
      };

      logger.error(
        this.policy.isPermanent(failureType)
          ? 'Notification delivery raised a permanent failure, not retried'
          : 'Notification delivery threw, scheduling retry',
        { ...logCtx, error },
      );

      return { success: false, error };
    }
  }

  getMetrics() {
    const times = this.metrics.processingTimes;
    const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const min = times.length > 0 ? Math.min(...times) : 0;
    const max = times.length > 0 ? Math.max(...times) : 0;

    return {
      queueSize: this.queue.length,
      ...this.metrics,
      processingTime: {
        min,
        max,
        avg,
      },
    };
  }
}

function buildRetryFingerprint(
  event: StellarSDK.rpc.Api.EventResponse,
  contractAddress: string
): string {
  const eventName =
    getEventName(event.topic) ?? event.topic.map((entry: { toString(): string }) => entry.toString()).join('|');
  return `${contractAddress}:${event.id}:${eventName}:${event.txHash ?? ''}`;
}
