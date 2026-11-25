import { RecurrenceFrequency, RecurrenceRule } from '../types/scheduled-notification';

export const DEFAULT_MAX_SCHEDULING_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

const RECURRENCE_FREQUENCIES: readonly RecurrenceFrequency[] = [
  'minutely',
  'hourly',
  'daily',
  'weekly',
  'monthly',
];

export class ScheduleValidationError extends Error {
  readonly code = 'INVALID_SCHEDULE';
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

export function toScheduleValidationResponse(error: ScheduleValidationError): {
  statusCode: number;
  body: { error: string; code: string };
} {
  return {
    statusCode: error.statusCode,
    body: { error: error.message, code: error.code },
  };
}

/** Validate schedule time and recurrence using an explicitly supplied UTC clock value. */
export function validateScheduleInput(
  executeAt: Date,
  recurrence: RecurrenceRule | undefined,
  now: Date,
  maxHorizonMs: number | null,
): RecurrenceRule | undefined {
  if (!(executeAt instanceof Date) || Number.isNaN(executeAt.getTime())) {
    throw new ScheduleValidationError('executeAt must be a valid date');
  }

  if (executeAt <= now) {
    throw new ScheduleValidationError(
      'executeAt must be a future timestamp — the provided date has already expired',
    );
  }

  const horizonEnd = maxHorizonMs === null ? null : new Date(now.getTime() + maxHorizonMs);
  assertWithinHorizon(executeAt, horizonEnd, maxHorizonMs, 'executeAt');

  if (recurrence === undefined) return undefined;
  if (!recurrence || typeof recurrence !== 'object' || Array.isArray(recurrence)) {
    throw new ScheduleValidationError('recurrence must be an object');
  }

  if (!RECURRENCE_FREQUENCIES.includes(recurrence.frequency)) {
    throw new ScheduleValidationError(
      `recurrence.frequency must be one of: ${RECURRENCE_FREQUENCIES.join(', ')}`,
    );
  }

  const interval = recurrence.interval ?? 1;
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new ScheduleValidationError('recurrence.interval must be a positive integer');
  }

  if (recurrence.count !== undefined && recurrence.until !== undefined) {
    throw new ScheduleValidationError(
      'recurrence.count and recurrence.until cannot be used together',
    );
  }

  if (
    recurrence.count !== undefined &&
    (!Number.isSafeInteger(recurrence.count) || recurrence.count <= 0)
  ) {
    throw new ScheduleValidationError('recurrence.count must be a positive integer');
  }

  let until: Date | undefined;
  if (recurrence.until !== undefined) {
    if (!(recurrence.until instanceof Date) && typeof recurrence.until !== 'string') {
      throw new ScheduleValidationError('recurrence.until must be a valid ISO-8601 date');
    }
    until = recurrence.until instanceof Date ? recurrence.until : new Date(recurrence.until);
    if (Number.isNaN(until.getTime())) {
      throw new ScheduleValidationError('recurrence.until must be a valid ISO-8601 date');
    }
    if (until < executeAt) {
      throw new ScheduleValidationError('recurrence.until must be on or after executeAt');
    }
    assertWithinHorizon(until, horizonEnd, maxHorizonMs, 'recurrence.until');
  }

  return {
    frequency: recurrence.frequency,
    interval,
    ...(until ? { until } : {}),
    ...(recurrence.count !== undefined ? { count: recurrence.count } : {}),
  };
}

function assertWithinHorizon(
  value: Date,
  horizonEnd: Date | null,
  maxHorizonMs: number | null,
  field: string,
): void {
  if (horizonEnd && value > horizonEnd) {
    throw new ScheduleValidationError(
      `${field} ${value.toISOString()} exceeds the maximum scheduling horizon of ${maxHorizonMs} ms (limit: ${horizonEnd.toISOString()})`,
    );
  }
}
