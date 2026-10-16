/**
 * Response-time middleware (#491)
 *
 * Attaches an `X-Response-Time` header to every HTTP response and logs the
 * elapsed milliseconds.  Requests that exceed `slowRequestThresholdMs` are
 * flagged at WARN level so they are easy to spot in log aggregators.
 *
 * Usage:
 *
 *   const rt = new ResponseTimeMiddleware({ slowRequestThresholdMs: 1000 });
 *   // early in the request handler:
 *   rt.start(res);
 *   // just before writing the status line:
 *   rt.finish(req, res, requestId);
 */

import http from 'http';
import logger, { sanitizeUrl } from '../utils/logger';

export interface ResponseTimeOptions {
  /**
   * Requests slower than this value (ms) are logged at WARN level and flagged
   * as slow.  Defaults to 1 000 ms.
   */
  slowRequestThresholdMs?: number;
}

export interface ResponseTimeMetrics {
  totalRequests: number;
  slowRequests: number;
  /** Sum of all response times in ms — divide by totalRequests for the mean. */
  totalResponseTimeMs: number;
  maxResponseTimeMs: number;
}

const START_TIME_KEY = Symbol('responseTimeStart');

export class ResponseTimeMiddleware {
  private readonly threshold: number;
  private metrics: ResponseTimeMetrics = {
    totalRequests: 0,
    slowRequests: 0,
    totalResponseTimeMs: 0,
    maxResponseTimeMs: 0,
  };

  constructor(options: ResponseTimeOptions = {}) {
    this.threshold = options.slowRequestThresholdMs ?? 1_000;
  }

  /**
   * Call at the very start of request processing to record the start time.
   * The timestamp is stored on the response object so it travels through the
   * handler stack without needing a separate closure.
   */
  start(res: http.ServerResponse): void {
    (res as any)[START_TIME_KEY] = Date.now();
  }

  /**
   * Call just before sending the response.  Computes the elapsed time, sets
   * the `X-Response-Time` header, logs the result, and updates metrics.
   *
   * Returns the elapsed time in ms so callers can include it in their own log
   * entries.
   */
  finish(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestId?: string,
    statusCode?: number,
  ): number {
    const startTime = (res as any)[START_TIME_KEY] as number | undefined;
    const durationMs = startTime !== undefined ? Date.now() - startTime : 0;

    // Attach the timing header before the caller calls writeHead so the value
    // is available on the wire.  If headers have already been sent this is a
    // no-op (Node.js silently ignores setHeader after headers flush).
    if (!res.headersSent) {
      res.setHeader('X-Response-Time', `${durationMs}ms`);
    }

    const method = req.method ?? 'UNKNOWN';
    // Sanitized, not raw: the path is what makes this line useful for finding
    // a slow endpoint, but query strings routinely carry `?token=` or
    // `?api_key=`, and those would otherwise be written verbatim into the log
    // aggregator on every single request.
    const url = sanitizeUrl(req.url ?? '/');
    const status = statusCode ?? res.statusCode;
    const isSlow = durationMs >= this.threshold;

    // Update in-memory metrics
    this.metrics.totalRequests += 1;
    this.metrics.totalResponseTimeMs += durationMs;
    if (durationMs > this.metrics.maxResponseTimeMs) {
      this.metrics.maxResponseTimeMs = durationMs;
    }
    if (isSlow) {
      this.metrics.slowRequests += 1;
    }

    const meta: Record<string, unknown> = {
      method,
      url,
      statusCode: status,
      durationMs,
      ...(requestId ? { requestId } : {}),
    };

    if (isSlow) {
      logger.warn('Slow request detected', {
        ...meta,
        slowThresholdMs: this.threshold,
      });
    } else {
      logger.info('Request completed', meta);
    }

    return durationMs;
  }

  /** Returns a snapshot of the accumulated response-time metrics. */
  getMetrics(): ResponseTimeMetrics {
    return { ...this.metrics };
  }

  /** Resets accumulated metrics back to zero. */
  resetMetrics(): void {
    this.metrics = {
      totalRequests: 0,
      slowRequests: 0,
      totalResponseTimeMs: 0,
      maxResponseTimeMs: 0,
    };
  }
}

/** Process-wide singleton so multiple modules share the same counters. */
let instance: ResponseTimeMiddleware | null = null;

export function getResponseTimeMiddleware(
  options?: ResponseTimeOptions,
): ResponseTimeMiddleware {
  if (!instance) {
    instance = new ResponseTimeMiddleware(options);
  }
  return instance;
}

/** Replace the singleton — primarily used in tests. */
export function setResponseTimeMiddleware(mw: ResponseTimeMiddleware): void {
  instance = mw;
}
