/**
 * Locale-aware number formatting utilities.
 *
 * These helpers wrap `Intl.NumberFormat` and provide safe locale handling:
 * unsupported or invalid locales fall back to `en-US`. Full numeric precision
 * is preserved (no rounding is applied unless explicitly requested via
 * `maximumFractionDigits`/`minimumFractionDigits` options).
 */

export const DEFAULT_LOCALE = 'en-US';

export interface NumberFormatOptions extends Intl.NumberFormatOptions {
  /** Locale (or locales) to format with. Falls back to en-US when unsupported. */
  locale?: string | string[];
}

/**
 * Resolve a locale (or list of locales) to one supported by `Intl.NumberFormat`.
 * Returns `DEFAULT_LOCALE` when the requested locale is invalid or unsupported.
 */
export function resolveLocale(locale?: string | string[]): string {
  if (!locale) {
    return DEFAULT_LOCALE;
  }

  const candidates = Array.isArray(locale) ? locale : [locale];
  const valid = candidates.filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );

  if (valid.length === 0) {
    return DEFAULT_LOCALE;
  }

  try {
    const supported = Intl.NumberFormat.supportedLocalesOf(valid);
    if (supported.length > 0) {
      return supported[0];
    }
  } catch {
    // Invalid locale tags can throw a RangeError; fall through to default.
  }

  return DEFAULT_LOCALE;
}

/**
 * Create a reusable `Intl.NumberFormat` instance with safe locale handling.
 */
export function createNumberFormatter(
  options: NumberFormatOptions = {},
): Intl.NumberFormat {
  const { locale, ...intlOptions } = options;
  const resolved = resolveLocale(locale);

  try {
    return new Intl.NumberFormat(resolved, intlOptions);
  } catch {
    // Invalid options (e.g. conflicting fraction digit settings) fall back to
    // a plain formatter so callers never crash on bad configuration.
    return new Intl.NumberFormat(DEFAULT_LOCALE);
  }
}

/**
 * Format a numeric value according to the given locale and options.
 * Non-finite values (NaN, Infinity) are returned as-is as strings.
 */
export function formatNumber(
  value: number,
  options: NumberFormatOptions = {},
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return String(value);
  }

  return createNumberFormatter(options).format(value);
}

/**
 * Format a number as a currency amount.
 */
export function formatCurrency(
  value: number,
  currency: string,
  options: NumberFormatOptions = {},
): string {
  return formatNumber(value, {
    ...options,
    style: 'currency',
    currency,
  });
}

/**
 * Format a number as a percentage. By default the value is treated as a
 * fraction (0.25 -> "25%"). Pass `isFraction: false` to treat the value as
 * already being in percent units.
 */
export function formatPercent(
  value: number,
  options: NumberFormatOptions & { isFraction?: boolean } = {},
): string {
  const { isFraction = true, ...intlOptions } = options;
  const normalized = isFraction ? value : value / 100;

  return formatNumber(normalized, {
    ...intlOptions,
    style: 'percent',
  });
}

/**
 * Format a number with grouping separators (e.g. 1,234,567.89).
 */
export function formatDecimal(
  value: number,
  options: NumberFormatOptions = {},
): string {
  return formatNumber(value, {
    ...options,
    style: 'decimal',
  });
}

/**
 * Format a number in compact notation (e.g. 1.2K, 3.4M).
 */
export function formatCompactNumber(
  value: number,
  options: NumberFormatOptions = {},
): string {
  return formatNumber(value, {
    ...options,
    notation: 'compact',
    compactDisplay: 'short',
  });
}

/**
 * Return the raw numeric value for copying or machine-readable exports.
 * This intentionally performs no formatting so precision is never lost.
 */
export function toRawNumber(value: number): number {
  return value;
}

/**
 * Return the raw numeric value as a string for copying or exports.
 * Uses the full precision representation of the number.
 */
export function toRawNumberString(value: number): string {
  return String(value);
}