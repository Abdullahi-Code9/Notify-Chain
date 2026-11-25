/**
 * Timezone helpers for scheduling requests (#967).
 *
 * Accepted timezone formats:
 * - IANA time zone identifiers (e.g. "America/New_York", "Europe/London", "UTC")
 * - "UTC" / "GMT" aliases
 *
 * executeAt is always stored as UTC (ISO-8601 with Z). When a timezone is
 * supplied with a naive local datetime (no offset), that local wall time is
 * interpreted in the given zone and converted to UTC for storage.
 */

const IANA_LIKE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_\-+]+)+$|^UTC$|^GMT$/i;

export class InvalidTimezoneError extends Error {
  readonly code = 'INVALID_TIMEZONE';
  constructor(timezone: string) {
    super(`Invalid timezone identifier: ${timezone}`);
    this.name = 'InvalidTimezoneError';
  }
}

/** Returns true if `timezone` is a valid IANA (or UTC/GMT) identifier. */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string') return false;
  const tz = timezone.trim();
  if (!tz) return false;
  if (/^(UTC|GMT)$/i.test(tz)) return true;
  if (!IANA_LIKE.test(tz) && tz !== 'UTC' && tz !== 'GMT') {
    // Still try Intl for unusual but valid IANA names like "Etc/UTC"
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function assertValidTimezone(timezone: string): string {
  const tz = timezone.trim();
  if (!isValidTimezone(tz)) {
    throw new InvalidTimezoneError(timezone);
  }
  return tz;
}

/**
 * Parse executeAt preserving intended local time when timezone is provided.
 * - Absolute ISO strings with Z/offset: converted to UTC Date (timezone used for display only).
 * - Naive local strings ("2026-10-15T09:00:00"): interpreted in `timezone`, returned as UTC Date.
 */
export function parseExecuteAtWithTimezone(
  executeAt: string | Date,
  timezone?: string | null,
): { utcDate: Date; timezone: string } {
  const tz = timezone ? assertValidTimezone(timezone) : 'UTC';

  if (executeAt instanceof Date) {
    if (isNaN(executeAt.getTime())) {
      throw new Error('executeAt is not a valid date');
    }
    return { utcDate: executeAt, timezone: tz };
  }

  const raw = String(executeAt).trim();
  if (!raw) {
    throw new Error('executeAt is not a valid date');
  }

  // Absolute / offset-aware → Date parser is fine; store UTC.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const utcDate = new Date(raw);
    if (isNaN(utcDate.getTime())) {
      throw new Error('executeAt is not a valid date');
    }
    return { utcDate, timezone: tz };
  }

  // Naive local datetime: interpret in the given timezone.
  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/,
  );
  if (!match) {
    const utcDate = new Date(raw);
    if (isNaN(utcDate.getTime())) {
      throw new Error('executeAt is not a valid date');
    }
    return { utcDate, timezone: tz };
  }

  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match;
  const utcDate = zonedLocalToUtc(
    {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: Number(h),
      minute: Number(mi),
      second: Number(s),
    },
    tz,
  );
  return { utcDate, timezone: tz };
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Convert a wall-clock time in `timeZone` to a UTC Date. */
function zonedLocalToUtc(parts: LocalParts, timeZone: string): Date {
  // Guess UTC instant, then correct by the zone offset at that instant.
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offsetMs = getTimeZoneOffsetMs(guess, timeZone);
  const utc = guess - offsetMs;
  // Re-check offset in case of DST boundary.
  const offset2 = getTimeZoneOffsetMs(utc, timeZone);
  return new Date(guess - offset2);
}

function getTimeZoneOffsetMs(utcMillis: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(new Date(utcMillis));
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - utcMillis;
}

/** Format a UTC Date as local wall time in the given timezone (for display). */
export function formatInTimezone(utcDate: Date, timezone: string): string {
  const tz = assertValidTimezone(timezone);
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(utcDate);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;
}
