/**
 * HTTP request framing validation (#1208).
 *
 * A request whose boundaries can be interpreted differently by a proxy and by
 * Node is a request-smuggling vector. Node rejects most malformed frames, but
 * header combinations can still be normalized differently when an upstream
 * proxy rewrites headers. We therefore apply a single explicit policy at the
 * application boundary, before any body bytes are read:
 *
 *   - Content-Length and Transfer-Encoding are mutually exclusive.
 *   - A repeated Content-Length is only accepted when every value is the same.
 *   - Transfer-Encoding, when present, must be exactly one `chunked` token.
 *     Other codings are not supported and cannot be safely interpreted here.
 *
 * Requests that do not carry a body are not subject to the framing checks.
 */

import type http from 'http';
import { ErrorCode } from '../utils/response';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const DIGITS = /^\d+$/;

export type FramingRejection =
  | 'conflicting-framing-headers'
  | 'invalid-content-length'
  | 'unsupported-transfer-encoding';

export interface FramingResult {
  allowed: boolean;
  reason?: FramingRejection;
}

/** Normalizes a header to its list of individual values. */
function headerValues(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.flatMap((value) => value.split(',').map((part) => part.trim()));
}

/**
 * Validates (and where possible canonicalizes) the framing headers.
 *
 * Returns the reason for a rejection so callers can log it consistently; the
 * HTTP 400 response is written here because no route has been selected yet.
 */
export function validateRequestFraming(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): FramingResult {
  const method = (req.method ?? 'GET').toUpperCase();
  if (!BODY_METHODS.has(method)) return { allowed: true };

  const lengthValues = headerValues(req.headers['content-length']);
  const encodingValues = headerValues(req.headers['transfer-encoding']);

  const reject = (reason: FramingRejection): FramingResult => {
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Bad Request',
          code: ErrorCode.BAD_REQUEST,
          message: 'Ambiguous or unsupported HTTP request framing',
          reason,
        }),
      );
    }
    // Stop before any handler reads an ambiguous body.
    req.destroy();
    return { allowed: false, reason };
  };

  if (lengthValues.length > 0 && encodingValues.length > 0) {
    return reject('conflicting-framing-headers');
  }

  if (lengthValues.length > 1 && lengthValues.some((value) => value !== lengthValues[0])) {
    return reject('invalid-content-length');
  }

  if (
    lengthValues.length > 0 &&
    (lengthValues.length !== 1 || !DIGITS.test(lengthValues[0]))
  ) {
    return reject('invalid-content-length');
  }

  if (encodingValues.length > 0) {
    if (encodingValues.length !== 1 || encodingValues[0].toLowerCase() !== 'chunked') {
      return reject('unsupported-transfer-encoding');
    }
    // Canonical form for downstream middleware: chunked requests have no
    // declared content length.
    delete req.headers['content-length'];
    req.headers['transfer-encoding'] = 'chunked';
    return { allowed: true };
  }

  if (lengthValues.length === 1) {
    // Canonicalize whitespace/repeated identical values to one number.
    req.headers['content-length'] = lengthValues[0];
  }

  return { allowed: true };
}
