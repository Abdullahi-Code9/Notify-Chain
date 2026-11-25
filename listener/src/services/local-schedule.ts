/**
 * Daylight-saving policy for timezone-based notification schedules.
 *
 * A local wall-clock time is not always one UTC instant:
 *
 * - **Repeated local time** (fall back). The clock is set back and the same
 *   reading happens twice. NotifyChain schedules the **earlier** instant, the
 *   first time that reading occurs. Example: `America/New_York`
 *   `2026-11-01T01:30:00` runs at `2026-11-01T05:30:00.000Z` (EDT), not an
 *   hour later when the clock shows 01:30 again (EST).
 * - **Skipped local time** (spring forward). The clock jumps ahead and the
 *   reading never happens. NotifyChain moves the wall time forward by the
 *   length of that zone's gap, then schedules that valid instant. A one-hour
 *   gap and a 30-minute gap are not treated the same. Examples:
 *   `America/New_York` `2026-03-08T02:30:00` does not exist; it runs at
 *   `03:30` EDT (`2026-03-08T07:30:00.000Z`). `Australia/Lord_Howe`
 *   `2026-10-04T02:15:00` does not exist; the gap is 30 minutes, so it runs
 *   at `02:45` (`2026-10-03T15:45:00.000Z`). The occurrence is not dropped
 *   and is not placed inside the gap.
 * - **Unique local time.** The reading maps to exactly one UTC instant.
 *
 * Recurrence (`daily` or `weekly`) advances the **requested** local calendar
 * date and applies this same policy. A daily 02:30 that was shifted to 03:30
 * on the transition day is 02:30 again on the following local date.
 */

export type LocalResolutionKind = 'unique' | 'skipped' | 'repeated';
export type ScheduleRecurrence = 'daily' | 'weekly';

export interface LocalScheduleIntent {
  timeZone: string;
  /** Requested wall time, `YYYY-MM-DDTHH:mm:ss`, with no offset. */
  localDateTime: string;
  recurrence?: ScheduleRecurrence;
}

export interface LocalResolution {
  kind: LocalResolutionKind;
  executeAt: Date;
  /** Wall time that will actually occur. */
  resolvedLocal: string;
  /** Wall time that was requested, including a skipped reading. */
  requestedLocal: string;
  timeZone: string;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function resolveLocalDateTime(localDateTime: string, timeZone: string): LocalResolution {
  assertTimeZone(timeZone);
  const parts = parseLocal(localDateTime);
  const requested = formatParts(parts);
  const matches = findMatches(parts, timeZone);

  if (matches.length >= 2) {
    return resolution('repeated', matches[0], requested, requested, timeZone);
  }
  if (matches.length === 1) {
    return resolution('unique', matches[0], requested, requested, timeZone);
  }

  const shifted = addMinutes(parts, transitionGapMinutes(parts, timeZone));
  const shiftedMatches = findMatches(shifted, timeZone);
  if (shiftedMatches.length === 0) {
    throw new Error(`Unable to resolve skipped local time ${requested} in ${timeZone}`);
  }
  return resolution('skipped', shiftedMatches[0], formatParts(shifted), requested, timeZone);
}

/** Next daily or weekly occurrence of a requested local schedule. */
export function nextLocalOccurrence(intent: LocalScheduleIntent): LocalResolution {
  if (intent.recurrence !== 'daily' && intent.recurrence !== 'weekly') {
    throw new Error('recurrence must be daily or weekly');
  }
  assertTimeZone(intent.timeZone);
  const parts = parseLocal(intent.localDateTime);
  const advanced = addDays(parts, intent.recurrence === 'weekly' ? 7 : 1);
  return resolveLocalDateTime(formatParts(advanced), intent.timeZone);
}

export function readLocalSchedule(metadata: string | null | undefined): LocalScheduleIntent | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { localSchedule?: Partial<LocalScheduleIntent> };
    const schedule = parsed.localSchedule;
    if (!schedule?.timeZone || !schedule.localDateTime) return null;
    if (
      schedule.recurrence !== undefined &&
      schedule.recurrence !== 'daily' &&
      schedule.recurrence !== 'weekly'
    ) {
      return null;
    }
    return {
      timeZone: schedule.timeZone,
      localDateTime: schedule.localDateTime,
      recurrence: schedule.recurrence,
    };
  } catch {
    return null;
  }
}

function resolution(
  kind: LocalResolutionKind,
  executeAt: Date,
  resolvedLocal: string,
  requestedLocal: string,
  timeZone: string,
): LocalResolution {
  return { kind, executeAt, resolvedLocal, requestedLocal, timeZone };
}

function assertTimeZone(timeZone: string): void {
  if (!timeZone || typeof timeZone !== 'string') {
    throw new Error('timeZone is required');
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    throw new Error(`timeZone is not a valid IANA timezone: ${timeZone}`);
  }
}

function parseLocal(value: string): LocalParts {
  const match = LOCAL_DATE_TIME.exec(value.trim());
  if (!match) {
    throw new Error('localDateTime must be YYYY-MM-DDTHH:mm:ss without a timezone offset');
  }
  const parts: LocalParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
  };
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    throw new Error('localDateTime is not a real calendar time');
  }
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    probe.getUTCFullYear() !== parts.year ||
    probe.getUTCMonth() !== parts.month - 1 ||
    probe.getUTCDate() !== parts.day
  ) {
    throw new Error('localDateTime is not a real calendar date');
  }
  return parts;
}

function formatParts(parts: LocalParts): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

function formatLocal(instant: Date, timeZone: string): string {
  return formatParts(zonedParts(instant, timeZone));
}

function zonedParts(instant: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const mapped: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') mapped[part.type] = part.value;
  }
  let hour = Number(mapped.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(mapped.year),
    month: Number(mapped.month),
    day: Number(mapped.day),
    hour,
    minute: Number(mapped.minute),
    second: Number(mapped.second),
  };
}

function findMatches(parts: LocalParts, timeZone: string): Date[] {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const requested = formatParts(parts);
  const offsets = new Set<number>();
  // A local reading can sit many hours away from its UTC instant. Sample the
  // whole practical offset range so both sides of a short overlap are seen.
  for (let minutes = -16 * 60; minutes <= 16 * 60; minutes += 30) {
    offsets.add(offsetMinutes(new Date(naive + minutes * 60_000), timeZone));
  }
  const seen = new Set<number>();
  const matches: Date[] = [];
  for (const offset of offsets) {
    const candidate = new Date(naive - offset * 60_000);
    if (seen.has(candidate.getTime())) continue;
    if (formatLocal(candidate, timeZone) === requested) {
      seen.add(candidate.getTime());
      matches.push(candidate);
    }
  }
  matches.sort((left, right) => left.getTime() - right.getTime());
  return matches;
}

function transitionGapMinutes(parts: LocalParts, timeZone: string): number {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  // The transition instant is the UTC time of the wall clock, not the naive
  // reading of that wall clock. Searching only a few hours around the naive
  // UTC timestamp misses zones far from UTC and then assumes a 60-minute gap.
  const start = naive - 20 * 3_600_000;
  let previous = offsetMinutes(new Date(start), timeZone);
  for (let minutes = 15; minutes <= 40 * 60; minutes += 15) {
    const offset = offsetMinutes(new Date(start + minutes * 60_000), timeZone);
    if (offset !== previous) return Math.abs(offset - previous);
  }
  return 60;
}

function addMinutes(parts: LocalParts, minutes: number): LocalParts {
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return partsFromUtc(utc + minutes * 60_000);
}

function addDays(parts: LocalParts, days: number): LocalParts {
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second);
  return partsFromUtc(utc);
}

function partsFromUtc(utc: number): LocalParts {
  const date = new Date(utc);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}
