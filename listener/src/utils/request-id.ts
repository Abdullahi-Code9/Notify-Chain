import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Generates a short, unique request identifier for tracing a single poll cycle
 * or API request through the notification pipeline.
 */
export function generateRequestId(): string {
  return randomUUID().split('-')[0];
}

/**
 * Generates a non-sensitive identifier for tracing one notification workflow.
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Client-supplied request IDs must be printable ASCII tokens of bounded length.
 * Rejects empty values, control characters, whitespace, and oversized strings
 * so untrusted header content is never reused as a log/trace key (#686).
 */
const CLIENT_REQUEST_ID_PATTERN = /^[\w.:-]{8,128}$/;

export function isValidRequestId(value: string): boolean {
  return CLIENT_REQUEST_ID_PATTERN.test(value);
}

/**
 * Resolves the request ID for an incoming request.
 * Reuses a validated client `X-Request-Id` when present; otherwise mints one.
 */
export function resolveRequestId(incomingHeader: string | string[] | undefined): string {
  const incoming = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader;
  const trimmed = incoming?.trim() ?? '';
  if (trimmed && isValidRequestId(trimmed)) {
    return trimmed;
  }
  return generateRequestId();
}

/**
 * Resolves a correlation ID for a request.
 * Honours an incoming X-Correlation-Id header if present and non-blank,
 * otherwise generates a new UUID. Correlation IDs are intentionally more
 * permissive than request IDs (callers may use longer opaque tokens).
 */
export function resolveCorrelationId(incomingHeader: string | string[] | undefined): string {
  const incoming = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader;
  const trimmed = incoming?.trim() ?? '';
  if (!trimmed) {
    return randomUUID();
  }
  // Bound length / charset so log aggregators stay safe
  if (trimmed.length > 200 || /[\r\n\0]/.test(trimmed)) {
    return randomUUID();
  }
  return trimmed;
}

export interface RequestContext {
  /** Id for this single request; reused from a validated client header when present. */
  requestId: string;
  /** Id used to trace a request across services; honours an inbound X-Correlation-Id header. */
  correlationId: string;
  /** True when the requestId came from a validated client-supplied header. */
  requestIdReused: boolean;
}

/**
 * Request-ID middleware for the events API server (#686).
 *
 * Every incoming HTTP request is assigned a `requestId` (reusing a validated
 * client `X-Request-Id` when present) and a `correlationId` (reusing the
 * caller's `X-Correlation-Id` when present). Both are echoed back as
 * `X-Request-Id` / `X-Correlation-Id` response headers so a caller can
 * correlate its request with the server's logs.
 *
 * Call this once per request, before any routing logic runs.
 */
export function applyRequestContext(req: IncomingMessage, res: ServerResponse): RequestContext {
  const incomingRequestId = req.headers['x-request-id'];
  const raw =
    (Array.isArray(incomingRequestId) ? incomingRequestId[0] : incomingRequestId)?.trim() ?? '';
  const requestIdReused = Boolean(raw && isValidRequestId(raw));
  const requestId = requestIdReused ? raw : generateRequestId();
  const correlationId = resolveCorrelationId(req.headers['x-correlation-id']);
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Correlation-Id', correlationId);
  return { requestId, correlationId, requestIdReused };
}
