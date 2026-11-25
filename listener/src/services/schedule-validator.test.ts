import {
  ScheduleValidationError,
  toScheduleValidationResponse,
  validateScheduleInput,
} from './schedule-validator';

describe('validateScheduleInput', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const horizonMs = 60_000;

  it('allows the exact horizon and times before it', () => {
    expect(() =>
      validateScheduleInput(new Date(now.getTime() + horizonMs), undefined, now, horizonMs),
    ).not.toThrow();
    expect(() =>
      validateScheduleInput(new Date(now.getTime() + horizonMs - 1), undefined, now, horizonMs),
    ).not.toThrow();
  });

  it('rejects a time beyond the horizon with the limit and offending value', () => {
    const offending = new Date(now.getTime() + horizonMs + 1);
    expect(() => validateScheduleInput(offending, undefined, now, horizonMs)).toThrow(
      `executeAt ${offending.toISOString()} exceeds the maximum scheduling horizon of ${horizonMs} ms`,
    );
  });

  it('rejects far-future schedules', () => {
    expect(() =>
      validateScheduleInput(new Date('2099-01-01T00:00:00.000Z'), undefined, now, horizonMs),
    ).toThrow('maximum scheduling horizon');
  });

  it('preserves the existing past-time rejection', () => {
    expect(() =>
      validateScheduleInput(new Date(now.getTime() - 1), undefined, now, horizonMs),
    ).toThrow('executeAt must be a future timestamp');
  });

  it('serializes schedule validation failures with the API error format', () => {
    const response = toScheduleValidationResponse(
      new ScheduleValidationError('executeAt is too far ahead'),
    );
    expect(response).toEqual({
      statusCode: 400,
      body: { error: 'executeAt is too far ahead', code: 'INVALID_SCHEDULE' },
    });
  });

  it('supports a disabled horizon', () => {
    expect(() =>
      validateScheduleInput(new Date('2099-01-01T00:00:00.000Z'), undefined, now, null),
    ).not.toThrow();
  });

  it('normalizes valid recurrence rules', () => {
    expect(
      validateScheduleInput(
        new Date(now.getTime() + 1_000),
        { frequency: 'daily', count: 3 },
        now,
        horizonMs,
      ),
    ).toEqual({ frequency: 'daily', interval: 1, count: 3 });
  });

  it.each([
    [{ frequency: 'yearly' }, 'recurrence.frequency must be one of'],
    [{ frequency: 'daily', interval: 0 }, 'recurrence.interval must be a positive integer'],
    [{ frequency: 'daily', interval: 1.5 }, 'recurrence.interval must be a positive integer'],
    [{ frequency: 'daily', count: 0 }, 'recurrence.count must be a positive integer'],
    [{ frequency: 'daily', count: -1 }, 'recurrence.count must be a positive integer'],
    [
      { frequency: 'daily', count: 2, until: '2026-02-01T00:00:00.000Z' },
      'cannot be used together',
    ],
    [{ frequency: 'daily', until: 'not-a-date' }, 'recurrence.until must be a valid ISO-8601 date'],
    [{ frequency: 'daily', until: null }, 'recurrence.until must be a valid ISO-8601 date'],
    [{ frequency: 'daily', until: '2025-12-31T23:59:59.999Z' }, 'must be on or after executeAt'],
  ])('rejects invalid recurrence rule %j', (rule, message) => {
    expect(() =>
      validateScheduleInput(new Date(now.getTime() + 1_000), rule as any, now, horizonMs),
    ).toThrow(message as string);
  });

  it('checks recurrence until against the same horizon', () => {
    const until = new Date(now.getTime() + horizonMs + 1);
    expect(() =>
      validateScheduleInput(
        new Date(now.getTime() + 1_000),
        { frequency: 'weekly', until },
        now,
        horizonMs,
      ),
    ).toThrow(
      `recurrence.until ${until.toISOString()} exceeds the maximum scheduling horizon of ${horizonMs} ms`,
    );
  });

  it('allows recurrence occurrences to extend beyond the horizon when the first run is in range', () => {
    expect(() =>
      validateScheduleInput(
        new Date(now.getTime() + horizonMs),
        { frequency: 'daily', count: 10 },
        now,
        horizonMs,
      ),
    ).not.toThrow();
  });
});
