/**
 * Request body size limit.
 *
 * Every POST/PUT handler in the events API accumulates the request body into a
 * string (`body += chunk`) with no ceiling, so a single large upload grows the
 * process heap unbounded. This guard caps that.
 *
 * It runs once at dispatch rather than in each handler, which matters for the
 * "does not attempt to process rejected payloads" requirement: by the time a
 * route handler attaches its own `data` listener the request has already been
 * screened, and an oversized one has been answered and destroyed.
 *
 * Two checks, because either alone is insufficient:
 *
 *   * `Content-Length`, when present, is rejected before a single byte of body
 *     is read — the cheapest possible refusal.
 *   * A streaming byte counter, because `Content-Length` is client-supplied
 *     and absent entirely on chunked transfers. A client can understate it or
 *     omit it; the counter is what actually bounds memory.
 */

import type http from 'http';

/** Default ceiling: 1 MiB. Generous for JSON payloads, small enough to bound heap growth. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export type BodyLimitRejection = 'content-length-exceeded' | 'stream-exceeded';

export interface BodyLimitOptions {
  maxBytes?: number;
  /** Notified when a request is refused, so the caller can log it with its own context. */
  onRejected?: (reason: BodyLimitRejection, observedBytes: number) => void;
}

/** HTTP methods that carry a body worth screening. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Parses `Content-Length` into a byte count.
 *
 * Returns null for a missing, malformed, or negative value rather than
 * guessing — the streaming counter is the backstop for those.
 */
export function parseContentLength(raw: string | string[] | undefined): number | null {
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export interface BodyLimitResult {
  /** False when the request was refused; the caller must stop processing it. */
  allowed: boolean;
  reason?: BodyLimitRejection;
  observedBytes?: number;
}

/**
 * Screens one request against the configured ceiling.
 *
 * On rejection this writes a 413 and destroys the socket, then returns
 * `allowed: false`. Destroying matters: without it the client keeps sending a
 * body nobody will read, and the bytes still transit the process.
 *
 * Returns `allowed: true` for methods that carry no body, so GET/DELETE pay
 * only a set lookup.
 */
export function enforceBodyLimit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: BodyLimitOptions = {},
): BodyLimitResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const method = (req.method ?? 'GET').toUpperCase();

  if (!BODY_METHODS.has(method)) {
    return { allowed: true };
  }

  const declared = parseContentLength(req.headers['content-length']);

  // Cheapest refusal: the client told us it is too big, so nothing is read.
  if (declared !== null && declared > maxBytes) {
    options.onRejected?.('content-length-exceeded', declared);
    respondTooLarge(res, maxBytes, declared);
    req.destroy();
    return { allowed: false, reason: 'content-length-exceeded', observedBytes: declared };
  }

  // Backstop: Content-Length is client-supplied and absent on chunked
  // transfers, so count what actually arrives.
  let received = 0;
  let rejected = false;

  const onData = (chunk: Buffer | string): void => {
    if (rejected) return;
    received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (received <= maxBytes) return;

    rejected = true;
    req.removeListener('data', onData);
    options.onRejected?.('stream-exceeded', received);
    respondTooLarge(res, maxBytes, received);
    req.destroy();
  };

  req.on('data', onData);
  req.once('end', () => req.removeListener('data', onData));

  return { allowed: true };
}

/**
 * Writes the 413 response.
 *
 * No-ops when headers are already sent — a handler may have started
 * responding before the stream overran, and throwing here would replace a
 * useful error with an unhandled one.
 */
function respondTooLarge(res: http.ServerResponse, maxBytes: number, observedBytes: number): void {
  if (res.headersSent) return;

  const payload = JSON.stringify({
    error: 'Payload Too Large',
    code: 'PAYLOAD_TOO_LARGE',
    maxBytes,
    // The observed size is the client's own number or our count of their
    // bytes — echoing it back leaks nothing they did not send.
    observedBytes,
  });

  res.writeHead(413, { 'Content-Type': 'application/json' });
  res.end(payload);
}
