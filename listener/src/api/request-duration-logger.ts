/**
 * API Request Duration & Access Logging Middleware (Issue #687)
 *
 * Measures HTTP request execution duration with millisecond precision,
 * logging structured access records without exposing sensitive query tokens or credentials.
 */

import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { redactString } from '../utils/redact';

export interface RequestDurationLogData {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestId?: string;
  ip?: string;
  contentLength?: number;
}

/**
 * Creates Express middleware that measures and logs API request durations.
 */
export function createRequestDurationLogger(
  customLogger: { info: (msg: string, meta?: Record<string, unknown>) => void } = logger
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startTime = process.hrtime.bigint();

    res.on('finish', () => {
      const endTime = process.hrtime.bigint();
      // Calculate elapsed milliseconds with 2 decimal precision
      const durationMs = Number((endTime - startTime) / BigInt(10000)) / 100;

      // Sanitize URL/path to prevent leaking secrets in query params
      const rawUrl = req.originalUrl || req.url || '/';
      const sanitizedPath = redactString(rawUrl);

      const logData: RequestDurationLogData = {
        method: req.method,
        path: sanitizedPath,
        statusCode: res.statusCode,
        durationMs,
        requestId: (req.headers['x-request-id'] as string) || (req as unknown as { id?: string }).id,
        ip: req.ip || req.socket.remoteAddress,
        contentLength: res.getHeader('content-length')
          ? parseInt(String(res.getHeader('content-length')), 10)
          : undefined,
      };

      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      const message = `HTTP ${req.method} ${sanitizedPath} ${res.statusCode} - ${durationMs.toFixed(2)}ms`;

      customLogger.info(message, logData);
    });

    next();
  };
}
