/**
 * Validates ledger ranges for historical event queries.
 *
 * Soroban RPC ledger numbers are 32-bit unsigned integers. This module
 * enforces that any range supplied by an external caller is well-formed
 * before we issue an RPC request or a database query, preventing:
 *
 *  - Invalid input (non-integers, negatives, NaN)
 *  - Inverted ranges (startLedger > endLedger)
 *  - Unbounded requests that would stress the RPC node or the in-process
 *    registry (ranges wider than MAX_LEDGER_RANGE)
 */

import { InputValidator, ValidationError } from './validation';

/** Maximum number of ledgers a single historical query may span. */
export const MAX_LEDGER_RANGE = 10_000;

/** The smallest valid Soroban ledger number. */
export const MIN_LEDGER = 1;

/** The largest value a 32-bit unsigned integer can hold. */
export const MAX_LEDGER_VALUE = 4_294_967_295;

export interface LedgerRange {
  startLedger: number;
  endLedger: number;
}

export interface LedgerRangeValidationResult {
  valid: boolean;
  /** Human-readable description of the first validation failure. Present only when valid is false. */
  reason?: string;
  /** Structured field-level issues when more than one check fails. */
  issues?: Array<{ field: string; message: string }>;
}

/**
 * Validates `startLedger` and `endLedger` for a historical event query.
 *
 * Rules:
 *  1. Both values must be integers.
 *  2. Both values must be >= MIN_LEDGER (1).
 *  3. Both values must be <= MAX_LEDGER_VALUE (2^32 − 1).
 *  4. startLedger must be <= endLedger.
 *  5. The range width (endLedger − startLedger + 1) must not exceed MAX_LEDGER_RANGE.
 *
 * @throws {ValidationError} if any rule is violated, carrying per-field issues.
 */
export function validateLedgerRange(
  startLedger: unknown,
  endLedger: unknown,
  maxRange: number = MAX_LEDGER_RANGE,
): LedgerRange {
  const v = new InputValidator();

  // ── Rule 1 & 2 & 3: type and bounds for startLedger ─────────────────────
  const startOk =
    v.check(
      typeof startLedger === 'number' && Number.isInteger(startLedger),
      'startLedger',
      'must be an integer',
    ) &&
    v.check(
      (startLedger as number) >= MIN_LEDGER,
      'startLedger',
      `must be >= ${MIN_LEDGER}`,
    ) &&
    v.check(
      (startLedger as number) <= MAX_LEDGER_VALUE,
      'startLedger',
      `must be <= ${MAX_LEDGER_VALUE}`,
    );

  // ── Rule 1 & 2 & 3: type and bounds for endLedger ───────────────────────
  const endOk =
    v.check(
      typeof endLedger === 'number' && Number.isInteger(endLedger),
      'endLedger',
      'must be an integer',
    ) &&
    v.check(
      (endLedger as number) >= MIN_LEDGER,
      'endLedger',
      `must be >= ${MIN_LEDGER}`,
    ) &&
    v.check(
      (endLedger as number) <= MAX_LEDGER_VALUE,
      'endLedger',
      `must be <= ${MAX_LEDGER_VALUE}`,
    );

  // ── Rules 4 & 5: relationship checks (only when both values are integers) ─
  if (startOk && endOk) {
    const start = startLedger as number;
    const end = endLedger as number;

    v.check(start <= end, 'startLedger', 'must be <= endLedger');

    if (start <= end) {
      const rangeWidth = end - start + 1;
      v.check(
        rangeWidth <= maxRange,
        'endLedger',
        `range too large: ${rangeWidth} ledgers requested, maximum is ${maxRange}`,
      );
    }
  }

  v.throwIfInvalid();

  return { startLedger: startLedger as number, endLedger: endLedger as number };
}

/**
 * Non-throwing variant. Returns a structured result instead of throwing.
 *
 * Useful in contexts that prefer conditional checks over try/catch, such as
 * the EventSubscriber's internal validation path.
 */
export function safeLedgerRangeValidation(
  startLedger: unknown,
  endLedger: unknown,
  maxRange: number = MAX_LEDGER_RANGE,
): LedgerRangeValidationResult {
  try {
    validateLedgerRange(startLedger, endLedger, maxRange);
    return { valid: true };
  } catch (err) {
    if (err instanceof ValidationError) {
      return {
        valid: false,
        reason: err.message,
        issues: err.issues,
      };
    }
    return { valid: false, reason: String(err) };
  }
}

/**
 * Parses `fromLedger` and `toLedger` query-string parameters and validates
 * the resulting range in one step. Throws `ValidationError` on any failure
 * so the caller can return a 400 directly.
 *
 * Both parameters are required. Pass `maxRange` to override the default cap.
 */
export function parseLedgerRangeParams(
  fromParam: string | null,
  toParam: string | null,
  maxRange: number = MAX_LEDGER_RANGE,
): LedgerRange {
  const v = new InputValidator();

  const fromPresent = v.check(
    fromParam !== null && fromParam !== '',
    'fromLedger',
    'is required',
  );
  const toPresent = v.check(
    toParam !== null && toParam !== '',
    'toLedger',
    'is required',
  );

  // Surface missing-param errors immediately so the message is specific.
  v.throwIfInvalid();

  const fromRaw = Number(fromParam);
  const toRaw = Number(toParam);

  // Re-use the strict validator for all remaining rules.
  return validateLedgerRange(fromRaw, toRaw, maxRange);
}
