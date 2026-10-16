import {
  formatRelativeTimestamp,
  formatTimestamp,
  formatTimestampShort,
  parseToDate,
  RELATIVE_TIMESTAMP_THRESHOLD_MS,
} from './formatTime';

// 2024-01-15 14:30:45 UTC
const FIXED_TIMESTAMP_MS = 1705329045000;
const FIXED_TIMESTAMP_SEC = 1705329045;

describe('parseToDate helper', () => {
  it('parses valid Date objects correctly', () => {
    const d = new Date();
    expect(parseToDate(d)).toBe(d);
  });

  it('handles invalid Date objects by returning null', () => {
    expect(parseToDate(new Date('invalid-date'))).toBeNull();
  });

  it('parses Unix millisecond numbers correctly', () => {
    const d = parseToDate(FIXED_TIMESTAMP_MS);
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(FIXED_TIMESTAMP_MS);
  });

  it('parses Unix second numbers correctly by auto-converting to milliseconds', () => {
    const d = parseToDate(FIXED_TIMESTAMP_SEC);
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(FIXED_TIMESTAMP_MS);
  });

  it('parses valid ISO string dates correctly', () => {
    const d = parseToDate('2024-01-15T14:30:45.000Z');
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(FIXED_TIMESTAMP_MS);
  });

  it('parses numeric string dates in seconds correctly', () => {
    const d = parseToDate('1705329045');
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(FIXED_TIMESTAMP_MS);
  });

  it('parses numeric string dates in milliseconds correctly', () => {
    const d = parseToDate('1705329045000');
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(FIXED_TIMESTAMP_MS);
  });

  it('returns null for invalid strings', () => {
    expect(parseToDate('not-a-date')).toBeNull();
    expect(parseToDate('   ')).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(parseToDate(null)).toBeNull();
    expect(parseToDate(undefined)).toBeNull();
  });

  it('returns null for NaN and infinity', () => {
    expect(parseToDate(NaN)).toBeNull();
    expect(parseToDate(Infinity)).toBeNull();
  });
});

describe('formatTimestamp', () => {
  it('returns a non-empty string for a valid timestamp', () => {
    expect(typeof formatTimestamp(FIXED_TIMESTAMP_MS)).toBe('string');
    expect(formatTimestamp(FIXED_TIMESTAMP_MS).length).toBeGreaterThan(0);
  });

  it('includes a timezone abbreviation in the output', () => {
    const result = formatTimestamp(FIXED_TIMESTAMP_MS);
    // Intl.DateTimeFormat with timeZoneName:'short' always appends a timezone token
    // (e.g. "UTC", "EST", "GMT+5") — check a broad pattern
    expect(result).toMatch(/[A-Z]{2,5}[+-]?\d*|UTC|GMT/);
  });

  it('includes the year in the output', () => {
    expect(formatTimestamp(FIXED_TIMESTAMP_MS)).toContain('2024');
  });

  it('produces different output for different timestamps', () => {
    const earlier = formatTimestamp(FIXED_TIMESTAMP_MS - 60000);
    const later = formatTimestamp(FIXED_TIMESTAMP_MS);
    expect(earlier).not.toBe(later);
  });

  it('handles the Unix epoch without throwing', () => {
    expect(() => formatTimestamp(0)).not.toThrow();
    expect(formatTimestamp(0)).not.toBe('Unknown time');
  });

  it('handles large future timestamps and old past timestamps without throwing', () => {
    const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
    expect(() => formatTimestamp(farFuture)).not.toThrow();
    expect(formatTimestamp(farFuture)).not.toBe('Unknown time');

    const farPast = -100 * 365 * 24 * 60 * 60 * 1000; // ~100 years ago
    expect(() => formatTimestamp(farPast)).not.toThrow();
    expect(formatTimestamp(farPast)).not.toBe('Unknown time');
  });

  it('returns fallback string "Unknown time" on invalid/null/undefined inputs', () => {
    expect(formatTimestamp(null)).toBe('Unknown time');
    expect(formatTimestamp(undefined)).toBe('Unknown time');
    expect(formatTimestamp('malformed string')).toBe('Unknown time');
    expect(formatTimestamp(NaN)).toBe('Unknown time');
  });
});

describe('formatTimestampShort', () => {
  it('returns a non-empty string for a valid timestamp', () => {
    expect(typeof formatTimestampShort(FIXED_TIMESTAMP_MS)).toBe('string');
    expect(formatTimestampShort(FIXED_TIMESTAMP_MS).length).toBeGreaterThan(0);
  });

  it('includes a timezone abbreviation in the output', () => {
    const result = formatTimestampShort(FIXED_TIMESTAMP_MS);
    expect(result).toMatch(/[A-Z]{2,5}[+-]?\d*|UTC|GMT/);
  });

  it('is shorter than or equal to the full timestamp for the same input', () => {
    const full = formatTimestamp(FIXED_TIMESTAMP_MS);
    const short = formatTimestampShort(FIXED_TIMESTAMP_MS);
    expect(short.length).toBeLessThanOrEqual(full.length);
  });

  it('produces different output for different timestamps', () => {
    const earlier = formatTimestampShort(FIXED_TIMESTAMP_MS - 3600000);
    const later = formatTimestampShort(FIXED_TIMESTAMP_MS);
    expect(earlier).not.toBe(later);
  });

  it('handles the Unix epoch without throwing', () => {
    expect(() => formatTimestampShort(0)).not.toThrow();
    expect(formatTimestampShort(0)).not.toBe('Unknown time');
  });

  it('returns fallback string "Unknown time" on invalid/null/undefined inputs', () => {
    expect(formatTimestampShort(null)).toBe('Unknown time');
    expect(formatTimestampShort(undefined)).toBe('Unknown time');
    expect(formatTimestampShort('invalid date string')).toBe('Unknown time');
  });
});

describe('formatRelativeTimestamp', () => {
  const now = FIXED_TIMESTAMP_MS;

  it('formats recent past timestamps with relative values', () => {
    expect(formatRelativeTimestamp(now - 2 * 60 * 1000, now)).toBe('2 minutes ago');
  });

  it('formats recent future timestamps correctly', () => {
    expect(formatRelativeTimestamp(now + 2 * 60 * 1000, now)).toBe('in 2 minutes');
  });

  it('uses the exact timestamp at the relative threshold', () => {
    expect(formatRelativeTimestamp(now - RELATIVE_TIMESTAMP_THRESHOLD_MS, now)).toContain('2024');
  });

  it('uses "just now" for timestamps less than one second old', () => {
    expect(formatRelativeTimestamp(now - 500, now)).toBe('just now');
  });

  it('returns the fallback for invalid timestamps', () => {
    expect(formatRelativeTimestamp('invalid date string', now)).toBe('Unknown time');
  });
});
