import { calculateNextRun, computeNextRun } from './recurrence';
import { RecurrenceRule } from '../types/scheduled-notification';

describe('computeNextRun', () => {
  const start = new Date('2024-01-01T12:30:00.000Z');

  it.each([
    ['minutely', '2024-01-01T12:31:00.000Z'],
    ['hourly', '2024-01-01T13:30:00.000Z'],
    ['daily', '2024-01-02T12:30:00.000Z'],
    ['weekly', '2024-01-08T12:30:00.000Z'],
    ['monthly', '2024-02-01T12:30:00.000Z'],
  ] as const)('computes the next %s occurrence in UTC', (frequency, expected) => {
    expect(computeNextRun({ frequency }, start)?.toISOString()).toBe(expected);
  });

  it('applies intervals greater than one', () => {
    expect(computeNextRun({ frequency: 'weekly', interval: 3 }, start)?.toISOString()).toBe(
      '2024-01-22T12:30:00.000Z',
    );
  });

  it('clamps month-end dates deterministically', () => {
    expect(
      computeNextRun({ frequency: 'monthly' }, new Date('2024-01-31T12:00:00Z'))?.toISOString(),
    ).toBe('2024-02-29T12:00:00.000Z');
    expect(
      computeNextRun({ frequency: 'monthly' }, new Date('2023-01-31T12:00:00Z'))?.toISOString(),
    ).toBe('2023-02-28T12:00:00.000Z');
  });

  it('preserves UTC time over leap day and daylight-saving boundaries', () => {
    expect(
      computeNextRun({ frequency: 'daily' }, new Date('2024-02-28T12:30:00Z'))?.toISOString(),
    ).toBe('2024-02-29T12:30:00.000Z');
    expect(
      computeNextRun({ frequency: 'daily' }, new Date('2024-03-09T12:30:00-05:00'))?.toISOString(),
    ).toBe('2024-03-10T17:30:00.000Z');
  });

  it('enforces inclusive until and count boundaries', () => {
    const untilRule: RecurrenceRule = { frequency: 'daily', until: '2024-01-02T12:30:00Z' };
    expect(computeNextRun(untilRule, start)?.toISOString()).toBe('2024-01-02T12:30:00.000Z');
    expect(computeNextRun(untilRule, new Date('2024-01-02T12:30:00Z'))).toBeNull();
    expect(
      computeNextRun({ frequency: 'daily', count: 2 }, start, undefined, 1)?.toISOString(),
    ).toBe('2024-01-02T12:30:00.000Z');
    expect(
      computeNextRun(
        { frequency: 'daily', count: 2 },
        new Date('2024-01-02T12:30:00Z'),
        undefined,
        2,
      ),
    ).toBeNull();
  });

  it('skips missed runs and counts them as consumed', () => {
    const now = new Date('2024-01-05T12:30:00.000Z');
    const result = calculateNextRun({ frequency: 'daily', count: 10 }, start, now, 1);
    expect(result).toEqual({ nextRun: new Date('2024-01-06T12:30:00.000Z'), occurrenceCount: 5 });
  });

  it('completes when skipped runs exhaust the count or until', () => {
    const byCount = calculateNextRun(
      { frequency: 'daily', count: 3 },
      start,
      new Date('2024-01-05T12:30:00Z'),
      1,
    );
    expect(byCount).toEqual({ nextRun: null, occurrenceCount: 3 });

    const byUntil = calculateNextRun(
      { frequency: 'daily', until: '2024-01-03T12:30:00Z' },
      start,
      new Date('2024-01-05T12:30:00Z'),
      1,
    );
    expect(byUntil).toEqual({ nextRun: null, occurrenceCount: 3 });
  });

  it('returns identical values for identical inputs', () => {
    const rule: RecurrenceRule = { frequency: 'monthly', interval: 2, count: 8 };
    const first = computeNextRun(
      rule,
      new Date('2024-01-31T12:00:00Z'),
      new Date('2024-04-01T00:00:00Z'),
      1,
    );
    const second = computeNextRun(
      rule,
      new Date('2024-01-31T12:00:00Z'),
      new Date('2024-04-01T00:00:00Z'),
      1,
    );
    expect(first?.toISOString()).toBe(second?.toISOString());
  });
});
