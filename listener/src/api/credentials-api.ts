/**
 * Scoped API credential management endpoints (#988)
 *
 *   POST   /api/credentials       issue a key — the only response that ever contains `apiKey`
 *   GET    /api/credentials       list credentials (no secret material)
 *   GET    /api/credentials/:id   fetch one credential (no secret material)
 *   DELETE /api/credentials/:id   revoke a credential
 *
 * Every route requires the `credentials:manage` scope (static admin keys hold
 * it implicitly) and authentication even on deployments with no keys
 * configured, so an open dev server cannot be used to mint credentials.
 * A scoped caller may only grant scopes it holds itself.
 */

import http from 'http';
import logger from '../utils/logger';
import { ok, sendErr, sendJson, sendOk, ErrorCode } from '../utils/response';
import {
  authorizeRequest,
  principalHasScopes,
  INVALID_PERMISSIONS_MESSAGE,
  type ApiKeyEntry,
} from './api-key-auth';
import {
  CredentialValidationError,
  validateCreateCredentialInput,
  type ApiCredentialService,
} from '../services/api-credential-service';
import type { CreateApiCredentialInput } from '../types/api-credential';

export interface CredentialRoutesDeps {
  credentialService: ApiCredentialService | null | undefined;
  apiKeys?: ApiKeyEntry[];
}

const COLLECTION_PATH = '/api/credentials';
const ITEM_PATTERN = /^\/api\/credentials\/([0-9a-f]{16})$/;

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handles `/api/credentials` routes. Resolves true when the request was
 * handled (a response has been or will be sent).
 */
export async function handleCredentialRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: CredentialRoutesDeps,
): Promise<boolean> {
  const path = url.pathname;
  const itemMatch = ITEM_PATTERN.exec(path);
  if (path !== COLLECTION_PATH && !itemMatch && !path.startsWith(`${COLLECTION_PATH}/`)) {
    return false;
  }

  // Secrets may appear in these responses; never let an intermediary cache them.
  res.setHeader('Cache-Control', 'no-store');

  const auth = await authorizeRequest(req, {
    apiKeys: deps.apiKeys,
    credentialService: deps.credentialService,
    requiredScopes: ['credentials:manage'],
    requireAuthentication: true,
  });
  if (!auth.allowed) {
    if (auth.status === 401) res.setHeader('WWW-Authenticate', 'ApiKey header="X-API-Key"');
    sendErr(res, auth.status, auth.message, auth.code, auth.details);
    return true;
  }

  const service = deps.credentialService;
  if (!service) {
    sendErr(res, 503, 'Credential management is not enabled', ErrorCode.SERVICE_UNAVAILABLE);
    return true;
  }

  if (path === COLLECTION_PATH && req.method === 'POST') {
    let input: CreateApiCredentialInput;
    try {
      input = validateCreateCredentialInput(await readJsonBody(req));
    } catch (error) {
      if (error instanceof CredentialValidationError) {
        sendErr(res, 400, error.message, ErrorCode.VALIDATION_ERROR, error.issues);
      } else {
        sendErr(res, 400, 'Request body must be valid JSON.', ErrorCode.PARSE_ERROR);
      }
      return true;
    }

    // No privilege escalation: a scoped key cannot mint a broader key.
    if (!principalHasScopes(auth.principal, input.scopes)) {
      sendErr(res, 403, INVALID_PERMISSIONS_MESSAGE, ErrorCode.INVALID_PERMISSIONS, [
        { reason: 'Cannot grant scopes the calling credential does not hold' },
      ]);
      return true;
    }

    const created = await service.create(input);
    logger.info('API credential created', {
      credentialId: created.id,
      name: created.name,
      scopes: created.scopes,
      createdBy: auth.principal.type,
    });
    sendJson(res, 201, ok(created));
    return true;
  }

  if (path === COLLECTION_PATH && req.method === 'GET') {
    const credentials = service.list();
    sendOk(res, 200, { count: credentials.length, credentials });
    return true;
  }

  if (itemMatch && req.method === 'GET') {
    const credential = service.get(itemMatch[1]);
    if (!credential) {
      sendErr(res, 404, 'Credential not found', ErrorCode.NOT_FOUND);
      return true;
    }
    sendOk(res, 200, credential);
    return true;
  }

  if (itemMatch && req.method === 'DELETE') {
    const revoked = service.revoke(itemMatch[1]);
    if (!revoked) {
      sendErr(res, 404, 'Credential not found', ErrorCode.NOT_FOUND);
      return true;
    }
    logger.info('API credential revoked', { credentialId: revoked.id });
    sendOk(res, 200, revoked);
    return true;
  }

  if (!itemMatch && path !== COLLECTION_PATH) {
    sendErr(res, 404, 'Credential not found', ErrorCode.NOT_FOUND);
    return true;
  }

  res.setHeader('Allow', path === COLLECTION_PATH ? 'GET, POST' : 'GET, DELETE');
  sendErr(res, 405, `Method ${req.method} not allowed`, ErrorCode.METHOD_NOT_ALLOWED);
  return true;
}
