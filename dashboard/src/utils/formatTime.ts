/**
 * Centralized timestamp formatting utilities.
 *
 * All functions accept raw/unknown timestamp values and return a locale-aware
 * string in the browser's local timezone. The timezone abbreviation is always
 * included so users can see which timezone is being displayed, preventing
 * ambiguity across different locales and regions.
 */

const FULL_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
};

const SHORT_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
};

const FALLBACK_STRING = 'Unknown time';
export const RELATIVE_TIMESTAMP_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Parses any raw input (number, string, Date, null, undefined) defensively into a Date object.
 * Handles seconds vs. milliseconds Unix timestamps automatically.
 */
export function parseToDate(input: unknown): Date | null {
  if (input === null || input === undefined) {
    return null;
  }

  if (input instanceof Date) {
    return isNaN(input.getTime()) ? null : input;
  }

  if (typeof input === 'number') {
    if (isNaN(input) || !isFinite(input)) {
      return null;
    }
    // Any timestamp below 10 billion (10,000,000,000) is treated as seconds.
    if (input < 10000000000) {
      return new Date(input * 1000);
    }
    return new Date(input);
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }
    // Check if it's a numeric string
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (num < 10000000000) {
        return new Date(num * 1000);
      }
      return new Date(num);
    }
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/**
 * Formats any raw/unknown timestamp as a full date + time string with timezone abbreviation.
 * Example: "Jan 15, 2024, 02:30:45 PM EST"
 * Gracefully returns "Unknown time" if the input is malformed, null, or undefined.
 */
export function formatTimestamp(timestamp: unknown): string {
  const d = parseToDate(timestamp);
  if (!d) {
    return FALLBACK_STRING;
  }
  return new Intl.DateTimeFormat(undefined, FULL_OPTIONS).format(d);
}

/**
 * Formats any raw/unknown timestamp as a short time-only string with timezone abbreviation.
 * Example: "02:30:45 PM EST"
 * Gracefully returns "Unknown time" if the input is malformed, null, or undefined.
 */
export function formatTimestampShort(timestamp: unknown): string {
  const d = parseToDate(timestamp);
  if (!d) {
    return FALLBACK_STRING;
  }
  return new Intl.DateTimeFormat(undefined, SHORT_OPTIONS).format(d);
}

/**
 * Formats timestamps within the last or next 24 hours relative to `now`.
 * Older or more distant timestamps use the full, exact timestamp instead.
 */
export function formatRelativeTimestamp(timestamp: unknown, now = Date.now()): string {
  const date = parseToDate(timestamp);
  if (!date) {
    return FALLBACK_STRING;
  }

  const differenceMs = date.getTime() - now;
  if (Math.abs(differenceMs) >= RELATIVE_TIMESTAMP_THRESHOLD_MS) {
    return formatTimestamp(date);
  }

  const differenceSeconds = Math.floor(Math.abs(differenceMs) / 1000);
  if (differenceSeconds === 0) {
    return 'just now';
  }
  const unit =
    differenceSeconds < 60
      ? { value: differenceSeconds, label: 'second' }
      : differenceSeconds < 3600
        ? { value: Math.floor(differenceSeconds / 60), label: 'minute' }
        : { value: Math.floor(differenceSeconds / 3600), label: 'hour' };
  const value = `${unit.value} ${unit.label}${unit.value === 1 ? '' : 's'}`;

  if (differenceMs > 0) {
    return `in ${value}`;
  }
  return `${value} ago`;
}
