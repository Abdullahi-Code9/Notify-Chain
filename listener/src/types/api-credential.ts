/**
 * Scoped API credentials (#988)
 *
 * Integration keys carry an explicit list of permission scopes instead of
 * implicit full administrative access. Endpoints declare the scopes they need
 * and the server rejects a credential lacking any of them with
 * `403 INVALID_PERMISSIONS`.
 */

export const API_SCOPES = [
  'events:read',
  'events:write',
  'stats:read',
  'notifications:read',
  'notifications:write',
  'webhooks:manage',
  'credentials:manage',
  'credentials:read',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === 'string' && (API_SCOPES as readonly string[]).includes(value);
}

/** Stored form. `secretHash` never leaves the service layer. */
export interface ApiCredentialRecord {
  id: string;
  name: string;
  scopes: ApiScope[];
  /** scrypt-derived hash of the secret, `scrypt$N$r$p$salt$hash` (base64url fields). */
  secretHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Public view returned by list / get endpoints — no secret material. */
export interface ApiCredential {
  id: string;
  name: string;
  scopes: ApiScope[];
  /** Non-secret key prefix (`nck_<id>`) so operators can recognise a key. */
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Returned exactly once, by the create call. `apiKey` is not recoverable afterwards. */
export interface CreatedApiCredential extends ApiCredential {
  apiKey: string;
}

export interface CreateApiCredentialInput {
  name: string;
  scopes: ApiScope[];
}
