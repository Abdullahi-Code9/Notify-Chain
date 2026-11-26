/**
 * Safe error serialization (#1141)
 *
 * Separates internal diagnostic detail from the public API response so that
 * stack traces, database messages, and secrets never appear in client-facing
 * JSON — while remaining fully visible in structured server logs.
 *
 * Design principles
 * -----------------
 * 1. **Public surface is always safe.** `toPublicError()` returns only the
 *    stable, human-readable message and machine code — never a stack trace,
 *    database error text, or sensitive field value.
 * 2. **Internal log retains full context.** `toInternalDiagnostic()` returns
 *    all available detail but runs every string field through the existing
 *    redaction engine, so secrets that accidentally reach an error message
 *    (e.g. a webhook URL in a fetch failure) are still masked.
 * 3. **Consistent format.** Both outputs use the same `ApiErrorBody` envelope
 *    so callers have one shape to handle.
 * 4. **Provider error shielding.** Errors surfaced from third-party provider
 *    integrations (Discord, webhook senders) are wrapped behind a generic
 *    provider-failure message; only the provider name and a non-sensitive
 *    status code are forwarded.
 *
 * Usage
 * -----
 * ```ts
 * import { toPublicError, toInternalDiagnostic } from '../utils/safe-error-serializer';
 *
 * // In a route error handler:
 * logger.error('Request failed', toInternalDiagnostic(error, correlationId));
 * sendJson(res, 500, toPublicError(ErrorCode.INTERNAL_ERROR, correlationId));
 * ```
 */

import { ErrorCode, type ErrorCodeValue } from '../errors/api-error-codes';
import { redactString, redactObject } from './redact';
import type { ApiErrorBody } from './response';

// ---------------------------------------------------------------------------
// Public error envelope
// ---------------------------------------------------------------------------

/**
 * Produces a **public-safe** error body: a stable code, a generic message,
 * and no internal details.  Safe to serialize directly into an HTTP response.
 *
 * @param code          The stable `ErrorCode` value for this failure class.
 * @param correlationId Request correlation id (non-sensitive; retained for
 *                      client-side tracing).
 * @param publicMessage Optional override for the human-readable message.  If
 *                      omitted a standard phrase for the code is used.
 */
export function toPublicError(
  code: ErrorCodeValue | string,
  correlationId?: string,
  publicMessage?: string,
): { success: false; error: ApiErrorBody } {
  return {
    success: false,
    error: {
      code,
      message: publicMessage ?? PUBLIC_MESSAGES[code as ErrorCodeValue] ?? 'An error occurred.',
      details: [],
      ...(correlationId ? { correlation_id: correlationId } : {}),
    },
  };
}

/**
 * Generic public-facing messages indexed by error code.  These never mention
 * implementation details, database table names, or internal service state.
 */
const PUBLIC_MESSAGES: Partial<Record<ErrorCodeValue, string>> = {
  [ErrorCode.INTERNAL_ERROR]: 'An internal server error occurred. Please try again later.',
  [ErrorCode.SERVICE_UNAVAILABLE]: 'A required service is temporarily unavailable.',
  [ErrorCode.BAD_REQUEST]: 'The request could not be processed.',
  [ErrorCode.UNAUTHORIZED]: 'Authentication is required.',
  [ErrorCode.INVALID_PERMISSIONS]: 'The provided credentials lack the required permissions.',
  [ErrorCode.NOT_FOUND]: 'The requested resource was not found.',
  [ErrorCode.RATE_LIMITED]: 'Too many requests. Please wait before retrying.',
  [ErrorCode.CONFLICT]: 'The request conflicts with the current state of the resource.',
  [ErrorCode.UNPROCESSABLE]: 'The request could not be processed due to a semantic error.',
};

// ---------------------------------------------------------------------------
// Internal diagnostic envelope
// ---------------------------------------------------------------------------

export interface InternalDiagnostic {
  /** Original error code (or INTERNAL_ERROR). */
  code: string;
  /** Redacted original error message. */
  message: string;
  /** Redacted stack trace (omitted for non-Error values). */
  stack?: string;
  /** Redacted cause chain. */
  cause?: string;
  /** Name of the Error subclass. */
  errorClass?: string;
  /** Correlation ID for cross-service tracing. */
  correlationId?: string;
  /** Any additional structured context provided by the caller. */
  context?: Record<string, unknown>;
}

/**
 * Extracts full diagnostic detail from a thrown value and redacts all
 * sensitive fields.  Safe to pass to `logger.error()` or similar.
 *
 * ```ts
 * logger.error('Delivery failed', toInternalDiagnostic(err, correlationId, {
 *   route: '/api/notifications',
 *   provider: 'discord',
 * }));
 * ```
 */
export function toInternalDiagnostic(
  error: unknown,
  correlationId?: string,
  context?: Record<string, unknown>,
): InternalDiagnostic {
  const diagnostic: InternalDiagnostic = {
    code: extractCode(error),
    message: redactString(extractMessage(error)),
    ...(correlationId ? { correlationId } : {}),
  };

  if (error instanceof Error) {
    diagnostic.errorClass = error.name;
    if (error.stack) {
      diagnostic.stack = redactString(error.stack);
    }
    if ('cause' in error && error.cause != null) {
      diagnostic.cause = redactString(String(error.cause));
    }
  }

  if (context && Object.keys(context).length > 0) {
    diagnostic.context = redactObject(context) as Record<string, unknown>;
  }

  return diagnostic;
}

// ---------------------------------------------------------------------------
// Provider error shielding
// ---------------------------------------------------------------------------

export interface ProviderErrorPublic {
  success: false;
  error: ApiErrorBody;
}

/**
 * Wraps a provider integration error into a public response body that reveals
 * only the provider name and (optionally) a non-sensitive HTTP status code.
 *
 * Internal detail — the provider's response body, URL, auth headers — is kept
 * out of the public error.  Call `toInternalDiagnostic(error, ...)` separately
 * to retain the full detail in server logs.
 *
 * ```ts
 * logger.error('Discord delivery failed', toInternalDiagnostic(err, correlationId, { provider: 'discord' }));
 * sendJson(res, 502, shieldProviderError('discord', correlationId));
 * ```
 */
export function shieldProviderError(
  providerName: string,
  correlationId?: string,
  statusCode?: number,
): ProviderErrorPublic {
  const sanitized = providerName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'provider';
  const statusHint = statusCode != null && statusCode >= 400 ? ` (HTTP ${statusCode})` : '';
  return {
    success: false,
    error: {
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: `Delivery via ${sanitized} failed${statusHint}. See server logs for details.`,
      details: [],
      ...(correlationId ? { correlation_id: correlationId } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function extractCode(error: unknown): string {
  if (
    error != null &&
    typeof error === 'object' &&
    'errorCode' in error &&
    typeof (error as { errorCode: unknown }).errorCode === 'string'
  ) {
    return (error as { errorCode: string }).errorCode;
  }
  return ErrorCode.INTERNAL_ERROR;
}
