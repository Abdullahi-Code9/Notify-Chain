/**
 * ETag / conditional GET support (#985)
 *
 * Event feeds and statistics are polled far more often than they change. For
 * those endpoints the serialized response body is hashed into a strong ETag;
 * a client that sends the tag back in `If-None-Match` gets an empty
 * `304 Not Modified` instead of the full payload.
 *
 * The tag is derived from the exact bytes that would be sent, so it changes
 * whenever the underlying data does — there is no separate cache to invalidate.
 * `Cache-Control: no-cache` tells clients and proxies they may store the
 * response but must revalidate it on every use.
 *
 *   sendOkWithETag(req, res, { count, events });
 */

import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { ok } from '../utils/response';

export const ETAG_CACHE_CONTROL = 'private, no-cache';

/** Strong ETag: quoted base64url SHA-256 of the representation. */
export function computeETag(body: string | Buffer): string {
  const digest = crypto.createHash('sha256').update(body).digest('base64url');
  return `"${digest}"`;
}

/** Drops a weak-validator prefix so `W/"x"` and `"x"` compare equal. */
function opaqueTag(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

/**
 * True when `If-None-Match` matches `etag`. Uses the weak comparison RFC 9110
 * §13.1.2 prescribes for this header, and honours `*` and comma-separated
 * lists. Absent or empty headers never match.
 */
export function ifNoneMatchSatisfied(
  ifNoneMatch: string | string[] | undefined,
  etag: string,
): boolean {
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch;
  if (!raw || !raw.trim()) return false;
  if (raw.trim() === '*') return true;

  const target = opaqueTag(etag);
  return raw
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .some((candidate) => opaqueTag(candidate) === target);
}

/**
 * Writes `body` as JSON with an ETag, or a bodiless 304 when the client's
 * `If-None-Match` already holds the current tag. Only 200 responses to GET /
 * HEAD are made conditional; anything else is sent unchanged.
 *
 * @returns true when a 304 was sent.
 */
export function sendJsonWithETag(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): boolean {
  const serialized = JSON.stringify(body);
  const method = req.method ?? 'GET';
  const conditional = statusCode === 200 && (method === 'GET' || method === 'HEAD');

  if (!conditional) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(serialized);
    return false;
  }

  const etag = computeETag(serialized);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', ETAG_CACHE_CONTROL);

  if (ifNoneMatchSatisfied(req.headers['if-none-match'], etag)) {
    // A 304 carries no body, so no representation headers either.
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Length');
    res.writeHead(304);
    res.end();
    return true;
  }

  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(method === 'HEAD' ? undefined : serialized);
  return false;
}

/** `sendOk` counterpart that adds ETag / If-None-Match handling. */
export function sendOkWithETag<T>(
  req: IncomingMessage,
  res: ServerResponse,
  data: T,
  meta?: Record<string, unknown>,
): boolean {
  return sendJsonWithETag(req, res, 200, ok(data, meta));
}
