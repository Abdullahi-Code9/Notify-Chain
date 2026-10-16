import crypto from 'crypto';
import http from 'http';

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
