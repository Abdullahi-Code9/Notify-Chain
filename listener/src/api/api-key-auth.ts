import crypto from 'crypto';
import http from 'http';
import { ErrorCode } from '../errors/api-error-codes';
import {
  looksLikeScopedApiKey,
  type ApiCredentialService,
} from '../services/api-credential-service';
import type { ApiScope } from '../types/api-credential';

export interface ApiKeyEntry {
  key: string;
  name?: string;
}

export type ApiKeyAuthResult =
  | { authenticated: true; keyName?: string; enforced: boolean }
  | { authenticated: false; reason: 'missing' | 'invalid' };

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time comparison. Both sides are hashed first so the comparison
 * never short-circuits on length and leaks nothing about the configured key.
 */
function keysMatch(provided: string, expected: string): boolean {
  return crypto.timingSafeEqual(sha256(provided), sha256(expected));
}

/**
 * Authenticates a request against the configured API keys using the
 * `X-API-Key` header — the single implementation shared by every
 * API-key-protected endpoint so they all behave identically.
 *
 * When no keys are configured, access is allowed (backward compatibility for
 * local/dev deployments); `enforced` is `false` in that case.
 */
export function authenticateApiKey(
  req: http.IncomingMessage,
  apiKeys: ApiKeyEntry[] | undefined,
): ApiKeyAuthResult {
  if (!apiKeys || apiKeys.length === 0) {
    return { authenticated: true, enforced: false };
  }

  const header = req.headers['x-api-key'];
  // Duplicate X-API-Key headers are ambiguous — reject rather than guess.
  if (Array.isArray(header)) {
    return { authenticated: false, reason: 'invalid' };
  }
  if (typeof header !== 'string' || header.length === 0) {
    return { authenticated: false, reason: 'missing' };
  }

  // Check every key (no early exit) to keep timing independent of position.
  let matched: ApiKeyEntry | undefined;
  for (const entry of apiKeys) {
    if (keysMatch(header, entry.key) && !matched) matched = entry;
  }

  if (!matched) {
    return { authenticated: false, reason: 'invalid' };
  }
  return { authenticated: true, keyName: matched.name, enforced: true };
}

export const API_KEY_AUTH_MESSAGES: Record<'missing' | 'invalid', string> = {
  missing: 'Unauthorized: missing API key',
  invalid: 'Unauthorized: invalid API key',
};

// ---------------------------------------------------------------------------
// Scoped authorization (#988)
// ---------------------------------------------------------------------------

export type AuthPrincipal =
  /** No keys configured anywhere: open dev/local mode (backward compatible). */
  | { type: 'anonymous' }
  /** A key from the static `apiKeys` config: full access, as before scopes existed. */
  | { type: 'legacy'; keyName?: string }
  /** A scoped credential issued through the credentials API. */
  | { type: 'credential'; credentialId: string; name: string; scopes: readonly ApiScope[] };

export type AuthorizationResult =
  | { allowed: true; principal: AuthPrincipal }
  | {
      allowed: false;
      status: 401 | 403;
      code: typeof ErrorCode.UNAUTHORIZED | typeof ErrorCode.INVALID_PERMISSIONS;
      message: string;
      details: unknown[];
    };

export interface AuthorizeOptions {
  apiKeys?: ApiKeyEntry[];
  credentialService?: ApiCredentialService | null;
  /** Every listed scope must be granted. Legacy keys implicitly hold all scopes. */
  requiredScopes?: readonly ApiScope[];
  /**
   * Reject even when no keys are configured. Used for credential management so
   * an unconfigured deployment cannot be used to mint the first key.
   */
  requireAuthentication?: boolean;
}

export const INVALID_PERMISSIONS_MESSAGE =
  'The provided credentials lack the necessary scope for this action.';

function unauthorized(message: string): AuthorizationResult {
  return { allowed: false, status: 401, code: ErrorCode.UNAUTHORIZED, message, details: [] };
}

/** True when `principal` holds every scope in `required`. */
export function principalHasScopes(
  principal: AuthPrincipal,
  required: readonly ApiScope[],
): boolean {
  if (principal.type !== 'credential') return true;
  return required.every((scope) => principal.scopes.includes(scope));
}

/**
 * Authenticates the `X-API-Key` header and enforces endpoint scopes
 * server-side.
 *
 * - `nck_…` keys are verified against the credential service and must hold
 *   every `requiredScopes` entry, else `403 INVALID_PERMISSIONS`.
 * - Other keys are checked against the static `apiKeys` config and keep the
 *   full access they always had.
 * - With no static keys and no active credentials, requests are allowed
 *   (unless `requireAuthentication`), preserving the existing dev behaviour.
 */
export async function authorizeRequest(
  req: http.IncomingMessage,
  options: AuthorizeOptions,
): Promise<AuthorizationResult> {
  const required = options.requiredScopes ?? [];
  const header = req.headers['x-api-key'];
  if (Array.isArray(header)) return unauthorized(API_KEY_AUTH_MESSAGES.invalid);

  const hasStaticKeys = Boolean(options.apiKeys && options.apiKeys.length > 0);
  const hasCredentials = options.credentialService?.hasActiveCredentials() ?? false;

  if (typeof header === 'string' && header.length > 0 && looksLikeScopedApiKey(header)) {
    const credential = options.credentialService
      ? await options.credentialService.verify(header)
      : null;
    if (!credential) return unauthorized(API_KEY_AUTH_MESSAGES.invalid);

    const principal: AuthPrincipal = {
      type: 'credential',
      credentialId: credential.id,
      name: credential.name,
      scopes: credential.scopes,
    };
    if (!principalHasScopes(principal, required)) {
      const missing = required.filter((scope) => !credential.scopes.includes(scope));
      return {
        allowed: false,
        status: 403,
        code: ErrorCode.INVALID_PERMISSIONS,
        message: INVALID_PERMISSIONS_MESSAGE,
        details: [{ requiredScopes: [...required], missingScopes: missing }],
      };
    }
    return { allowed: true, principal };
  }

  if (!hasStaticKeys) {
    if (!hasCredentials && !options.requireAuthentication) {
      return { allowed: true, principal: { type: 'anonymous' } };
    }
    const presented = typeof header === 'string' && header.length > 0;
    return unauthorized(API_KEY_AUTH_MESSAGES[presented ? 'invalid' : 'missing']);
  }

  const legacy = authenticateApiKey(req, options.apiKeys);
  if (!legacy.authenticated) return unauthorized(API_KEY_AUTH_MESSAGES[legacy.reason]);
  return { allowed: true, principal: { type: 'legacy', keyName: legacy.keyName } };
}
