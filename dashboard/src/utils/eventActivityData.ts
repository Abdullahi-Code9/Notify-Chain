import type { BlockchainEvent } from '../types/event';

/**
 * Selected time window for the Event Activity chart (issue #982).
 *
 * Each range maps to a fixed window length and a fixed bucket width so that
 * buckets always share the same time boundaries: they are contiguous,
 * non-overlapping and of equal width.
 */
export type EventActivityRange = '1h' | '6h' | '24h' | '7d';

export const EVENT_ACTIVITY_RANGES: readonly EventActivityRange[] = ['1h', '6h', '24h', '7d'];

export const DEFAULT_EVENT_ACTIVITY_RANGE: EventActivityRange = '24h';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Window length (ms) for each selectable range. */
const RANGE_WINDOW_MS: Record<EventActivityRange, number> = {
  '1h': HOUR_MS,
  '6h': 6 * HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
};

/**
 * Bucket width (ms) for each range. The window is always an exact multiple of
 * the bucket width so there are no partial buckets and every boundary aligns.
 */
const RANGE_BUCKET_MS: Record<EventActivityRange, number> = {
  '1h': 15 * MINUTE_MS,
  '6h': HOUR_MS,
  '24h': HOUR_MS,
  '7d': 6 * HOUR_MS,
};

export interface EventActivityBucket {
  /** Stable identity derived from the bucket start boundary. */
  key: string;
  /** Inclusive start of the bucket (epoch ms). */
  startMs: number;
  /** Exclusive end of the bucket (epoch ms). */
  endMs: number;
  /** Short axis label. */
  label: string;
  /** Longer, human-readable label for tooltips. */
  displayLabel: string;
  /** Number of in-window events whose `receivedAt` falls in [startMs, endMs). */
  count: number;
}

export interface EventActivitySummary {
  /** Oldest bucket first, for left-to-right rendering. */
  buckets: EventActivityBucket[];
  /** Sum of `buckets[].count`; reconciles with the in-window event count. */
  totalCount: number;
  /** Largest bucket count (0 when there are no events). */
  maxCount: number;
  /** Inclusive start of the whole window. */
  windowStartMs: number;
  /** Exclusive end of the whole window (the `now` boundary). */
  windowEndMs: number;
  /** Bucket width in milliseconds. */
  bucketMs: number;
}

/** Length of the selected range in milliseconds. */
export function getEventActivityWindowMs(range: EventActivityRange): number {
  return RANGE_WINDOW_MS[range] ?? RANGE_WINDOW_MS[DEFAULT_EVENT_ACTIVITY_RANGE];
}

/** Bucket width for the selected range in milliseconds. */
export function getEventActivityBucketMs(range: EventActivityRange): number {
  return RANGE_BUCKET_MS[range] ?? RANGE_BUCKET_MS[DEFAULT_EVENT_ACTIVITY_RANGE];
}

/** Whether `receivedAt` falls inside the half-open activity window. */
export function isInActivityWindow(
  receivedAt: number,
  windowStartMs: number,
  windowEndMs: number,
): boolean {
  return receivedAt >= windowStartMs && receivedAt < windowEndMs;
}

/** Keep only the events that fall inside the half-open activity window. */
export function filterEventsToActivityWindow(
  events: readonly BlockchainEvent[],
  windowStartMs: number,
  windowEndMs: number,
): BlockchainEvent[] {
  return events.filter((event) => isInActivityWindow(event.receivedAt, windowStartMs, windowEndMs));
}

/** Sum of all bucket counts in an activity summary. */
export function sumBucketCounts(buckets: readonly EventActivityBucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.count, 0);
}

function formatBucketDisplayLabel(startMs: number, bucketMs: number): string {
  const start = new Date(startMs);
  const end = new Date(startMs + bucketMs);

  const day = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = (d: Date) =>
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

  if (bucketMs >= 24 * HOUR_MS) {
    return day(start);
  }

  // Label buckets shorter than a day by their start time; include the day when
  // the bucket ends on a different calendar day (e.g. the 7d range).
  if (start.toDateString() !== end.toDateString()) {
    return `${day(start)} ${time(start)}`;
  }

  return time(start);
}

/**
 * Bucket `events` into a fixed number of equal-width time buckets ending at
 * `now` (exclusive). The window is `[now - windowMs, now)`.
 *
 * The returned summary is fully reconcilable: `totalCount` always equals the
 * number of events with `receivedAt` inside the window, and equals the sum of
 * the bucket counts. Empty datasets are supported and yield a non-null summary
 * with zeroed buckets.
 */
export function computeEventActivity(
  events: readonly BlockchainEvent[],
  range: EventActivityRange,
  now: number = Date.now(),
): EventActivitySummary {
  const windowMs = getEventActivityWindowMs(range);
  const bucketMs = getEventActivityBucketMs(range);
  const numBuckets = Math.max(1, Math.round(windowMs / bucketMs));

  const windowEndMs = now;
  const windowStartMs = windowEndMs - windowMs;

  const buckets: EventActivityBucket[] = Array.from({ length: numBuckets }, (_, i) => {
    const startMs = windowStartMs + i * bucketMs;
    const start = new Date(startMs);
    return {
      key: start.toISOString(),
      startMs,
      endMs: startMs + bucketMs,
      label: formatBucketDisplayLabel(startMs, bucketMs),
      displayLabel: formatBucketDisplayLabel(startMs, bucketMs),
      count: 0,
    };
  });

  for (const event of events) {
    if (!isInActivityWindow(event.receivedAt, windowStartMs, windowEndMs)) {
      continue;
    }

    const elapsed = windowEndMs - event.receivedAt;
    const fromEnd = Math.floor(elapsed / bucketMs);
    const index = Math.min(numBuckets - 1, Math.max(0, numBuckets - 1 - fromEnd));
    buckets[index].count++;
  }

  const totalCount = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const maxCount = buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0);

  return { buckets, totalCount, maxCount, windowStartMs, windowEndMs, bucketMs };
}
