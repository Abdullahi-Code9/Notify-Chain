/**
 * Stable, machine-readable API error codes (#987)
 *
 * Every error response produced by the listener API carries one of these codes
 * in `error.code`. Clients should branch on the code, never on `message`, which
 * is human-readable and may change between releases.
 *
 * Codes are part of the public API contract: once published a code is never
 * renamed or repurposed. New failure modes get new codes.
 *
 * Envelope:
 *
 *   {
 *     "success": false,
 *     "error": {
 *       "code": "INVALID_PERMISSIONS",
 *       "message": "The provided credentials lack the necessary scope for this action.",
 *       "details": [],
 *       "correlation_id": "4d1c3c1e-..."
 *     }
 *   }
 *
 * See listener/API_ERROR_REFERENCE.md for the client-facing documentation.
 */

export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_PERMISSIONS: 'INVALID_PERMISSIONS',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  UNPROCESSABLE: 'UNPROCESSABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorCodeDefinition {
  /** HTTP status the code is normally returned with. */
  status: number;
  /** One-line description for documentation and tooling. */
  description: string;
}

/**
 * Catalogue of every published error code. Kept exhaustive by the
 * `Record<ErrorCodeValue, …>` type so adding a code without documenting it is a
 * compile error.
 */
export const ERROR_CODE_CATALOG: Readonly<Record<ErrorCodeValue, ErrorCodeDefinition>> = {
  BAD_REQUEST: { status: 400, description: 'The request is malformed or has invalid parameters.' },
  VALIDATION_ERROR: {
    status: 400,
    description: 'The request body failed schema validation; see `details` for each issue.',
  },
  PARSE_ERROR: { status: 400, description: 'The request body is not valid JSON.' },
  UNAUTHORIZED: {
    status: 401,
    description: 'Credentials are missing, unknown, revoked, or do not match.',
  },
  INVALID_PERMISSIONS: {
    status: 403,
    description: 'The credentials are valid but lack the scope required for this action.',
  },
  FORBIDDEN: { status: 403, description: 'The action is not permitted for this caller.' },
  NOT_FOUND: { status: 404, description: 'The route or requested resource does not exist.' },
  METHOD_NOT_ALLOWED: {
    status: 405,
    description: 'The resource exists but does not support this HTTP method; see the Allow header.',
  },
  CONFLICT: { status: 409, description: 'The request conflicts with the current resource state.' },
  PAYLOAD_TOO_LARGE: { status: 413, description: 'The request body exceeds the size limit.' },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    description: 'The request Content-Type is not accepted by this endpoint.',
  },
  UNPROCESSABLE: {
    status: 422,
    description:
      'The request is well-formed but cannot be processed (e.g. template render failure).',
  },
  RATE_LIMITED: { status: 429, description: 'Rate limit exceeded; honour the Retry-After header.' },
  INTERNAL_ERROR: { status: 500, description: 'An unexpected server-side failure occurred.' },
  SERVICE_UNAVAILABLE: {
    status: 503,
    description: 'A required optional service (scheduler, templates, …) is not configured.',
  },
};

export function isKnownErrorCode(code: string): code is ErrorCodeValue {
  return Object.prototype.hasOwnProperty.call(ERROR_CODE_CATALOG, code);
}
