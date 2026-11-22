import {
  isSupportedTimeZone,
  normalizeTimezonePreference,
  resolveTimeZone,
} from './timezone';
import { formatTimestamp, formatUtcTimestamp, toUtcIsoString } from './formatTime';
import { TIMEZONE_STORAGE_KEY, useTimezoneStore } from '../store/timezoneStore';

// 2024-01-15 14:30:45 UTC
const FIXED_TIMESTAMP_MS = 1705329045000;

describe('timezone preference helpers (#1108)', () => {
  it('accepts local and UTC', () => {
    expect(normalizeTimezonePreference('local')).toBe('local');
    expect(normalizeTimezonePreference('UTC')).toBe('UTC');
    expect(normalizeTimezonePreference('utc')).toBe('UTC');
  });

  it('falls back to local for invalid or unsupported values', () => {
    expect(normalizeTimezonePreference('Not/AZone')).toBe('local');
    expect(normalizeTimezonePreference('')).toBe('local');
    expect(normalizeTimezonePreference(null)).toBe('local');
    expect(normalizeTimezonePreference(42)).toBe('local');
  });

  it('resolves local to undefined and UTC to an Intl zone', () => {
    expect(resolveTimeZone('local')).toBeUndefined();
    expect(resolveTimeZone('UTC')).toBe('UTC');
    expect(resolveTimeZone('garbage')).toBeUndefined();
  });

  it('detects supported zones', () => {
    expect(isSupportedTimeZone('UTC')).toBe(true);
    expect(isSupportedTimeZone('Invalid/Zone')).toBe(false);
  });
});

describe('timezone-aware formatting (#1108)', () => {
  it('formats in UTC when requested', () => {
    const out = formatTimestamp(FIXED_TIMESTAMP_MS, 'UTC');
    expect(out).toContain('2024');
    expect(out).toMatch(/02:30:45|14:30:45/);
    expect(out).toMatch(/UTC/);
  });

  it('falls back to local time instead of throwing for an invalid zone', () => {
    expect(() => formatTimestamp(FIXED_TIMESTAMP_MS, 'Invalid/Zone')).not.toThrow();
    expect(formatTimestamp(FIXED_TIMESTAMP_MS, 'Invalid/Zone')).toBe(
      formatTimestamp(FIXED_TIMESTAMP_MS, undefined),
    );
  });

  it('keeps the raw UTC timestamp available regardless of preference', () => {
    expect(toUtcIsoString(FIXED_TIMESTAMP_MS)).toBe('2024-01-15T14:30:45.000Z');
    expect(formatUtcTimestamp(FIXED_TIMESTAMP_MS)).toBe('2024-01-15T14:30:45.000Z');
    expect(toUtcIsoString('not a date')).toBeUndefined();
    expect(formatUtcTimestamp('not a date')).toBe('Unknown time');
  });
});

describe('timezone store (#1108)', () => {
  afterEach(() => {
    useTimezoneStore.getState().setPreference('local');
    localStorage.clear();
  });

  it('persists the selected preference', () => {
    useTimezoneStore.getState().setPreference('UTC');
    expect(useTimezoneStore.getState().preference).toBe('UTC');
    expect(useTimezoneStore.getState().timeZone).toBe('UTC');
    expect(localStorage.getItem(TIMEZONE_STORAGE_KEY)).toBe('UTC');
  });

  it('normalizes invalid input to local', () => {
    useTimezoneStore.getState().setPreference('Mars/Olympus_Mons');
    expect(useTimezoneStore.getState().preference).toBe('local');
    expect(useTimezoneStore.getState().timeZone).toBeUndefined();
  });

  it('applies the preference as the default for formatTimestamp', () => {
    useTimezoneStore.getState().setPreference('UTC');
    expect(formatTimestamp(FIXED_TIMESTAMP_MS)).toBe(formatTimestamp(FIXED_TIMESTAMP_MS, 'UTC'));
  });
});
