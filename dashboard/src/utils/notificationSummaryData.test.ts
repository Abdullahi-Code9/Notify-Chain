import {
  computeNotificationSummary,
  generateMockNotificationSummary,
} from './notificationSummaryData';
import type { ScheduleStatsResponse } from '../types/notificationHealth';
import { formatCount, formatDeliveredRate } from '../types/notificationSummary';

function stats(overrides: Partial<ScheduleStatsResponse> = {}): ScheduleStatsResponse {
  return {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    overdue: 0,
    ...overrides,
  };
}

describe('computeNotificationSummary', () => {
  it('maps completed notifications to delivered', () => {
    const m = computeNotificationSummary(stats({ completed: 5 }));
    expect(m.delivered).toBe(5);
    expect(m.pending).toBe(0);
    expect(m.failed).toBe(0);
    expect(m.total).toBe(5);
    expect(m.deliveredRate).toBe(100);
  });

  it('counts pending and processing toward the pending bucket', () => {
    const m = computeNotificationSummary(stats({ pending: 4, processing: 3 }));
    expect(m.pending).toBe(7);
    expect(m.delivered).toBe(0);
    expect(m.failed).toBe(0);
  });

  it('folds overdue jobs into the pending bucket', () => {
    const m = computeNotificationSummary(stats({ overdue: 6 }));
    expect(m.pending).toBe(6);
  });

  it('counts failed and cancelled... maps failed to the failed bucket', () => {
    const m = computeNotificationSummary(stats({ failed: 9 }));
    expect(m.failed).toBe(9);
    expect(m.pending).toBe(0);
    expect(m.delivered).toBe(0);
  });

  it('keeps the three buckets exhaustive (delivered + pending + failed === total)', () => {
    const m = computeNotificationSummary(
      stats({ pending: 12, processing: 7, completed: 200, failed: 5, overdue: 3 }),
    );
    expect(m.delivered + m.pending + m.failed).toBe(m.total);
    expect(m.delivered).toBe(200);
    expect(m.pending).toBe(22);
    expect(m.failed).toBe(5);
    expect(m.total).toBe(227);
  });

  it('computes the delivered rate as a percentage of the total', () => {
    const m = computeNotificationSummary(stats({ completed: 180, failed: 20 }));
    expect(m.deliveredRate).toBe(90);
  });

  it('rounds the delivered rate for display (formatter handles rounding)', () => {
    // 1 / 3 = 33.333... -> the raw rate; the formatter yields "33.3%".
    const m = computeNotificationSummary(stats({ completed: 1, pending: 1, failed: 1 }));
    expect(m.deliveredRate).toBeCloseTo((1 / 3) * 100, 5);
  });

  it('returns zeros (and a 0 rate) for an empty schedule', () => {
    const m = computeNotificationSummary(stats());
    expect(m).toEqual({
      delivered: 0,
      pending: 0,
      failed: 0,
      total: 0,
      deliveredRate: 0,
    });
  });

  it('produces a stable, deterministic mock summary', () => {
    const a = generateMockNotificationSummary();
    const b = generateMockNotificationSummary();
    expect(a).toEqual(b);
    expect(a.delivered + a.pending + a.failed).toBe(a.total);
    expect(a.deliveredRate).toBeCloseTo((a.delivered / a.total) * 100, 1);
  });
});

describe('notificationSummary format helpers', () => {
  it('formats counts with locale grouping', () => {
    expect(formatCount(1842)).toBe('1,842');
    expect(formatCount(0)).toBe('0');
  });

  it('formats the delivered rate as a percentage', () => {
    expect(formatDeliveredRate(85.9)).toBe('85.9%');
    expect(formatDeliveredRate(0)).toBe('0.0%');
  });
});
