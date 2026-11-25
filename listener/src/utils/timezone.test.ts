import {
  assertValidTimezone,
  formatInTimezone,
  InvalidTimezoneError,
  isValidTimezone,
  parseExecuteAtWithTimezone,
} from './timezone';

describe('timezone helpers (#967)', () => {
  it('accepts IANA identifiers and UTC/GMT', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('GMT')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
  });

  it('rejects invalid timezone identifiers', () => {
    expect(isValidTimezone('Not/A_Zone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(() => assertValidTimezone('Foo/Bar')).toThrow(InvalidTimezoneError);
  });

  it('stores naive local time as UTC while preserving intended wall clock', () => {
    // 2026-01-15 12:00 in America/New_York (EST, UTC-5) → 17:00 UTC
    const { utcDate, timezone } = parseExecuteAtWithTimezone(
      '2026-01-15T12:00:00',
      'America/New_York',
    );
    expect(timezone).toBe('America/New_York');
    expect(utcDate.toISOString()).toBe('2026-01-15T17:00:00.000Z');
    expect(formatInTimezone(utcDate, 'America/New_York')).toBe('2026-01-15T12:00:00');
  });

  it('keeps offset-aware timestamps as UTC', () => {
    const { utcDate } = parseExecuteAtWithTimezone(
      '2026-06-01T15:30:00Z',
      'Europe/London',
    );
    expect(utcDate.toISOString()).toBe('2026-06-01T15:30:00.000Z');
  });
});
