import { RecurrenceRule } from '../types/scheduled-notification';

export interface NextRunCalculation {
  nextRun: Date | null;
  occurrenceCount: number;
}

/** Return the next UTC occurrence, or null when an end condition is exhausted. */
export function computeNextRun(
  rule: RecurrenceRule,
  lastRunOrStart: Date,
  now?: Date,
  occurrencesSoFar = 1,
): Date | null {
  return calculateNextRun(rule, lastRunOrStart, now, occurrencesSoFar).nextRun;
}

/** Also returns consumed/skipped occurrences so persistence can keep count semantics exact. */
export function calculateNextRun(
  rule: RecurrenceRule,
  lastRunOrStart: Date,
  now?: Date,
  occurrencesSoFar = 1,
): NextRunCalculation {
  const interval = rule.interval ?? 1;
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new RangeError('recurrence interval must be a positive integer');
  }
  if (Number.isNaN(lastRunOrStart.getTime()) || (now && Number.isNaN(now.getTime()))) {
    throw new RangeError('recurrence dates must be valid');
  }
  if (!Number.isSafeInteger(occurrencesSoFar) || occurrencesSoFar < 1) {
    throw new RangeError('occurrencesSoFar must be a positive integer');
  }

  const until = rule.until === undefined ? undefined : new Date(rule.until);
  if (until && Number.isNaN(until.getTime()))
    throw new RangeError('recurrence until must be valid');

  let candidate = addPeriods(lastRunOrStart, rule.frequency, interval, 1);
  if (Number.isNaN(candidate.getTime()))
    return { nextRun: null, occurrenceCount: occurrencesSoFar };
  let consumedCount = occurrencesSoFar;

  if (now && candidate <= now) {
    const periodsToSkip = periodsToMovePast(candidate, now, rule.frequency, interval);
    consumedCount += periodsToSkip;
    candidate = addPeriods(candidate, rule.frequency, interval, periodsToSkip);
  }

  if (rule.count !== undefined && candidateSequence(consumedCount) > rule.count) {
    return { nextRun: null, occurrenceCount: Math.min(consumedCount, rule.count) };
  }

  if (until && candidate > until) {
    const endSequence = sequenceAtOrBefore(
      addPeriods(lastRunOrStart, rule.frequency, interval, 1),
      until,
      rule.frequency,
      interval,
      occurrencesSoFar + 1,
    );
    const finalCount = rule.count === undefined ? endSequence : Math.min(endSequence, rule.count);
    return { nextRun: null, occurrenceCount: Math.max(occurrencesSoFar, finalCount) };
  }

  return { nextRun: candidate, occurrenceCount: consumedCount };
}

function candidateSequence(consumedCount: number): number {
  return consumedCount + 1;
}

function addPeriods(
  date: Date,
  frequency: RecurrenceRule['frequency'],
  interval: number,
  periods: number,
): Date {
  const result = new Date(date);
  const steps = interval * periods;
  if (!Number.isSafeInteger(steps)) return new Date(Number.NaN);

  if (frequency === 'monthly') {
    const monthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() + steps;
    const year = Math.floor(monthIndex / 12);
    const month = monthIndex - year * 12;
    const day = Math.min(date.getUTCDate(), daysInUtcMonth(year, month));
    result.setUTCFullYear(year, month, day);
    return result;
  }

  const unitMs: Record<Exclude<RecurrenceRule['frequency'], 'monthly'>, number> = {
    minutely: 60_000,
    hourly: 60 * 60_000,
    daily: 24 * 60 * 60_000,
    weekly: 7 * 24 * 60 * 60_000,
  };
  return new Date(date.getTime() + steps * unitMs[frequency]);
}

function periodsToMovePast(
  candidate: Date,
  now: Date,
  frequency: RecurrenceRule['frequency'],
  interval: number,
): number {
  if (frequency !== 'monthly') {
    const unitMs: Record<Exclude<RecurrenceRule['frequency'], 'monthly'>, number> = {
      minutely: 60_000,
      hourly: 60 * 60_000,
      daily: 24 * 60 * 60_000,
      weekly: 7 * 24 * 60 * 60_000,
    };
    return Math.floor((now.getTime() - candidate.getTime()) / (unitMs[frequency] * interval)) + 1;
  }

  const monthDifference =
    (now.getUTCFullYear() - candidate.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    candidate.getUTCMonth();
  let periods = Math.max(1, Math.floor(monthDifference / interval));
  while (addPeriods(candidate, frequency, interval, periods) <= now) periods += 1;
  while (periods > 1 && addPeriods(candidate, frequency, interval, periods - 1) > now) periods -= 1;
  return periods;
}

function sequenceAtOrBefore(
  first: Date,
  end: Date,
  frequency: RecurrenceRule['frequency'],
  interval: number,
  firstSequence: number,
): number {
  if (first > end) return firstSequence - 1;

  let periods = 0;
  if (frequency === 'monthly') {
    const monthDifference =
      (end.getUTCFullYear() - first.getUTCFullYear()) * 12 +
      end.getUTCMonth() -
      first.getUTCMonth();
    periods = Math.floor(monthDifference / interval);
    while (periods > 0 && addPeriods(first, frequency, interval, periods) > end) periods -= 1;
    while (addPeriods(first, frequency, interval, periods + 1) <= end) periods += 1;
  } else {
    const unitMs: Record<Exclude<RecurrenceRule['frequency'], 'monthly'>, number> = {
      minutely: 60_000,
      hourly: 60 * 60_000,
      daily: 24 * 60 * 60_000,
      weekly: 7 * 24 * 60 * 60_000,
    };
    periods = Math.floor((end.getTime() - first.getTime()) / (unitMs[frequency] * interval));
  }
  return firstSequence + periods;
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
