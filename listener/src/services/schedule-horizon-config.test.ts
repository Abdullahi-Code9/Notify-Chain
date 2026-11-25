import { parseMaxSchedulingHorizon } from './schedule-horizon-config';
import { DEFAULT_MAX_SCHEDULING_HORIZON_MS } from './schedule-validator';

describe('parseMaxSchedulingHorizon', () => {
  it('uses a 365-day default when unset', () => {
    expect(parseMaxSchedulingHorizon(undefined)).toBe(DEFAULT_MAX_SCHEDULING_HORIZON_MS);
  });

  it.each([
    ['30d', 30 * 24 * 60 * 60 * 1000],
    ['12h', 12 * 60 * 60 * 1000],
    ['15m', 15 * 60 * 1000],
    ['500ms', 500],
  ])('parses %s', (raw, expected) => {
    expect(parseMaxSchedulingHorizon(raw)).toBe(expected);
  });

  it('treats zero as disabled', () => {
    expect(parseMaxSchedulingHorizon('0')).toBeNull();
  });

  it.each(['', '0d', '-1d', 'forever', '1.5d', '1w', '9007199254740992d'])(
    'rejects invalid duration %j',
    (raw) => {
      expect(() => parseMaxSchedulingHorizon(raw)).toThrow('MAX_SCHEDULING_HORIZON must be');
    },
  );
});
