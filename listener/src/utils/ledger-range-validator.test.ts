/**
 * Unit tests for ledger-range-validator.ts
 *
 * Acceptance criteria:
 *  - Invalid ranges are rejected (non-integers, negatives, NaN, strings, null)
 *  - Start and end positions are individually validated
 *  - Inverted ranges (start > end) are rejected
 *  - Large requests are capped at MAX_LEDGER_RANGE and handled safely
 *  - Edge-case values (ledger 1, MAX_LEDGER_VALUE, exact-max-width range) pass
 */

import {
  validateLedgerRange,
  safeLedgerRangeValidation,
  parseLedgerRangeParams,
  MAX_LEDGER_RANGE,
  MIN_LEDGER,
  MAX_LEDGER_VALUE,
} from './ledger-range-validator';
import { ValidationError } from './validation';

// ── validateLedgerRange ───────────────────────────────────────────────────────

describe('validateLedgerRange', () => {
  // ── Happy-path ─────────────────────────────────────────────────────────────

  describe('valid ranges', () => {
    it('accepts the minimum valid range (single ledger)', () => {
      expect(validateLedgerRange(1, 1)).toEqual({ startLedger: 1, endLedger: 1 });
    });

    it('accepts a typical range well within the limit', () => {
      expect(validateLedgerRange(100, 200)).toEqual({ startLedger: 100, endLedger: 200 });
    });

    it('accepts the exact maximum range width', () => {
      const start = 5_000;
      const end = start + MAX_LEDGER_RANGE - 1; // width == MAX_LEDGER_RANGE
      expect(validateLedgerRange(start, end)).toEqual({ startLedger: start, endLedger: end });
    });

    it('accepts MAX_LEDGER_VALUE as end with a large start', () => {
      const start = MAX_LEDGER_VALUE - MAX_LEDGER_RANGE + 1;
      expect(validateLedgerRange(start, MAX_LEDGER_VALUE)).toEqual({
        startLedger: start,
        endLedger: MAX_LEDGER_VALUE,
      });
    });

    it('accepts a custom maxRange override', () => {
      // Range of 3 would fail with default 10 000 limit but pass with 3.
      expect(validateLedgerRange(1, 3, 3)).toEqual({ startLedger: 1, endLedger: 3 });
    });
  });

  // ── Invalid startLedger ────────────────────────────────────────────────────

  describe('invalid startLedger', () => {
    it('rejects a float', () => {
      expect(() => validateLedgerRange(1.5, 10)).toThrow(ValidationError);
    });

    it('rejects a string', () => {
      expect(() => validateLedgerRange('1' as any, 10)).toThrow(ValidationError);
    });

    it('rejects null', () => {
      expect(() => validateLedgerRange(null as any, 10)).toThrow(ValidationError);
    });

    it('rejects undefined', () => {
      expect(() => validateLedgerRange(undefined as any, 10)).toThrow(ValidationError);
    });

    it('rejects NaN', () => {
      expect(() => validateLedgerRange(NaN, 10)).toThrow(ValidationError);
    });

    it('rejects Infinity', () => {
      expect(() => validateLedgerRange(Infinity, 10)).toThrow(ValidationError);
    });

    it('rejects zero (below MIN_LEDGER)', () => {
      const err = getValidationError(() => validateLedgerRange(0, 10));
      expect(err.issues.some((i) => i.field === 'startLedger')).toBe(true);
    });

    it('rejects a negative value', () => {
      const err = getValidationError(() => validateLedgerRange(-1, 10));
      expect(err.issues.some((i) => i.field === 'startLedger')).toBe(true);
    });

    it('rejects a value exceeding MAX_LEDGER_VALUE', () => {
      const err = getValidationError(() => validateLedgerRange(MAX_LEDGER_VALUE + 1, MAX_LEDGER_VALUE + 2));
      expect(err.issues.some((i) => i.field === 'startLedger')).toBe(true);
    });
  });

  // ── Invalid endLedger ──────────────────────────────────────────────────────

  describe('invalid endLedger', () => {
    it('rejects a float', () => {
      expect(() => validateLedgerRange(1, 10.9)).toThrow(ValidationError);
    });

    it('rejects a string', () => {
      expect(() => validateLedgerRange(1, '10' as any)).toThrow(ValidationError);
    });

    it('rejects null', () => {
      expect(() => validateLedgerRange(1, null as any)).toThrow(ValidationError);
    });

    it('rejects zero (below MIN_LEDGER)', () => {
      const err = getValidationError(() => validateLedgerRange(1, 0));
      expect(err.issues.some((i) => i.field === 'endLedger')).toBe(true);
    });

    it('rejects a value exceeding MAX_LEDGER_VALUE', () => {
      const err = getValidationError(() => validateLedgerRange(1, MAX_LEDGER_VALUE + 1));
      expect(err.issues.some((i) => i.field === 'endLedger')).toBe(true);
    });
  });

  // ── Inverted / equal range ─────────────────────────────────────────────────

  describe('range relationship', () => {
    it('rejects startLedger > endLedger', () => {
      const err = getValidationError(() => validateLedgerRange(100, 50));
      expect(err.issues.some((i) => i.field === 'startLedger' && i.message.includes('<= endLedger'))).toBe(true);
    });

    it('rejects startLedger === endLedger + 1 (off-by-one)', () => {
      expect(() => validateLedgerRange(51, 50)).toThrow(ValidationError);
    });
  });

  // ── Range-too-large (large request safety) ─────────────────────────────────

  describe('range size limit', () => {
    it('rejects a range one wider than MAX_LEDGER_RANGE', () => {
      const start = 1;
      const end = MAX_LEDGER_RANGE + 1; // width = MAX_LEDGER_RANGE + 1
      const err = getValidationError(() => validateLedgerRange(start, end));
      expect(err.issues.some((i) => i.field === 'endLedger' && i.message.includes('range too large'))).toBe(true);
    });

    it('includes the requested and maximum widths in the rejection message', () => {
      const rangeWidth = MAX_LEDGER_RANGE + 500;
      const err = getValidationError(() => validateLedgerRange(1, rangeWidth));
      const rangeIssue = err.issues.find((i) => i.field === 'endLedger');
      expect(rangeIssue?.message).toContain(String(rangeWidth));
      expect(rangeIssue?.message).toContain(String(MAX_LEDGER_RANGE));
    });

    it('rejects an extremely large range safely (no overflow)', () => {
      // Choosing values that would overflow a signed 32-bit integer if the
      // arithmetic used signed integers naively.
      expect(() => validateLedgerRange(1, MAX_LEDGER_VALUE)).toThrow(ValidationError);
    });

    it('respects a custom maxRange lower than the default', () => {
      expect(() => validateLedgerRange(1, 100, 50)).toThrow(ValidationError);
    });
  });

  // ── Error shape ────────────────────────────────────────────────────────────

  describe('ValidationError shape', () => {
    it('carries field-level issues for every failing field', () => {
      // Both values are invalid — expect issues for both fields.
      const err = getValidationError(() => validateLedgerRange(-1, -2));
      const fields = err.issues.map((i) => i.field);
      expect(fields).toContain('startLedger');
      expect(fields).toContain('endLedger');
    });

    it('is an instance of ValidationError', () => {
      try {
        validateLedgerRange(0, 0);
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
      }
    });
  });
});

// ── safeLedgerRangeValidation ─────────────────────────────────────────────────

describe('safeLedgerRangeValidation', () => {
  it('returns { valid: true } for a well-formed range', () => {
    expect(safeLedgerRangeValidation(1, 100)).toEqual({ valid: true });
  });

  it('returns { valid: false } with reason and issues for an invalid range', () => {
    const result = safeLedgerRangeValidation(0, 100);
    expect(result.valid).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.issues!.length).toBeGreaterThan(0);
  });

  it('returns { valid: false } for an inverted range', () => {
    const result = safeLedgerRangeValidation(500, 100);
    expect(result.valid).toBe(false);
    expect(result.issues?.some((i) => i.field === 'startLedger')).toBe(true);
  });

  it('returns { valid: false } for an oversized range', () => {
    const result = safeLedgerRangeValidation(1, MAX_LEDGER_RANGE + 1);
    expect(result.valid).toBe(false);
  });

  it('does not throw even when the input is wildly invalid', () => {
    expect(() => safeLedgerRangeValidation('foo' as any, null as any)).not.toThrow();
    expect(safeLedgerRangeValidation('foo' as any, null as any).valid).toBe(false);
  });
});

// ── parseLedgerRangeParams ────────────────────────────────────────────────────

describe('parseLedgerRangeParams', () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  it('parses valid integer strings', () => {
    expect(parseLedgerRangeParams('100', '200')).toEqual({ startLedger: 100, endLedger: 200 });
  });

  it('parses ledger 1 as fromLedger', () => {
    expect(parseLedgerRangeParams('1', '1')).toEqual({ startLedger: 1, endLedger: 1 });
  });

  it('accepts the maximum valid range width', () => {
    const from = '5000';
    const to = String(5000 + MAX_LEDGER_RANGE - 1);
    const result = parseLedgerRangeParams(from, to);
    expect(result.startLedger).toBe(5000);
    expect(result.endLedger).toBe(5000 + MAX_LEDGER_RANGE - 1);
  });

  // ── Missing parameters ─────────────────────────────────────────────────────

  it('rejects a missing fromLedger (null)', () => {
    const err = getValidationError(() => parseLedgerRangeParams(null, '100'));
    expect(err.issues.some((i) => i.field === 'fromLedger')).toBe(true);
  });

  it('rejects a missing toLedger (null)', () => {
    const err = getValidationError(() => parseLedgerRangeParams('1', null));
    expect(err.issues.some((i) => i.field === 'toLedger')).toBe(true);
  });

  it('rejects empty string for fromLedger', () => {
    const err = getValidationError(() => parseLedgerRangeParams('', '100'));
    expect(err.issues.some((i) => i.field === 'fromLedger')).toBe(true);
  });

  it('rejects both params missing at once, reporting both fields', () => {
    const err = getValidationError(() => parseLedgerRangeParams(null, null));
    const fields = err.issues.map((i) => i.field);
    expect(fields).toContain('fromLedger');
    expect(fields).toContain('toLedger');
  });

  // ── Non-integer string inputs ──────────────────────────────────────────────

  it('rejects a float string for fromLedger', () => {
    expect(() => parseLedgerRangeParams('1.5', '10')).toThrow(ValidationError);
  });

  it('rejects an alphabetic string for toLedger', () => {
    expect(() => parseLedgerRangeParams('1', 'abc')).toThrow(ValidationError);
  });

  it('rejects zero for fromLedger', () => {
    expect(() => parseLedgerRangeParams('0', '100')).toThrow(ValidationError);
  });

  it('rejects a negative string for toLedger', () => {
    expect(() => parseLedgerRangeParams('1', '-5')).toThrow(ValidationError);
  });

  // ── Range validation ───────────────────────────────────────────────────────

  it('rejects an inverted range (from > to)', () => {
    expect(() => parseLedgerRangeParams('200', '100')).toThrow(ValidationError);
  });

  it('rejects a range exceeding MAX_LEDGER_RANGE', () => {
    const from = '1';
    const to = String(MAX_LEDGER_RANGE + 1);
    expect(() => parseLedgerRangeParams(from, to)).toThrow(ValidationError);
  });

  it('respects a custom maxRange override', () => {
    // Range of width 5 — fine with custom limit of 5, would exceed default.
    expect(() => parseLedgerRangeParams('1', '5', 5)).not.toThrow();
    expect(() => parseLedgerRangeParams('1', '6', 5)).toThrow(ValidationError);
  });
});

// ── MIN/MAX constant sanity checks ────────────────────────────────────────────

describe('module constants', () => {
  it('MIN_LEDGER is 1', () => expect(MIN_LEDGER).toBe(1));
  it('MAX_LEDGER_VALUE is 2^32 - 1', () => expect(MAX_LEDGER_VALUE).toBe(4_294_967_295));
  it('MAX_LEDGER_RANGE is 10 000', () => expect(MAX_LEDGER_RANGE).toBe(10_000));
});

// ── Helper ────────────────────────────────────────────────────────────────────

function getValidationError(fn: () => void): ValidationError {
  try {
    fn();
    throw new Error('Expected a ValidationError to be thrown but none was');
  } catch (e) {
    if (e instanceof ValidationError) return e;
    throw e;
  }
}
