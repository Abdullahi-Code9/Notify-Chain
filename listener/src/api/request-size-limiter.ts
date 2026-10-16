/**
 * API Request Size Protection Middleware (Issue #688)
 *
 * Enforces strict byte-size limits on incoming HTTP request payloads,
 * rejecting oversized bodies with HTTP 413 Payload Too Large and aborting streams.
 */

import { Request, Response, NextFunction } from 'express';

export interface RequestSizeLimiterOptions {
  /** Maximum allowable request body size in bytes (default: 1MB = 1,048,576 bytes). */
  maxSizeBytes?: number;
}

export const DEFAULT_MAX_REQUEST_SIZE_BYTES = 1024 * 1024; // 1 MB

/**
 * Creates Express middleware enforcing request body size limits.
 */
export function createRequestSizeLimiter(options: RequestSizeLimiterOptions = {}) {
  const maxBytes = options.maxSizeBytes || DEFAULT_MAX_REQUEST_SIZE_BYTES;

  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Fast-path check Content-Length header if present
    const contentLength = req.headers['content-length'];
    if (contentLength) {
      const declaredSize = parseInt(contentLength, 10);
      if (!isNaN(declaredSize) && declaredSize > maxBytes) {
        res.status(413).json({
          error: 'PAYLOAD_TOO_LARGE',
          message: `Request body exceeds maximum allowed size of ${maxBytes} bytes.`,
          maxSizeBytes: maxBytes,
          declaredSizeBytes: declaredSize,
        });
        return;
      }
    }

    // 2. Stream chunk inspection for chunked transfer-encoding
    let receivedBytes = 0;
    let limitExceeded = false;

    const onData = (chunk: Buffer | string): void => {
      if (limitExceeded) return;

      receivedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;

      if (receivedBytes > maxBytes) {
        limitExceeded = true;

        // Clean up listeners and destroy incoming stream to prevent memory buffering
        req.removeListener('data', onData);
        req.pause();

        res.status(413).json({
          error: 'PAYLOAD_TOO_LARGE',
          message: `Streaming payload exceeded maximum size limit of ${maxBytes} bytes.`,
          maxSizeBytes: maxBytes,
          receivedBytes,
        });
      }
    };

    req.on('data', onData);

    // Continue to next handler if size check passes
    next();
  };
}
