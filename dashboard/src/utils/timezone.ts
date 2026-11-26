/**
 * Timezone preference helpers (issue #1108).
 *
 * A preference is either the literal `'local'` (the browser's timezone),
 * `'UTC'`, or — for forward compatibility — any IANA zone name. Every value is
 * validated against `Intl` before use; anything unsupported falls back to the
 * browser's local timezone so a bad persisted value can never break rendering.
 */

export type TimezonePreference = 'local' | 'UTC' | (string & {});

export const DEFAULT_TIMEZONE_PREFERENCE: TimezonePreference = 'local';

export const TIMEZONE_OPTIONS: ReadonlyArray<{ value: TimezonePreference; label: string }> = [
  { value: 'local', label: 'Local time' },
  { value: 'UTC', label: 'UTC' },
];

/** Returns whether `Intl` accepts `zone` as a `timeZone` option. */
export function isSupportedTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes untrusted input (e.g. a value read from localStorage) into a
 * valid preference, falling back to `'local'`.
 */
export function normalizeTimezonePreference(value: unknown): TimezonePreference {
  if (value === 'local') return 'local';
  if (typeof value === 'string' && value.trim().toUpperCase() === 'UTC') return 'UTC';
  if (isSupportedTimeZone(value)) return value.trim();
  return DEFAULT_TIMEZONE_PREFERENCE;
}

/**
 * Resolves a preference to the `timeZone` option passed to `Intl`.
 * `undefined` means "use the runtime's local timezone".
 */
export function resolveTimeZone(preference: unknown): string | undefined {
  const normalized = normalizeTimezonePreference(preference);
  return normalized === 'local' ? undefined : normalized;
}

/** Best-effort name of the browser's local timezone, for labels. */
export function getLocalTimeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
  } catch {
    return 'Local';
  }
}
