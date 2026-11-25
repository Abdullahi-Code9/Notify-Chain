import { nextLocalOccurrence, resolveLocalDateTime } from './local-schedule';

describe('daylight-saving schedule policy', () => {
  it('shifts a skipped America/New_York spring-forward time forward by the gap', () => {
    const resolved = resolveLocalDateTime('2026-03-08T02:30:00', 'America/New_York');

    expect(resolved.kind).toBe('skipped');
    expect(resolved.resolvedLocal).toBe('2026-03-08T03:30:00');
    expect(resolved.executeAt.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('keeps the earlier instant when America/New_York repeats a local time', () => {
    const resolved = resolveLocalDateTime('2026-11-01T01:30:00', 'America/New_York');

    expect(resolved.kind).toBe('repeated');
    expect(resolved.resolvedLocal).toBe('2026-11-01T01:30:00');
    expect(resolved.executeAt.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('resolves unique local times on either side of the New York spring transition', () => {
    expect(resolveLocalDateTime('2026-03-08T01:30:00', 'America/New_York').executeAt.toISOString()).toBe(
      '2026-03-08T06:30:00.000Z',
    );
    expect(resolveLocalDateTime('2026-03-08T03:30:00', 'America/New_York').executeAt.toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('shifts a 30-minute Lord Howe spring gap by 30 minutes and keeps the earlier fall-back instant', () => {
    const skipped = resolveLocalDateTime('2026-10-04T02:15:00', 'Australia/Lord_Howe');
    expect(skipped.kind).toBe('skipped');
    expect(skipped.resolvedLocal).toBe('2026-10-04T02:45:00');
    expect(skipped.executeAt.toISOString()).toBe('2026-10-03T15:45:00.000Z');

    const repeated = resolveLocalDateTime('2026-04-05T01:45:00', 'Australia/Lord_Howe');
    expect(repeated.kind).toBe('repeated');
    expect(repeated.resolvedLocal).toBe('2026-04-05T01:45:00');
    expect(repeated.executeAt.toISOString()).toBe('2026-04-04T14:45:00.000Z');
  });

  it('applies the same policy outside the US', () => {
    const skipped = resolveLocalDateTime('2026-03-29T01:30:00', 'Europe/London');
    expect(skipped.kind).toBe('skipped');
    expect(skipped.resolvedLocal).toBe('2026-03-29T02:30:00');
    expect(skipped.executeAt.toISOString()).toBe('2026-03-29T01:30:00.000Z');

    const repeated = resolveLocalDateTime('2026-10-25T01:30:00', 'Europe/London');
    expect(repeated.kind).toBe('repeated');
    expect(repeated.executeAt.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('advances a daily local schedule across the spring gap without staying shifted', () => {
    const transition = nextLocalOccurrence({
      timeZone: 'America/New_York',
      localDateTime: '2026-03-07T02:30:00',
      recurrence: 'daily',
    });
    expect(transition.kind).toBe('skipped');
    expect(transition.resolvedLocal).toBe('2026-03-08T03:30:00');

    const dayAfter = nextLocalOccurrence({
      timeZone: 'America/New_York',
      localDateTime: '2026-03-08T02:30:00',
      recurrence: 'daily',
    });
    expect(dayAfter.kind).toBe('unique');
    expect(dayAfter.requestedLocal).toBe('2026-03-09T02:30:00');
    expect(dayAfter.executeAt.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('rejects an unknown timezone', () => {
    expect(() => resolveLocalDateTime('2026-03-08T02:30:00', 'Not/AZone')).toThrow(/IANA timezone/);
  });
});
