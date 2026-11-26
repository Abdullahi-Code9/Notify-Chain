/**
 * Session authentication middleware (#1140)
 *
 * Enforces session-based access control at the HTTP layer.
 *
 * Usage
 * -----
 * ```ts
 * import { requireValidSession } from '../middleware/session-auth';
 * import { sessionManager } from '../services/session-manager';
 *
 * // Inside a route handler:
 * if (!requireValidSession(req, res, sessionManager)) return;
 * // ... proceed with handler
 * ```
 *
 * Token transport
 * ---------------
 * The session token is read from the `Authorization` header with the
 * `Session` scheme:
 *
 *   Authorization: Session ncs_<base64url token>
 *
 * When the scheme is absent, the middleware falls back to the
 * `X-Session-Token` header for clients that cannot set `Authorization`.
 */

import type http from 'http';
import { SessionManager, SESSION_AUTH_MESSAGES } from '../services/session-manager';
import { sendErr, ErrorCode } from '../utils/response';
import logger from '../utils/logger';

export const SESSION_AUTH_SCHEME = 'Session';
export const SESSION_TOKEN_HEADER = 'x-session-token';

/**
 * Extracts the raw session token from the request.  Returns `null` when
 * neither the `Authorization: Session …` header nor `X-Session-Token` is
 * present.
 */
export function extractSessionToken(req: http.IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('session ')) {
    return auth.slice('session '.length).trim() || null;
  }

  const header = req.headers[SESSION_TOKEN_HEADER];
  if (typeof header === 'string' && header.length > 0) return header.trim();

  return null;
}

/**
 * Enforces that the request carries a valid, non-expired, non-revoked session.
 *
 * Returns `true` when the session is valid; writes a `401` response and
 * returns `false` otherwise.
 *
 * ```ts
 * if (!requireValidSession(req, res, sessionManager)) return;
 * ```
 */
export function requireValidSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionManager: SessionManager,
  meta?: { requestId?: string; correlationId?: string },
): boolean {
  const token = extractSessionToken(req);

  if (!token) {
    res.setHeader('WWW-Authenticate', `${SESSION_AUTH_SCHEME} realm="Notify-Chain"`);
    sendErr(res, 401, SESSION_AUTH_MESSAGES.missing, ErrorCode.UNAUTHORIZED);
    return false;
  }

  const result = sessionManager.validate(token);

  if (!result.valid) {
    logger.warn('Session validation failed', {
      requestId: meta?.requestId,
      correlationId: meta?.correlationId,
      reason: result.reason,
    });

    res.setHeader('WWW-Authenticate', `${SESSION_AUTH_SCHEME} realm="Notify-Chain"`);
    sendErr(res, 401, SESSION_AUTH_MESSAGES[result.reason], ErrorCode.UNAUTHORIZED);
    return false;
  }

  return true;
}
