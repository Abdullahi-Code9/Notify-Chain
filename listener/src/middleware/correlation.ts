/**
 * Correlation-ID middleware (#986)
 *
 * Resolves the request's `X-Correlation-Id` (validating any client-supplied
 * value and minting a UUID otherwise), echoes it on the response, and runs the
 * request handler inside an AsyncLocalStorage context so the ID reaches:
 *
 *   - every structured log line (see `withCorrelationMeta` in utils/logger),
 *   - every standardized error envelope (`error.correlation_id`),
 *   - background jobs enqueued while serving the request
 *     (EventProcessingQueue captures it at enqueue time).
 *
 * Usage:
 *
 *   http.createServer((req, res) =>
 *     runWithRequestCorrelation(req, res, (ctx) => handleRequest(req, res, ctx)),
 *   );
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { applyRequestContext, type RequestContext } from '../utils/request-id';
import { runWithCorrelationContext } from '../utils/correlation-context';

export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

export function runWithRequestCorrelation<T>(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (context: RequestContext) => T,
): T {
  const context = applyRequestContext(req, res);
  return runWithCorrelationContext(
    { correlationId: context.correlationId, requestId: context.requestId },
    () => handler(context),
  );
}
