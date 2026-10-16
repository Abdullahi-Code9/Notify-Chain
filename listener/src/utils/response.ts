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
 * Error
 * -----
 * {
 *   "success": false,
 *   "error": {
 *     "code":    "<SCREAMING_SNAKE_CASE>",
 *     "message": "<human readable>",
 *     "details": <optional – validation errors, extra context>
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
  details?: unknown;
}

export interface ApiError {
  success: false;
  error: ApiErrorBody;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// ---------------------------------------------------------------------------
// Well-known error codes
// ---------------------------------------------------------------------------

export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE: 'UNPROCESSABLE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  PARSE_ERROR: 'PARSE_ERROR',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

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
 * @param details  Optional extra context (validation errors, field names, …).
 */
export function err(
  message: string,
  code: ErrorCodeValue | string = ErrorCode.INTERNAL_ERROR,
  details?: unknown,
): ApiError {
  const body: ApiErrorBody = { code, message };
  if (details !== undefined) body.details = details;
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
): void {
  sendJson(res, statusCode, err(message, code, details));
}
