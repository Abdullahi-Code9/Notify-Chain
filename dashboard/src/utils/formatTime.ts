/**
 * Centralized timestamp formatting utilities.
 *
 * All functions accept raw/unknown timestamp values and return a locale-aware
 * string in the dashboard's preferred timezone (local time by default, or UTC —
 * see `store/timezoneStore.ts`). The timezone abbreviation is always included
 * so users can see which timezone is being displayed, preventing ambiguity
 * across different locales and regions.
 */

import { getActiveTimeZone } from '../store/timezoneStore';

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

/** Locale used when the requested locale is missing or unsupported. */
export const DEFAULT_LOCALE = 'en-US';

/**
 * Returns `locale` if it is a valid, supported BCP-47 tag, otherwise
 * `DEFAULT_LOCALE`. Never throws, so unsupported settings fall back safely.
 */
export function resolveLocale(locale: string | undefined | null): string {
  if (!locale || typeof locale !== 'string') {
    return DEFAULT_LOCALE;
  }
  const trimmed = locale.trim();
  if (!trimmed) {
    return DEFAULT_LOCALE;
  }
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([trimmed]).length > 0
      ? trimmed
      : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

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
 * Formats `date` with `options` in `timeZone`. An unsupported zone falls back
 * to the browser's local timezone instead of throwing a RangeError (#1108).
 * An unsupported `locale` falls back to `DEFAULT_LOCALE`.
 */
function formatInZone(
  date: Date,
  options: Intl.DateTimeFormatOptions,
  timeZone: string | undefined,
  locale?: string,
): string {
  const resolvedLocale = resolveLocale(locale);
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat(resolvedLocale, { ...options, timeZone }).format(date);
    } catch {
      // fall through to local time
    }
  }
  try {
    return new Intl.DateTimeFormat(resolvedLocale, options).format(date);
  } catch {
    return new Intl.DateTimeFormat(DEFAULT_LOCALE, options).format(date);
  }
}

/**
 * Locale-aware date/time formatter. Accepts a locale and custom
 * `Intl.DateTimeFormatOptions`; unsupported locales fall back to `en-US`.
 * Returns "Unknown time" for unparseable input.
 */
export function formatDateTime(
  timestamp: unknown,
  locale?: string,
  options: Intl.DateTimeFormatOptions = FULL_OPTIONS,
  timeZone: string | undefined = getActiveTimeZone(),
): string {
  const d = parseToDate(timestamp);
  if (!d) {
    return FALLBACK_STRING;
  }
  return formatInZone(d, options, timeZone, locale);
}

/**
 * Locale-aware date-only formatter (no time component).
 */
export function formatDate(
  timestamp: unknown,
  locale?: string,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: '2-digit' },
  timeZone: string | undefined = getActiveTimeZone(),
): string {
  return formatDateTime(timestamp, locale, options, timeZone);
}

/**
 * Locale-aware time-only formatter (no date component).
 */
export function formatTime(
  timestamp: unknown,
  locale?: string,
  options: Intl.DateTimeFormatOptions = SHORT_OPTIONS,
  timeZone: string | undefined = getActiveTimeZone(),
): string {
  return formatDateTime(timestamp, locale, options, timeZone);
}

/**
 * Dedicated UTC formatter: always renders in UTC regardless of the dashboard
 * timezone preference, so UTC timestamps remain available to users.
 */
export function formatUtcDateTime(
  timestamp: unknown,
  locale?: string,
  options: Intl.DateTimeFormatOptions = FULL_OPTIONS,
): string {
  return formatDateTime(timestamp, locale, options, 'UTC');
}

/**
 * Formats any raw/unknown timestamp as a full date + time string with timezone abbreviation.
 * Example: "Jan 15, 2024, 02:30:45 PM EST"
 * Gracefully returns "Unknown time" if the input is malformed, null, or undefined.
 *
 * `timeZone` defaults to the dashboard's timezone preference (local or UTC).
 */
export function formatTimestamp(
  timestamp: unknown,
  timeZone: string | undefined = getActiveTimeZone(),
  locale?: string,
): string {
  const d = parseToDate(timestamp);
  if (!d) {
    return FALLBACK_STRING;
  }
  return formatInZone(d, FULL_OPTIONS, timeZone, locale);
}

/**
 * Formats any raw/unknown timestamp as a short time-only string with timezone abbreviation.
 * Example: "02:30:45 PM EST"
 * Gracefully returns "Unknown time" if the input is malformed, null, or undefined.
 */
export function formatTimestampShort(
  timestamp: unknown,
  timeZone: string | undefined = getActiveTimeZone(),
  locale?: string,
): string {
  const d = parseToDate(timestamp);
  if (!d) {
    return FALLBACK_STRING;
  }
  return formatInZone(d, SHORT_OPTIONS, timeZone, locale);
}

/**
 * Returns the canonical UTC ISO-8601 representation of a timestamp, or
 * `undefined` when it cannot be parsed. Used for `<time dateTime>` attributes
 * and raw event metadata, which must stay in UTC regardless of preference.
 */
export function toUtcIsoString(timestamp: unknown): string | undefined {
  const d = parseToDate(timestamp);
  return d ? d.toISOString() : undefined;
}

/** Human-visible raw UTC timestamp; "Unknown time" when unparseable. */
export function formatUtcTimestamp(timestamp: unknown): string {
  return toUtcIsoString(timestamp) ?? FALLBACK_STRING;
}

/**
 * Formats timestamps within the last or next 24 hours relative to `now`.
 * Older or more distant timestamps use the full, exact timestamp instead.
 */
export function formatRelativeTimestamp(
  timestamp: unknown,
  now = Date.now(),
  timeZone: string | undefined = getActiveTimeZone(),
  locale?: string,
): string {
  const date = parseToDate(timestamp);
  if (!date) {
    return FALLBACK_STRING;
  }

  const differenceMs = date.getTime() - now;
  if (Math.abs(differenceMs) >= RELATIVE_TIMESTAMP_THRESHOLD_MS) {
    return formatTimestamp(date, timeZone, locale);
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
