import {
  computeEventActivity,
  filterEventsToActivityWindow,
  getEventActivityBucketMs,
  getEventActivityWindowMs,
  isInActivityWindow,
  sumBucketCounts,
  type EventActivityBucket,
} from './eventActivityData';

import type { BlockchainEvent } from '../types/event';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0, 0);

function makeEvent(receivedAt: number, index = 0): BlockchainEvent {
  return {
    eventId: `evt-${index}-${receivedAt}`,
    contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    eventName: 'notification_scheduled',
    ledger: 1000 + index,
    type: 'contract',
    topic: ['notification_scheduled'],
    value: '{}',
    receivedAt,
  };
}

function makeEvents(times: number[]): BlockchainEvent[] {
  return times.map((t, i) => makeEvent(t, i));
}

describe('computeEventActivity', () => {
  it('produces equal-width, contiguous buckets for every range', () => {
    const cases: Array<[Parameters<typeof computeEventActivity>[1], number]> = [
      ['1h', 4],
      ['6h', 6],
      ['24h', 24],
      ['7d', 28],
    ];

    for (const [range, expectedBuckets] of cases) {
      const { buckets, bucketMs, windowStartMs, windowEndMs } = computeEventActivity([], range, NOW);

      expect(buckets).toHaveLength(expectedBuckets);
      expect(windowEndMs - windowStartMs).toBe(getEventActivityWindowMs(range));
      expect(bucketMs).toBe(getEventActivityBucketMs(range));

      buckets.forEach((bucket, index) => {
        // Every bucket is exactly bucketMs wide.
        expect(bucket.endMs - bucket.startMs).toBe(bucketMs);
        // Buckets are contiguous: each starts where the previous ended.
        if (index > 0) {
          expect(bucket.startMs).toBe(buckets[index - 1].endMs);
        }
      });

      // The first bucket starts at the window start and the last ends at `now`.
      expect(buckets[0].startMs).toBe(windowStartMs);
      expect(buckets[buckets.length - 1].endMs).toBe(windowEndMs);
    }
  });

  it('supports empty datasets with zeroed buckets', () => {
    const summary = computeEventActivity([], '24h', NOW);

    expect(summary.totalCount).toBe(0);
    expect(summary.maxCount).toBe(0);
    expect(summary.buckets.every((bucket) => bucket.count === 0)).toBe(true);
  });

  it('reconciles bucket counts with the underlying events', () => {
    const times = [
      NOW - 30 * 60 * 1000,
      NOW - 2 * HOUR_MS,
      NOW - 2 * HOUR_MS + 60 * 1000,
      NOW - 5 * HOUR_MS,
      NOW - 23 * HOUR_MS,
    ];
    const events = makeEvents(times);

    const summary = computeEventActivity(events, '24h', NOW);
    const inWindow = filterEventsToActivityWindow(events, summary.windowStartMs, summary.windowEndMs);

    const summed = summary.buckets.reduce((sum, bucket) => sum + bucket.count, 0);

    expect(inWindow).toHaveLength(times.length);
    expect(summed).toBe(inWindow.length);
    expect(summary.totalCount).toBe(inWindow.length);
  });

  it('excludes events outside the window', () => {
    const events = makeEvents([NOW - 25 * HOUR_MS, NOW - 1 * HOUR_MS, NOW + 60 * 1000]);

    const summary = computeEventActivity(events, '24h', NOW);

    // 25h ago and 1 minute in the future are outside [now - 24h, now).
    expect(summary.totalCount).toBe(1);
  });

  it('assigns boundary events to the correct bucket (half-open window)', () => {
    // An event exactly at `windowStart` lands in the oldest bucket...
    const oldest = computeEventActivity(makeEvents([NOW - 24 * HOUR_MS]), '24h', NOW);
    expect(oldest.buckets[0].count).toBe(1);

    // ...an event just before `now` lands in the newest bucket.
    const newest = computeEventActivity(makeEvents([NOW - 1]), '24h', NOW);
    expect(newest.buckets[newest.buckets.length - 1].count).toBe(1);
  });

  it('reports the maximum bucket count', () => {
    const events = makeEvents([
      NOW - 1 * HOUR_MS,
      NOW - 1 * HOUR_MS - 60 * 1000,
      NOW - 1 * HOUR_MS - 120 * 1000,
      NOW - 10 * HOUR_MS,
    ]);

    const summary = computeEventActivity(events, '24h', NOW);

    expect(summary.maxCount).toBe(3);
  });

  it('keeps buckets oldest-first for left-to-right rendering', () => {
    const summary = computeEventActivity([], '6h', NOW);

    for (let i = 1; i < summary.buckets.length; i++) {
      expect(summary.buckets[i].startMs).toBeGreaterThan(summary.buckets[i - 1].startMs);
    }
  });
});

describe('isInActivityWindow', () => {
  it('treats the window as half-open [start, end)', () => {
    const start = NOW - HOUR_MS;
    const end = NOW;

    expect(isInActivityWindow(start, start, end)).toBe(true);
    expect(isInActivityWindow(end - 1, start, end)).toBe(true);
    expect(isInActivityWindow(end, start, end)).toBe(false);
    expect(isInActivityWindow(start - 1, start, end)).toBe(false);
  });
});

describe('bucket helpers', () => {
  it('exposes a stable key per bucket boundary', () => {
    const { buckets } = computeEventActivity([], '24h', NOW);
    const keys = buckets.map((b: EventActivityBucket) => b.key);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('sumBucketCounts', () => {
  it('sums counts across buckets', () => {
    const buckets: EventActivityBucket[] = [
      {
        key: 'a',
        startMs: 0,
        endMs: 1,
        label: 'a',
        displayLabel: 'a',
        count: 2,
      },
      {
        key: 'b',
        startMs: 1,
        endMs: 2,
        label: 'b',
        displayLabel: 'b',
        count: 3,
      },
    ];

    expect(sumBucketCounts(buckets)).toBe(5);
    expect(sumBucketCounts([])).toBe(0);
  });
});
