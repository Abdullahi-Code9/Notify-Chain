/**
 * Standardized API Response Helpers  (Issue #385)
 *
 * Every HTTP response produced by the listener API is wrapped in one of two
 * envelopes so that clients have a single, predictable shape to parse:
 *
 * Success
 * -------
 * {
 *   "success": true,
 *   "data": <payload>,
 *   "meta": <optional – pagination / extra context>
 * }
 *
 * Error  (#987)
 * -----
 * {
 *   "success": false,
 *   "error": {
 *     "code":           "<SCREAMING_SNAKE_CASE>",   – stable, see errors/api-error-codes.ts
 *     "message":        "<human readable>",
 *     "details":        <validation errors / extra context; [] when none>,
 *     "correlation_id": "<request correlation id>"  – present when known
 *   }
 * }
 *
 * Usage
 * -----
 *   import { sendOk, sendErr, ErrorCode } from '../utils/response';
 *
 *   sendOk(res, 200, { count: 3, items: [...] });
 *   sendOk(res, 200, rows, { total: 100, page: 1 });
 *   sendErr(res, 404, 'Template not found', ErrorCode.NOT_FOUND);
 *   sendErr(res, 400, 'Validation failed', ErrorCode.BAD_REQUEST, fieldErrors);
 */

import http from 'http';
import { ErrorCode, type ErrorCodeValue } from '../errors/api-error-codes';
import { getCorrelationId } from './correlation-context';

export { ErrorCode, ERROR_CODE_CATALOG, isKnownErrorCode } from '../errors/api-error-codes';
export type { ErrorCodeValue } from '../errors/api-error-codes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details: unknown;
  correlation_id?: string;
}

export interface ApiError {
  success: false;
  error: ApiErrorBody;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build a success envelope.  `meta` is omitted when not provided.
 */
export function ok<T>(data: T, meta?: Record<string, unknown>): ApiSuccess<T> {
  const envelope: ApiSuccess<T> = { success: true, data };
  if (meta !== undefined) envelope.meta = meta;
  return envelope;
}

/**
 * Build an error envelope.
 *
 * @param message  Human-readable description forwarded to the client.
 * @param code     Machine-readable code; defaults to `INTERNAL_ERROR`.
 * @param details  Optional extra context (validation errors, field names, …);
 *                 defaults to `[]` so clients can always iterate it.
 * @param correlationId  Defaults to the active request's correlation ID.
 */
export function err(
  message: string,
  code: ErrorCodeValue | string = ErrorCode.INTERNAL_ERROR,
  details?: unknown,
  correlationId: string | undefined = getCorrelationId(),
): ApiError {
  const body: ApiErrorBody = { code, message, details: details ?? [] };
  if (correlationId) body.correlation_id = correlationId;
  return { success: false, error: body };
}

// ---------------------------------------------------------------------------
// Response senders
// ---------------------------------------------------------------------------

/**
 * Write a raw JSON response.  Prefer `sendOk` / `sendErr` over this.
 */
export function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Send a success envelope.
 *
 * @example
 *   sendOk(res, 200, { count: events.length, events });
 *   sendOk(res, 200, rows, { total, page });
 */
export function sendOk<T>(
  res: http.ServerResponse,
  statusCode: number,
  data: T,
  meta?: Record<string, unknown>,
): void {
  sendJson(res, statusCode, ok(data, meta));
}

/**
 * Send an error envelope.
 *
 * @example
 *   sendErr(res, 404, 'Notification not found', ErrorCode.NOT_FOUND);
 *   sendErr(res, 400, 'Validation failed', ErrorCode.BAD_REQUEST, fieldErrors);
 */
export function sendErr(
  res: http.ServerResponse,
  statusCode: number,
  message: string,
  code: ErrorCodeValue | string = ErrorCode.INTERNAL_ERROR,
  details?: unknown,
  correlationId?: string,
): void {
  sendJson(res, statusCode, err(message, code, details, correlationId ?? getCorrelationId()));
}
