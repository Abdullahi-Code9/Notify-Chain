import logger from '../utils/logger';
import { NotificationType } from '../types/scheduled-notification';
import { AnalyticsConfig } from '../types';

export type AnalyticsDeliveryOutcome = 'success' | 'failure' | 'retry' | 'skipped';

export interface AnalyticsDeliveryRecord {
  readonly notificationType: NotificationType;
  readonly contractAddress?: string;
  readonly outcome: AnalyticsDeliveryOutcome;
  readonly durationMs: number;
  readonly deliveryLatencyMs?: number;
  readonly errorReason?: string;
  readonly timestamp: number;
}

export interface AnalyticsBucketSnapshot {
  readonly bucketStart: number;
  readonly total: number;
  readonly success: number;
  readonly failure: number;
  readonly retry: number;
  readonly skipped: number;
  readonly averageDurationMs: number;
  readonly averageDeliveryLatencyMs: number;
}

export interface AnalyticsByTypeSnapshot {
  readonly notificationType: NotificationType;
  readonly total: number;
  readonly success: number;
  readonly failure: number;
  readonly successRate: number;
}

export interface AnalyticsByContractSnapshot {
  readonly contractAddress: string;
  readonly total: number;
  readonly success: number;
  readonly failure: number;
  readonly successRate: number;
}

export interface NotificationAnalyticsSnapshot {
  readonly totalRecorded: number;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly overall: {
    total: number;
    success: number;
    failure: number;
    retry: number;
    skipped: number;
    successRate: number;
    averageDurationMs: number;
    averageDeliveryLatencyMs: number;
  };
  readonly byType: readonly AnalyticsByTypeSnapshot[];
  readonly byContract: readonly AnalyticsByContractSnapshot[];
  readonly hourlyBuckets: readonly AnalyticsBucketSnapshot[];
  readonly errorBreakdown: Readonly<Record<string, number>>;
}

export interface NotificationAnalyticsOptions {
  /** Maximum number of records to retain in the rolling window. Oldest evicted first. */
  maxRecords?: number;
  /** Maximum number of hourly buckets retained in the rolling window. */
  maxBuckets?: number;
  /** Bucket size in milliseconds. Default 1 hour. */
  bucketSizeMs?: number;
  /** Top-N contracts to include in byContract breakdown. Default 20. */
  topContractsLimit?: number;
  /** Top-N error reasons to include. Default 20. */
  topErrorsLimit?: number;
  /** Time source for tests. */
  now?: () => number;
}

const DEFAULTS = {
  maxRecords: 10_000,
  maxBuckets: 168, // 7 days at hourly buckets
  bucketSizeMs: 60 * 60 * 1000,
  topContractsLimit: 20,
  topErrorsLimit: 20,
};

/**
 * NotificationAnalyticsAggregator tracks individual notification delivery
 * outcomes and produces aggregate statistics on demand. It is intentionally
 * memory-bounded (rolling window) and allocation-light: a single sorted array
 * of records and a sparse array of hourly buckets. No external storage is
 * required, which makes it suitable for in-process observability and the
 * `/api/analytics` HTTP endpoint.
 *
 * Thread-safety: the aggregator is single-threaded by design. Callers must
 * invoke `record()` synchronously from a single event loop tick. Concurrent
 * writes are not supported.
 */
export class NotificationAnalyticsAggregator {
  private readonly records: AnalyticsDeliveryRecord[] = [];
  private readonly maxRecords: number;
  private readonly maxBuckets: number;
  private readonly bucketSizeMs: number;
  private readonly topContractsLimit: number;
  private readonly topErrorsLimit: number;
  private readonly now: () => number;

  private totalRecorded = 0;
  private successCount = 0;
  private failureCount = 0;
  private retryCount = 0;
  private skippedCount = 0;
  private totalDurationMs = 0;
  private durationSamples = 0;

  constructor(options: NotificationAnalyticsOptions = {}) {
    this.maxRecords = Math.max(1, options.maxRecords ?? DEFAULTS.maxRecords);
    this.maxBuckets = Math.max(1, options.maxBuckets ?? DEFAULTS.maxBuckets);
    this.bucketSizeMs = Math.max(1_000, options.bucketSizeMs ?? DEFAULTS.bucketSizeMs);
    this.topContractsLimit = Math.max(0, options.topContractsLimit ?? DEFAULTS.topContractsLimit);
    this.topErrorsLimit = Math.max(0, options.topErrorsLimit ?? DEFAULTS.topErrorsLimit);
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a single delivery outcome. Synchronous, allocation-light.
   * Returns the index of the inserted record in the internal ring buffer.
   */
  record(record: AnalyticsDeliveryRecord): void {
    const ts = record.timestamp ?? this.now();
    const sanitized: AnalyticsDeliveryRecord = {
      notificationType: record.notificationType,
      outcome: record.outcome,
      durationMs: Math.max(0, record.durationMs),
      deliveryLatencyMs:
        record.deliveryLatencyMs !== undefined ? Math.max(0, record.deliveryLatencyMs) : undefined,
      timestamp: ts,
      contractAddress: record.contractAddress,
      errorReason: record.errorReason,
    };

    this.records.push(sanitized);
    this.totalRecorded++;

    switch (sanitized.outcome) {
      case 'success':
        this.successCount++;
        break;
      case 'failure':
        this.failureCount++;
        break;
      case 'retry':
        this.retryCount++;
        break;
      case 'skipped':
        this.skippedCount++;
        break;
    }

    if (sanitized.durationMs > 0) {
      this.totalDurationMs += sanitized.durationMs;
      this.durationSamples++;
    }

    if (this.records.length > this.maxRecords) {
      const evicted = this.records.length - this.maxRecords;
      // adjust counters based on evicted records to avoid drift
      for (let i = 0; i < evicted; i++) {
        const r = this.records[i];
        switch (r.outcome) {
          case 'success':
            this.successCount = Math.max(0, this.successCount - 1);
            break;
          case 'failure':
            this.failureCount = Math.max(0, this.failureCount - 1);
            break;
          case 'retry':
            this.retryCount = Math.max(0, this.retryCount - 1);
            break;
          case 'skipped':
            this.skippedCount = Math.max(0, this.skippedCount - 1);
            break;
        }
        if (r.durationMs > 0) {
          this.totalDurationMs = Math.max(0, this.totalDurationMs - r.durationMs);
          this.durationSamples = Math.max(0, this.durationSamples - 1);
        }
      }
      this.records.splice(0, evicted);
    }
  }

  /** Total number of records ever seen by this aggregator, including evicted. */
  get lifetimeCount(): number {
    return this.totalRecorded;
  }

  /** Current number of records retained in the rolling window. */
  get size(): number {
    return this.records.length;
  }

  /** Reset the aggregator to an empty state. */
  reset(): void {
    this.records.length = 0;
    this.totalRecorded = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.retryCount = 0;
    this.skippedCount = 0;
    this.totalDurationMs = 0;
    this.durationSamples = 0;
  }

  /**
   * Build a point-in-time snapshot of the rolling window. This is the primary
   * consumption entry point. Cost is O(N) over the rolling window.
   */
  snapshot(): NotificationAnalyticsSnapshot {
    const now = this.now();
    const windowStart = this.computeWindowStart(now);
    const visible = this.records.filter((r) => r.timestamp >= windowStart);

    const totals = this.computeOverall(visible);
    const byType = this.computeByType(visible);
    const byContract = this.computeByContract(visible);
    const hourlyBuckets = this.computeHourlyBuckets(visible, now);
    const errorBreakdown = this.computeErrorBreakdown(visible);

    return {
      totalRecorded: this.totalRecorded,
      windowStart,
      windowEnd: now,
      overall: totals,
      byType,
      byContract,
      hourlyBuckets,
      errorBreakdown,
    };
  }

  private computeWindowStart(now: number): number {
    // Window is anchored to the current bucket start, not the oldest record,
    // so that records older than the window are consistently excluded even
    // if they are still in the rolling buffer.
    const currentBucketStart = Math.floor(now / this.bucketSizeMs) * this.bucketSizeMs;
    return currentBucketStart - this.maxBuckets * this.bucketSizeMs;
  }

  private computeOverall(
    visible: AnalyticsDeliveryRecord[],
  ): NotificationAnalyticsSnapshot['overall'] {
    let success = 0;
    let failure = 0;
    let retry = 0;
    let skipped = 0;
    let durationSum = 0;
    let durationCount = 0;
    let latencySum = 0;
    let latencyCount = 0;

    for (const r of visible) {
      if (r.outcome === 'success') success++;
      else if (r.outcome === 'failure') failure++;
      else if (r.outcome === 'retry') retry++;
      else if (r.outcome === 'skipped') skipped++;

      if (r.durationMs > 0) {
        durationSum += r.durationMs;
        durationCount++;
      }

      if (
        r.outcome === 'success' &&
        r.deliveryLatencyMs !== undefined &&
        r.deliveryLatencyMs >= 0
      ) {
        latencySum += r.deliveryLatencyMs;
        latencyCount++;
      }
    }

    const total = success + failure + retry + skipped;
    const terminal = success + failure;
    const successRate = terminal > 0 ? success / terminal : 0;
    const averageDurationMs = durationCount > 0 ? durationSum / durationCount : 0;
    const averageDeliveryLatencyMs = latencyCount > 0 ? latencySum / latencyCount : 0;

    return {
      total,
      success,
      failure,
      retry,
      skipped,
      successRate,
      averageDurationMs,
      averageDeliveryLatencyMs,
    };
  }

  private computeByType(visible: AnalyticsDeliveryRecord[]): AnalyticsByTypeSnapshot[] {
    const map = new Map<NotificationType, { total: number; success: number; failure: number }>();
    for (const r of visible) {
      const entry = map.get(r.notificationType) ?? { total: 0, success: 0, failure: 0 };
      entry.total++;
      if (r.outcome === 'success') entry.success++;
      else if (r.outcome === 'failure') entry.failure++;
      map.set(r.notificationType, entry);
    }

    const result: AnalyticsByTypeSnapshot[] = [];
    for (const [notificationType, v] of map) {
      const terminal = v.success + v.failure;
      result.push({
        notificationType,
        total: v.total,
        success: v.success,
        failure: v.failure,
        successRate: terminal > 0 ? v.success / terminal : 0,
      });
    }
    result.sort((a, b) => b.total - a.total);
    return result;
  }

  private computeByContract(visible: AnalyticsDeliveryRecord[]): AnalyticsByContractSnapshot[] {
    const map = new Map<string, { total: number; success: number; failure: number }>();
    for (const r of visible) {
      if (!r.contractAddress) continue;
      const entry = map.get(r.contractAddress) ?? { total: 0, success: 0, failure: 0 };
      entry.total++;
      if (r.outcome === 'success') entry.success++;
      else if (r.outcome === 'failure') entry.failure++;
      map.set(r.contractAddress, entry);
    }

    const result: AnalyticsByContractSnapshot[] = [];
    for (const [contractAddress, v] of map) {
      const terminal = v.success + v.failure;
      result.push({
        contractAddress,
        total: v.total,
        success: v.success,
        failure: v.failure,
        successRate: terminal > 0 ? v.success / terminal : 0,
      });
    }
    result.sort((a, b) => b.total - a.total);
    if (this.topContractsLimit > 0 && result.length > this.topContractsLimit) {
      return result.slice(0, this.topContractsLimit);
    }
    return result;
  }

  private computeHourlyBuckets(
    visible: AnalyticsDeliveryRecord[],
    now: number,
  ): AnalyticsBucketSnapshot[] {
    const newestBucketStart = Math.floor(now / this.bucketSizeMs) * this.bucketSizeMs;
    const oldestBucketStart = newestBucketStart - (this.maxBuckets - 1) * this.bucketSizeMs;

    const buckets: AnalyticsBucketSnapshot[] = [];
    const indexByStart = new Map<number, number>();

    for (let t = oldestBucketStart; t <= newestBucketStart; t += this.bucketSizeMs) {
      const snapshot: AnalyticsBucketSnapshot = {
        bucketStart: t,
        total: 0,
        success: 0,
        failure: 0,
        retry: 0,
        skipped: 0,
        averageDurationMs: 0,
        averageDeliveryLatencyMs: 0,
      };
      indexByStart.set(t, buckets.length);
      buckets.push(snapshot);
    }

    let durationSumBucket = 0;
    let durationCountBucket = 0;
    let durationBucketIdx = -1;

    let latencySumBucket = 0;
    let latencyCountBucket = 0;
    let latencyBucketIdx = -1;

    for (const r of visible) {
      const bucketStart = Math.floor(r.timestamp / this.bucketSizeMs) * this.bucketSizeMs;
      const idx = indexByStart.get(bucketStart);
      if (idx === undefined) continue;

      const bucket = buckets[idx];
      buckets[idx] = {
        ...bucket,
        total: bucket.total + 1,
        success: bucket.success + (r.outcome === 'success' ? 1 : 0),
        failure: bucket.failure + (r.outcome === 'failure' ? 1 : 0),
        retry: bucket.retry + (r.outcome === 'retry' ? 1 : 0),
        skipped: bucket.skipped + (r.outcome === 'skipped' ? 1 : 0),
      };

      if (r.durationMs > 0) {
        if (idx !== durationBucketIdx) {
          durationSumBucket = 0;
          durationCountBucket = 0;
          durationBucketIdx = idx;
        }
        durationSumBucket += r.durationMs;
        durationCountBucket++;
        buckets[idx] = {
          ...buckets[idx],
          averageDurationMs: durationSumBucket / durationCountBucket,
        };
      }

      if (
        r.outcome === 'success' &&
        r.deliveryLatencyMs !== undefined &&
        r.deliveryLatencyMs >= 0
      ) {
        if (idx !== latencyBucketIdx) {
          latencySumBucket = 0;
          latencyCountBucket = 0;
          latencyBucketIdx = idx;
        }
        latencySumBucket += r.deliveryLatencyMs;
        latencyCountBucket++;
        buckets[idx] = {
          ...buckets[idx],
          averageDeliveryLatencyMs: latencySumBucket / latencyCountBucket,
        };
      }
    }

    return buckets;
  }

  private computeErrorBreakdown(visible: AnalyticsDeliveryRecord[]): Record<string, number> {
    const counts = new Map<string, number>();
    for (const r of visible) {
      if (r.outcome !== 'failure') continue;
      const key = r.errorReason ?? 'unknown';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const limit = this.topErrorsLimit > 0 ? this.topErrorsLimit : sorted.length;
    const limited = sorted.slice(0, limit);
    const result: Record<string, number> = {};
    for (const [reason, count] of limited) {
      result[reason] = count;
    }
    if (this.topErrorsLimit > 0 && sorted.length > this.topErrorsLimit) {
      let overflowCount = 0;
      for (let i = this.topErrorsLimit; i < sorted.length; i++) {
        overflowCount += sorted[i][1];
      }
      if (overflowCount > 0) {
        result.__other = overflowCount;
      }
    }
    return result;
  }
}

/**
 * Process-wide default aggregator instance. Replaced in tests via
 * `setNotificationAnalyticsAggregator` to avoid global state leaks.
 */
let defaultInstance: NotificationAnalyticsAggregator | null = null;

export function initNotificationAnalyticsAggregator(
  config: AnalyticsConfig,
): NotificationAnalyticsAggregator {
  defaultInstance = new NotificationAnalyticsAggregator({
    maxRecords: config.maxRecords,
    maxBuckets: config.maxBuckets,
    bucketSizeMs: config.bucketSizeMs,
  });
  logger.info('Notification analytics aggregator initialized', {
    maxRecords: config.maxRecords,
    maxBuckets: config.maxBuckets,
    bucketSizeMs: config.bucketSizeMs,
  });
  return defaultInstance;
}

export function getNotificationAnalyticsAggregator(): NotificationAnalyticsAggregator {
  if (!defaultInstance) {
    defaultInstance = new NotificationAnalyticsAggregator();
    logger.info('Notification analytics aggregator initialized with defaults');
  }
  return defaultInstance;
}

export function setNotificationAnalyticsAggregator(
  instance: NotificationAnalyticsAggregator | null,
): void {
  defaultInstance = instance;
}
