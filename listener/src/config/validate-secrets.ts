/**
 * Startup secret validation (#692).
 *
 * Enforces that every required credential is present and, in production mode,
 * does not use a known development placeholder.  Designed to be called once
 * during application bootstrap so the service fails fast rather than starting
 * in an insecure state.
 *
 * ## Design principles
 *
 * - **Zero-leak diagnostics**: error messages name the *field* that failed and
 *   the *reason* (missing / placeholder) but never echo the actual value.
 * - **Collect-all errors**: every violation is gathered before throwing so an
 *   operator sees all problems in a single restart, not one per restart.
 * - **Production-only placeholder rejection**: placeholder detection is only
 *   active when `NODE_ENV === "production"` so development environments can
 *   use example values without being blocked.
 */

/** A ConfigError subclass raised by secret validation failures. */
export class SecretValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretValidationError';
  }
}

/**
 * Known development placeholder strings that must never appear in a
 * production configuration.  Extend this list as new sentinel values emerge.
 *
 * All comparisons are **case-insensitive** and **trimmed**.
 */
export const KNOWN_PLACEHOLDERS: ReadonlyArray<string> = [
  'your_secret_here',
  'your-secret-here',
  'changeme',
  'change_me',
  'change-me',
  'admin',
  'password',
  'secret',
  '123456',
  '1234567890',
  'abcdef',
  'test',
  'example',
  'placeholder',
  'todo',
  'fixme',
  'replace_me',
  'replace-me',
  'your_webhook_token',
  'your_hmac_secret',
  'your_api_key',
  'whsec_your_secret_here',
  'sk_live_abc123',
  'your_webhook_id',
  'xxxxxxxxxxxxxxxxxxxx',
];

/**
 * Descriptor for a single secret field that must be validated on startup.
 * Callers build a list of these and pass it to `validateSecrets`.
 */
export interface SecretField {
  /**
   * The environment variable name (e.g. `"DISCORD_WEBHOOK_URL"`).
   * Used exclusively in diagnostic messages — the value is never included.
   */
  fieldName: string;

  /** The resolved value of the field (may be undefined/empty). */
  value: string | undefined | null;

  /**
   * When `true` the field is required: a missing or empty value fails
   * validation regardless of the current environment.
   * When `false` the field is optional but still checked for placeholders in
   * production if a non-empty value is present.
   */
  required?: boolean;
}

/**
 * Return `true` when `value` matches a known development placeholder.
 * The comparison is case-insensitive and both sides are trimmed.
 */
export function isPlaceholder(value: string): boolean {
  const normalised = value.trim().toLowerCase();
  return KNOWN_PLACEHOLDERS.some((placeholder) => normalised === placeholder.toLowerCase());
}

/**
 * Validate a list of secret fields and throw a `SecretValidationError` when
 * any violation is found.
 *
 * Violations collected:
 * 1. A required field is missing or empty → always fails.
 * 2. Any field (required or optional) that has a non-empty value matching a
 *    known placeholder while `NODE_ENV === "production"` → fails in production.
 *
 * @param fields - List of secret fields to validate.
 * @param isProduction - Override production detection (defaults to
 *   `process.env.NODE_ENV === "production"`).  Useful in tests.
 *
 * @throws {SecretValidationError} when one or more fields fail validation.
 *
 * @example
 * ```ts
 * validateSecrets([
 *   { fieldName: 'DISCORD_WEBHOOK_URL', value: process.env.DISCORD_WEBHOOK_URL, required: true },
 *   { fieldName: 'WEBHOOK_SECRET',      value: process.env.WEBHOOK_SECRET,      required: false },
 * ]);
 * ```
 */
export function validateSecrets(
  fields: SecretField[],
  isProduction: boolean = process.env.NODE_ENV === 'production'
): void {
  const errors: string[] = [];

  for (const field of fields) {
    const trimmedValue = field.value?.trim();
    const isEmpty = !trimmedValue;

    // 1. Required-field check.
    if (field.required && isEmpty) {
      errors.push(
        `[Config Error] Required secret field '${field.fieldName}' is missing or empty. ` +
          `Set the environment variable '${field.fieldName}' to a secure, non-placeholder value.`
      );
      // Skip placeholder check – there is nothing to check.
      continue;
    }

    // 2. Placeholder check (production only, only when a value is present).
    if (isProduction && !isEmpty && isPlaceholder(trimmedValue as string)) {
      errors.push(
        `[Config Error] Secret field '${field.fieldName}' contains a known development ` +
          `placeholder value in production mode. ` +
          `Update the environment variable '${field.fieldName}' with a secure, randomly-generated secret.`
      );
    }
  }

  if (errors.length > 0) {
    throw new SecretValidationError(
      `Secret validation failed with ${errors.length} error(s):\n` +
        errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
    );
  }
}
