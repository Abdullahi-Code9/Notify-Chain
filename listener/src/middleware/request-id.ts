/**
 * Request-ID middleware (#686)
 *
 * Assigns a traceable identifier to every incoming HTTP request, echoes it on
 * the response, and validates any client-supplied `X-Request-Id` before reuse.
 *
 * Usage (early in the request handler):
 *
 *   import { applyRequestIdMiddleware } from '../middleware/request-id';
 *   const { requestId, correlationId } = applyRequestIdMiddleware(req, res);
 */

import type { IncomingMessage, ServerResponse } from 'http';
import {
  applyRequestContext,
  type RequestContext,
} from '../utils/request-id';

export type { RequestContext };

/**
 * Apply request-id + correlation-id context to an incoming HTTP request.
 * Thin middleware entry point over `applyRequestContext` so the events server
 * and other HTTP surfaces share one import path under `middleware/`.
 */
export function applyRequestIdMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
): RequestContext {
  return applyRequestContext(req, res);
}
