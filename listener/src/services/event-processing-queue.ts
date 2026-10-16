import * as StellarSDK from '@stellar/stellar-sdk';
import { ContractConfig } from '../types';
import logger from '../utils/logger';
import { generateCorrelationId } from '../utils/request-id';
import {
  RetryFailureType,
  RetryPolicy,
  RetryPolicyConfig,
  classifyError,
} from './retry-policy';

export enum Priority {
  Low = 0,
  Medium = 1,
  High = 2,
}

export interface EventProcessingQueueOptions {
  maxConcurrency?: number;
  pollIntervalMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  priorityWeights?: { high: number; medium: number; low: number };
  /**
   * Retry policy overrides for attempt budgeting and failure eligibility.
   * Anything omitted falls back to `RETRY_POLICY_DEFAULTS`.
   *
   * Note: this queue keeps its own unbounded `baseDelayMs * 2^attempt` backoff,
   * so only the `maxAttempts` and `retryableFailureTypes` knobs are taken from
   * the policy here — the delay knobs are ignored by design.
   */
  retryPolicy?: Pick<Partial<RetryPolicyConfig>, 'maxAttempts' | 'retryableFailureTypes'>;
}

export type EventProcessor = (
  event: StellarSDK.rpc.Api.EventResponse,
  contractConfig: ContractConfig,
  requestId?: string
) => Promise<boolean>;

interface QueuedEvent {
  event: StellarSDK.rpc.Api.EventResponse;
  contractConfig: ContractConfig;
  requestId: string;
  retryCount: number;
  nextRetryAt: number;
  fingerprint: string;
  priority: Priority;
  enqueuedAt: number;
}

const DEFAULTS = {
  maxConcurrency: 1,
  pollIntervalMs: 1_000,
  maxRetries: 3,
  baseDelayMs: 2_000,
  priorityWeights: { high: 5, medium: 2, low: 1 },
};

export class EventProcessingQueue {
  private queue: QueuedEvent[] = [];
  private readonly queuedFingerprints: Set<string> = new Set();
  private readonly activeFingerprints: Set<string> = new Set();
  private readonly maxConcurrency: number;
  private readonly pollIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly priorityWeights: { high: number; medium: number; low: number };
  private readonly processor: EventProcessor;
  private timer: ReturnType<typeof setInterval> | null = null;
  private priorityCounters: { high: number; medium: number; low: number } = { high: 0, medium: 0, low: 0 };
  private readonly policy: RetryPolicy;

  // Metrics
  private metrics = {
    totalEnqueued: 0,
    totalProcessed: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    totalSkippedPermanent: 0,
    processingTimes: [] as number[],
  };

  constructor(processor: EventProcessor, options?: EventProcessingQueueOptions) {
    this.processor = processor;
    this.maxConcurrency = Math.max(1, options?.maxConcurrency ?? DEFAULTS.maxConcurrency);
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.maxRetries = options?.maxRetries ?? DEFAULTS.maxRetries;
    this.baseDelayMs = options?.baseDelayMs ?? DEFAULTS.baseDelayMs;
    this.priorityWeights = options?.priorityWeights ?? DEFAULTS.priorityWeights;
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
  ): boolean {
    const correlationId = requestId ?? generateCorrelationId();
    const fingerprint = buildEventFingerprint(event, contractConfig.address);

    if (this.queuedFingerprints.has(fingerprint)) {
      logger.info('Skipping duplicate event queue entry', {
        requestId: correlationId,
        correlationId,
        eventId: event.id,
        contractAddress: contractConfig.address,
        fingerprint,
      });
      return false;
    }

    const delayMs = this.calculateDelay(0);
    const nextRetryAt = Date.now() + delayMs;

    logger.info('Event queued for processing', {
      requestId: correlationId,
      correlationId,
      eventId: event.id,
      contractAddress: contractConfig.address,
      delayMs,
      nextRetryAt: new Date(nextRetryAt).toISOString(),
      maxRetries: this.maxRetries,
      priority: Priority[priority],
    });

    this.queuedFingerprints.add(fingerprint);
    this.queue.push({
      event,
      contractConfig,
      requestId: correlationId,
      retryCount: 0,
      nextRetryAt,
      fingerprint,
      priority,
      enqueuedAt: Date.now(),
    });
    this.metrics.totalEnqueued++;

    return true;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.processNext().catch((err) =>
        logger.error('Unexpected error in event processing queue', { error: err })
      );
    }, this.pollIntervalMs);
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

  pendingCount(): number {
    return this.queue.length;
  }

  private async processNext(): Promise<void> {
    const available = this.maxConcurrency - this.activeFingerprints.size;
    if (available <= 0) return;

    const now = Date.now();

    const due = this.queue
      .filter((item) => item.nextRetryAt <= now && !this.activeFingerprints.has(item.fingerprint))
      .sort((a, b) => {
        const priorityA = this.getWeightedPriority(a);
        const priorityB = this.getWeightedPriority(b);
        if (priorityB !== priorityA) return priorityB - priorityA;
        return a.enqueuedAt - b.enqueuedAt;
      })
      .slice(0, available);

    if (due.length === 0) return;

    for (const item of due) {
      if (item.priority === Priority.High) this.priorityCounters.high++;
      else if (item.priority === Priority.Medium) this.priorityCounters.medium++;
      else this.priorityCounters.low++;
    }

    const selectedFingerprints = new Set(due.map((item) => item.fingerprint));

    this.queue = this.queue.filter(
      (item) =>
        item.nextRetryAt > now ||
        this.activeFingerprints.has(item.fingerprint) ||
        !selectedFingerprints.has(item.fingerprint)
    );

    const results = await Promise.allSettled(due.map((item) => this.processItem(item)));

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error('Unexpected rejection in event processing queue', {
          error: result.reason,
        });
      }
    }
  }

  private getWeightedPriority(item: QueuedEvent): number {
    const basePriority = item.priority;
    const age = Date.now() - item.enqueuedAt;
    const ageBonus = Math.floor(age / 60000);

    let weight = 0;
    if (item.priority === Priority.High) weight = this.priorityWeights.high;
    else if (item.priority === Priority.Medium) weight = this.priorityWeights.medium;
    else weight = this.priorityWeights.low;

    return basePriority + ageBonus + weight;
  }

  private async processItem(item: QueuedEvent): Promise<void> {
    this.activeFingerprints.add(item.fingerprint);
    const startTime = Date.now();
    const attempt = item.retryCount + 1;

    try {
      const success = await this.processor(item.event, item.contractConfig, item.requestId);
      const duration = Date.now() - startTime;

      if (success) {
        this.queuedFingerprints.delete(item.fingerprint);
        this.activeFingerprints.delete(item.fingerprint);
        this.metrics.totalProcessed++;
        this.metrics.totalSucceeded++;
        this.metrics.processingTimes.push(duration);
        logger.info('Event processing succeeded', {
          requestId: item.requestId,
          correlationId: item.requestId,
          eventId: item.event.id,
          contractAddress: item.contractConfig.address,
        });
        return;
      }

      // A plain `false` carries no signal, so fall back to the retryable-by-
      // default `Unknown` classification and let the policy decide.
      this.activeFingerprints.delete(item.fingerprint);
      this.handleFailure(item, attempt, RetryFailureType.Unknown, duration, undefined);
    } catch (error) {
      this.activeFingerprints.delete(item.fingerprint);
      this.handleFailure(
        item,
        attempt,
        classifyError(error),
        Date.now() - startTime,
        error,
      );
    }
  }

  /**
   * Record a failed processing attempt and either requeue the event or retire
   * it. `crashed` only affects the log wording so rejections stay
   * distinguishable from a `false` return.
   */
  private handleFailure(
    item: QueuedEvent,
    attempt: number,
    failureType: RetryFailureType,
    duration: number,
    error: unknown,
  ): void {
    const crashed = error !== undefined;
    const decision = this.policy.evaluate(failureType, attempt, this.maxRetries);

    if (!decision.shouldRetry) {
      this.queuedFingerprints.delete(item.fingerprint);
      this.metrics.totalProcessed++;
      this.metrics.totalFailed++;
      if (decision.reason === 'permanent') {
        this.metrics.totalSkippedPermanent++;
      }
      this.metrics.processingTimes.push(duration);

      if (decision.reason === 'permanent') {
        logger.error('Event processing failed permanently, not retried', {
          requestId: item.requestId,
          correlationId: item.requestId,
          eventId: item.event.id,
          contractAddress: item.contractConfig.address,
          totalAttempts: attempt,
          failureType,
          ...(crashed ? { error } : {}),
        });
        return;
      }

      logger.error(
        crashed
          ? 'Event processing crashed after max retries'
          : 'Event processing permanently failed after max retries',
        {
          requestId: item.requestId,
          correlationId: item.requestId,
          eventId: item.event.id,
          contractAddress: item.contractConfig.address,
          totalAttempts: attempt,
          failureType,
          ...(crashed ? { error } : {}),
        },
      );
      return;
    }

    const delayMs = this.calculateDelay(attempt);
    const nextRetryAt = Date.now() + delayMs;

    if (crashed) {
      logger.error('Event processing crashed, scheduling retry', {
        requestId: item.requestId,
        correlationId: item.requestId,
        eventId: item.event.id,
        contractAddress: item.contractConfig.address,
        attempt,
        delayMs,
        failureType,
        error,
      });
    } else {
      logger.warn('Event processing failed, scheduling retry', {
        requestId: item.requestId,
        correlationId: item.requestId,
        eventId: item.event.id,
        contractAddress: item.contractConfig.address,
        attempt,
        delayMs,
        failureType,
        nextRetryAt: new Date(nextRetryAt).toISOString(),
      });
    }

    this.queue.push({ ...item, retryCount: attempt, nextRetryAt });
  }

  getMetrics() {
    const times = this.metrics.processingTimes;
    const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const min = times.length > 0 ? Math.min(...times) : 0;
    const max = times.length > 0 ? Math.max(...times) : 0;

    return {
      queueSize: this.queue.length,
      activeCount: this.activeFingerprints.size,
      ...this.metrics,
      processingTime: {
        min,
        max,
        avg,
      },
    };
  }

  private calculateDelay(retryCount: number): number {
    return this.baseDelayMs * Math.pow(2, retryCount);
  }
}

function buildEventFingerprint(
  event: StellarSDK.rpc.Api.EventResponse,
  contractAddress: string
): string {
  return `${contractAddress}:${event.id}`;
}
