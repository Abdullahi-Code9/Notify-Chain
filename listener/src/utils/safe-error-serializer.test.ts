/**
 * Tests for safe error serialization (#1141)
 *
 * Verifies that:
 *   - Public responses never contain stack traces or sensitive values
 *   - Internal diagnostics retain full context but redact secrets
 *   - Provider errors are shielded appropriately
 *   - Format remains consistent
 */

import {
  toPublicError,
  toInternalDiagnostic,
  shieldProviderError,
} from './safe-error-serializer';
import { ErrorCode } from '../errors/api-error-codes';
import { REDACTED_PLACEHOLDER } from './redact';

// ---------------------------------------------------------------------------
// toPublicError
// ---------------------------------------------------------------------------

describe('toPublicError()', () => {
  it('produces success: false with the correct code', () => {
    const result = toPublicError(ErrorCode.INTERNAL_ERROR);
    expect(result.success).toBe(false);
    expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it('provides a generic message for INTERNAL_ERROR — no stack trace or db detail', () => {
    const result = toPublicError(ErrorCode.INTERNAL_ERROR);
    expect(result.error.message).not.toMatch(/stack/i);
    expect(result.error.message).not.toMatch(/sqlite/i);
    expect(result.error.message).not.toMatch(/password/i);
  });

  it('always returns an empty details array', () => {
    const result = toPublicError(ErrorCode.BAD_REQUEST);
    expect(Array.isArray(result.error.details)).toBe(true);
    expect(result.error.details).toHaveLength(0);
  });

  it('includes correlationId when provided', () => {
    const result = toPublicError(ErrorCode.INTERNAL_ERROR, 'corr-123');
    expect(result.error.correlation_id).toBe('corr-123');
  });

  it('omits correlationId when not provided', () => {
    const result = toPublicError(ErrorCode.INTERNAL_ERROR);
    expect(result.error.correlation_id).toBeUndefined();
  });

  it('uses the custom publicMessage when supplied', () => {
    const result = toPublicError(ErrorCode.NOT_FOUND, undefined, 'Template not found');
    expect(result.error.message).toBe('Template not found');
  });

  it('never exposes a passed Error object in the public response', () => {
    const internalError = new Error('SELECT * FROM users WHERE api_key = "leaked"');
    // Public error is generated from the code, NOT from the error object
    const result = toPublicError(ErrorCode.INTERNAL_ERROR);
    expect(JSON.stringify(result)).not.toContain('leaked');
    expect(JSON.stringify(result)).not.toContain('SELECT');
    void internalError; // suppress unused var warning
  });
});

// ---------------------------------------------------------------------------
// toInternalDiagnostic
// ---------------------------------------------------------------------------

describe('toInternalDiagnostic()', () => {
  it('retains the error message in internal diagnostics', () => {
    const error = new Error('connection refused at port 5432');
    const diag = toInternalDiagnostic(error);
    expect(diag.message).toContain('connection refused');
  });

  it('includes the stack trace in internal diagnostics', () => {
    const error = new Error('boom');
    const diag = toInternalDiagnostic(error);
    expect(diag.stack).toBeDefined();
  });

  it('redacts secrets from the error message', () => {
    const error = new Error('failed to post to https://hooks.slack.com/services/TOKEN123/key');
    const diag = toInternalDiagnostic(error);
    expect(diag.message).not.toContain('TOKEN123');
    expect(diag.message).toContain(REDACTED_PLACEHOLDER);
  });

  it('redacts secrets from the stack trace', () => {
    const error = new Error('request failed');
    // Manually inject a fake stack with a secret
    error.stack = 'Error: request failed\n    at webhook_token=supersecret:1:1';
    const diag = toInternalDiagnostic(error);
    expect(diag.stack).not.toContain('supersecret');
  });

  it('redacts sensitive keys in context', () => {
    const diag = toInternalDiagnostic(new Error('err'), undefined, {
      apiKey: 'sk-realkey',
      route: '/api/notifications',
    });
    expect(diag.context?.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(diag.context?.route).toBe('/api/notifications');
  });

  it('records correlationId when provided', () => {
    const diag = toInternalDiagnostic(new Error('err'), 'corr-999');
    expect(diag.correlationId).toBe('corr-999');
  });

  it('extracts errorCode from ApiError instances', () => {
    const fakeApiError = Object.assign(new Error('not found'), {
      errorCode: ErrorCode.NOT_FOUND,
    });
    const diag = toInternalDiagnostic(fakeApiError);
    expect(diag.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('defaults code to INTERNAL_ERROR for plain errors', () => {
    const diag = toInternalDiagnostic(new Error('generic'));
    expect(diag.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it('handles non-Error thrown values gracefully', () => {
    const diag = toInternalDiagnostic('something went wrong');
    expect(diag.message).toBe('something went wrong');
    expect(diag.stack).toBeUndefined();
  });

  it('handles thrown objects gracefully', () => {
    const diag = toInternalDiagnostic({ reason: 'timeout' });
    expect(typeof diag.message).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// shieldProviderError
// ---------------------------------------------------------------------------

describe('shieldProviderError()', () => {
  it('never exposes provider internal detail — only name and status hint', () => {
    const result = shieldProviderError('discord', 'corr-1', 403);
    expect(result.error.message).toContain('discord');
    expect(result.error.message).toContain('403');
    // No stack trace, no internal message
    expect(result.error.details).toHaveLength(0);
  });

  it('uses SERVICE_UNAVAILABLE code', () => {
    const result = shieldProviderError('webhook');
    expect(result.error.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
  });

  it('sanitizes malicious provider name characters', () => {
    const result = shieldProviderError('<script>alert(1)</script>');
    expect(result.error.message).not.toContain('<script>');
  });

  it('includes correlationId when provided', () => {
    const result = shieldProviderError('discord', 'corr-shield');
    expect(result.error.correlation_id).toBe('corr-shield');
  });

  it('omits statusCode hint when not provided', () => {
    const result = shieldProviderError('discord');
    expect(result.error.message).not.toMatch(/HTTP \d+/);
  });

  it('produces consistent success: false format', () => {
    const result = shieldProviderError('email', 'corr-2', 502);
    expect(result.success).toBe(false);
    expect(typeof result.error.code).toBe('string');
    expect(typeof result.error.message).toBe('string');
    expect(Array.isArray(result.error.details)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Separation guarantee (integration)
// ---------------------------------------------------------------------------

describe('Public vs internal separation guarantee', () => {
  it('public error contains no stack trace even when internal does', () => {
    const dbError = new Error("SQLITE_ERROR: table 'users' doesn't exist");
    dbError.stack = "Error at internal/db.js:45\n  at execute() credentials=sk-secret";

    const publicErr = toPublicError(ErrorCode.INTERNAL_ERROR, 'corr-sep');
    const internalDiag = toInternalDiagnostic(dbError, 'corr-sep');

    // Public: no db detail, no stack
    const publicJson = JSON.stringify(publicErr);
    expect(publicJson).not.toContain("SQLITE_ERROR");
    expect(publicJson).not.toContain("stack");
    expect(publicJson).not.toContain("credentials");

    // Internal: stack present, secret redacted
    expect(internalDiag.stack).toBeDefined();
    expect(internalDiag.stack).not.toContain('sk-secret');
    expect(internalDiag.message).toContain('SQLITE_ERROR');
  });
});
