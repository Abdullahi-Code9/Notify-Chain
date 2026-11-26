/**
 * Notification & Webhook Destination API routes.
 *
 *   GET    /api/destinations           List destinations owned by the caller
 *   POST   /api/destinations           Create a destination bound to the caller
 *   GET    /api/destinations/:id       Fetch a single owned destination
 *   PUT    /api/destinations/:id       Update an owned destination
 *   DELETE /api/destinations/:id       Delete an owned destination
 *   POST   /api/destinations/:id/test  Send a test notification to an owned destination
 *
 * Ownership is resolved strictly server-side from the authenticated principal
 * (`AuthPrincipal`); callers can never read, modify, delete, test, or reference
 * another user's destinations.
 */

import http from 'http';
import logger from '../utils/logger';
import { sendErr, sendJson, ErrorCode } from '../utils/response';
import { validateContentType } from '../middleware/content-type';
import {
  authorizeRequest,
  principalClientId,
  type ApiKeyEntry,
  type AuthPrincipal,
} from './api-key-auth';
import { type ApiCredentialService } from '../services/api-credential-service';
import {
  DestinationConflictError,
  DestinationNotFoundError,
  DestinationOwnershipError,
  DestinationService,
  DestinationValidationError,
} from '../services/destination-service';
import type { CreateDestinationInput, DestinationUpdate } from '../types/destination';

export interface DestinationRoutesDeps {
  destinationService: DestinationService | null | undefined;
  credentialService?: ApiCredentialService | null;
  apiKeys?: ApiKeyEntry[];
  /**
   * When true, unauthenticated requests are rejected even when no static API
   * keys or scoped credentials are configured.
   */
  requireAuthentication?: boolean;
  /**
   * Optional custom server-side owner resolver (e.g. session/wallet middleware).
   * When omitted, ownership is derived from the authenticated `AuthPrincipal`.
   */
  resolveOwnerId?: (req: http.IncomingMessage, principal: AuthPrincipal) => string | null;
}

const COLLECTION_PATH = '/api/destinations';
const ITEM_PATTERN = /^\/api\/destinations\/([^/]+)$/;
const TEST_PATTERN = /^\/api\/destinations\/([^/]+)\/test$/;

export function resolveDestinationOwnerId(
  principal: AuthPrincipal,
  req: http.IncomingMessage,
  customResolver?: (req: http.IncomingMessage, principal: AuthPrincipal) => string | null,
): string | null {
  if (customResolver) {
    const resolved = customResolver(req, principal);
    if (resolved && resolved.trim()) return resolved.trim();
  }
  const clientId = principalClientId(principal);
  if (clientId) return clientId;
  if (principal.type === 'anonymous') return 'anonymous';
  return null;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function handleDestinationError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof DestinationOwnershipError) {
    sendErr(res, 403, error.message, ErrorCode.FORBIDDEN);
    return;
  }
  if (error instanceof DestinationNotFoundError) {
    sendErr(res, 404, error.message, ErrorCode.NOT_FOUND);
    return;
  }
  if (error instanceof DestinationConflictError) {
    sendErr(res, 409, error.message, ErrorCode.CONFLICT);
    return;
  }
  if (error instanceof DestinationValidationError) {
    sendJson(res, 422, {
      success: false,
      error: {
        code: ErrorCode.UNPROCESSABLE,
        message: error.message,
        details: Object.entries(error.fieldErrors).map(([field, message]) => ({ field, message })),
      },
      fieldErrors: error.fieldErrors,
    });
    return;
  }
  logger.error('Destination route error', { error });
  sendErr(res, 500, 'Internal server error', ErrorCode.INTERNAL_ERROR);
}

/**
 * Handles `/api/destinations` routes. Resolves `true` when the request matched
 * the `/api/destinations` prefix and a response was sent.
 */
export async function handleDestinationRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: DestinationRoutesDeps,
): Promise<boolean> {
  const path = url.pathname;
  const testMatch = TEST_PATTERN.exec(path);
  const itemMatch = testMatch ? null : ITEM_PATTERN.exec(path);
  const isCollection = path === COLLECTION_PATH;

  if (!isCollection && !itemMatch && !testMatch && !path.startsWith(`${COLLECTION_PATH}/`)) {
    return false;
  }

  res.setHeader('Cache-Control', 'no-store');

  const auth = await authorizeRequest(req, {
    apiKeys: deps.apiKeys,
    credentialService: deps.credentialService,
    requiredScopes: ['webhooks:manage'],
    requireAuthentication: deps.requireAuthentication,
  });
  if (!auth.allowed) {
    if (auth.status === 401) res.setHeader('WWW-Authenticate', 'ApiKey header="X-API-Key"');
    sendErr(res, auth.status, auth.message, auth.code, auth.details);
    return true;
  }

  const ownerId = resolveDestinationOwnerId(auth.principal, req, deps.resolveOwnerId);
  if (!ownerId) {
    sendErr(res, 401, 'Unable to resolve destination owner', ErrorCode.UNAUTHORIZED);
    return true;
  }

  const service = deps.destinationService;
  if (!service) {
    sendErr(res, 503, 'Destination service is not configured', ErrorCode.SERVICE_UNAVAILABLE);
    return true;
  }

  if (isCollection && req.method === 'GET') {
    try {
      const destinations = await service.listForOwner(ownerId);
      sendJson(res, 200, { destinations });
    } catch (error) {
      handleDestinationError(res, error);
    }
    return true;
  }

  if (isCollection && req.method === 'POST') {
    if (!validateContentType(req, res, ['application/json'])) return true;
    let body: CreateDestinationInput;
    try {
      body = (await readJsonBody(req)) as CreateDestinationInput;
    } catch {
      sendErr(res, 400, 'Request body must be valid JSON.', ErrorCode.PARSE_ERROR);
      return true;
    }
    try {
      const created = await service.create(ownerId, body);
      sendJson(res, 201, created);
    } catch (error) {
      handleDestinationError(res, error);
    }
    return true;
  }

  if (itemMatch) {
    const id = decodeURIComponent(itemMatch[1]);
    if (req.method === 'GET') {
      try {
        const destination = await service.getForOwner(id, ownerId);
        sendJson(res, 200, destination);
      } catch (error) {
        handleDestinationError(res, error);
      }
      return true;
    }
    if (req.method === 'PUT') {
      if (!validateContentType(req, res, ['application/json'])) return true;
      let body: DestinationUpdate;
      try {
        body = (await readJsonBody(req)) as DestinationUpdate;
      } catch {
        sendErr(res, 400, 'Request body must be valid JSON.', ErrorCode.PARSE_ERROR);
        return true;
      }
      try {
        const updated = await service.updateForOwner(id, ownerId, body);
        sendJson(res, 200, updated);
      } catch (error) {
        handleDestinationError(res, error);
      }
      return true;
    }
    if (req.method === 'DELETE') {
      try {
        const result = await service.deleteForOwner(id, ownerId);
        sendJson(res, 200, result);
      } catch (error) {
        handleDestinationError(res, error);
      }
      return true;
    }
    res.setHeader('Allow', 'GET, PUT, DELETE');
    sendErr(res, 405, `Method ${req.method} not allowed`, ErrorCode.METHOD_NOT_ALLOWED);
    return true;
  }

  if (testMatch) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendErr(res, 405, `Method ${req.method} not allowed`, ErrorCode.METHOD_NOT_ALLOWED);
      return true;
    }
    const id = decodeURIComponent(testMatch[1]);
    try {
      const result = await service.sendTestForOwner(id, ownerId);
      sendJson(res, 200, result);
    } catch (error) {
      handleDestinationError(res, error);
    }
    return true;
  }

  if (isCollection) {
    res.setHeader('Allow', 'GET, POST');
    sendErr(res, 405, `Method ${req.method} not allowed`, ErrorCode.METHOD_NOT_ALLOWED);
    return true;
  }

  sendErr(res, 404, 'Destination route not found', ErrorCode.NOT_FOUND);
  return true;
}
