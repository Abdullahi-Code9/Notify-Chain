/**
 * Idempotency keys for event-management API mutations (issue #1114).
 *
 * Clients MAY send `Idempotency-Key: <key>` on an eligible state-changing
 * request. Requests without the header behave exactly as before.
 *
 * Policy (see listener/docs/API_IDEMPOTENCY.md):
 *   - Key: 1-255 printable ASCII characters. Keys are scoped per client
 *     (a hash of the X-API-Key, or "anonymous"), so clients cannot collide.
 *   - Fingerprint: sha256 over method, path and the canonical JSON body
 *     (object keys sorted, so key order does not matter).
 *   - First use: the handler runs; responses with status < 500 are stored
 *     together with the fingerprint and an expiry of `ttlMs` (24h default).
 *   - Retry with the same key + fingerprint before expiry: the stored status
 *     and body are replayed and the handler does NOT run again
 *     (`Idempotent-Replayed: true`).
 *   - Same key + different fingerprint before expiry: 409
 *     IDEMPOTENCY_KEY_MISMATCH, handler not run.
 *   - Same key while the first request is still running: 409
 *     IDEMPOTENCY_REQUEST_IN_PROGRESS with Retry-After.
 *   - 5xx outcomes and thrown errors are not stored, so the client may retry.
 *   - After expiry the key is released and may be reused with any request.
 *   - In-progress markers expire after `inProgressLeaseMs` so a crashed
 *     request cannot lock a key for the full TTL.
 */
import * as crypto from 'crypto';
import type { Database } from '../database/database';
import logger from '../utils/logger';
import { err } from '../utils/response';

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_IN_PROGRESS_LEASE_MS = 60 * 1000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

const VALID_KEY = /^[\x21-\x7E]{1,255}$/;

export interface StoredApiResponse {
  statusCode: number;
  body: unknown;
}

export type BeginOutcome =
  | { kind: 'proceed' }
  | { kind: 'replay'; response: StoredApiResponse }
  | { kind: 'mismatch' }
  | { kind: 'in_progress' };

export interface ApiIdempotencyStore {
  /** Atomically claims the key, or reports what already holds it. */
  begin(scope: string, key: string, fingerprint: string, now: number, leaseMs: number): Promise<BeginOutcome>;
  complete(
    scope: string,
    key: string,
    fingerprint: string,
    response: StoredApiResponse,
    expiresAt: number,
  ): Promise<void>;
  /** Drops an in-progress claim so the request can be retried. */
  abandon(scope: string, key: string, fingerprint: string): Promise<void>;
  purgeExpired(now: number): Promise<number>;
}

/** Sorted-key JSON so semantically identical bodies fingerprint the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

export function computeRequestFingerprint(method: string, path: string, body: unknown): string {
  return crypto
    .createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

/** Client scope derived from the API key; the raw key is never stored. */
export function idempotencyScopeFor(apiKey: string | string[] | undefined): string {
  const value = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  if (!value) return 'anonymous';
  return `key:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

export function validateIdempotencyKey(key: string): string | null {
  if (!VALID_KEY.test(key)) {
    return `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters without spaces`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

interface ApiIdempotencyRow {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response_status: number | null;
  response_body: string | null;
}

export class SqliteApiIdempotencyStore implements ApiIdempotencyStore {
  constructor(private readonly db: Database) {}

  async begin(scope: string, key: string, fingerprint: string, now: number, leaseMs: number): Promise<BeginOutcome> {
    const nowIso = new Date(now).toISOString();
    // Expired records (completed or abandoned in-progress) release the key.
    await this.db.run(
      'DELETE FROM api_idempotency_keys WHERE scope = ? AND idempotency_key = ? AND expires_at <= ?',
      [scope, key, nowIso],
    );
    // The UNIQUE (scope, idempotency_key) constraint arbitrates concurrent
    // first requests: exactly one INSERT changes a row.
    const inserted = await this.db.run(
      `INSERT INTO api_idempotency_keys (scope, idempotency_key, request_fingerprint, status, expires_at)
       VALUES (?, ?, ?, 'IN_PROGRESS', ?)
       ON CONFLICT(scope, idempotency_key) DO NOTHING`,
      [scope, key, fingerprint, new Date(now + leaseMs).toISOString()],
    );
    if (inserted.changes > 0) return { kind: 'proceed' };

    const row = await this.db.get<ApiIdempotencyRow>(
      `SELECT request_fingerprint, status, response_status, response_body
       FROM api_idempotency_keys WHERE scope = ? AND idempotency_key = ?`,
      [scope, key],
    );
    if (!row) return { kind: 'in_progress' }; // released concurrently; client retries
    if (row.request_fingerprint !== fingerprint) return { kind: 'mismatch' };
    if (row.status !== 'COMPLETED' || row.response_status === null || row.response_body === null) {
      return { kind: 'in_progress' };
    }
    return {
      kind: 'replay',
      response: { statusCode: row.response_status, body: JSON.parse(row.response_body) },
    };
  }

  async complete(
    scope: string,
    key: string,
    fingerprint: string,
    response: StoredApiResponse,
    expiresAt: number,
  ): Promise<void> {
    await this.db.run(
      `UPDATE api_idempotency_keys
       SET status = 'COMPLETED', response_status = ?, response_body = ?, expires_at = ?
       WHERE scope = ? AND idempotency_key = ? AND request_fingerprint = ? AND status = 'IN_PROGRESS'`,
      [
        response.statusCode,
        JSON.stringify(response.body ?? null),
        new Date(expiresAt).toISOString(),
        scope,
        key,
        fingerprint,
      ],
    );
  }

  async abandon(scope: string, key: string, fingerprint: string): Promise<void> {
    await this.db.run(
      `DELETE FROM api_idempotency_keys
       WHERE scope = ? AND idempotency_key = ? AND request_fingerprint = ? AND status = 'IN_PROGRESS'`,
      [scope, key, fingerprint],
    );
  }

  async purgeExpired(now: number): Promise<number> {
    const result = await this.db.run('DELETE FROM api_idempotency_keys WHERE expires_at <= ?', [
      new Date(now).toISOString(),
    ]);
    return result.changes;
  }
}

/** Process-local store used when no database is configured, and in tests. */
export class InMemoryApiIdempotencyStore implements ApiIdempotencyStore {
  private readonly records = new Map<
    string,
    { fingerprint: string; response: StoredApiResponse | null; expiresAt: number }
  >();

  private id(scope: string, key: string): string {
    return `${scope}\u0000${key}`;
  }

  async begin(scope: string, key: string, fingerprint: string, now: number, leaseMs: number): Promise<BeginOutcome> {
    const id = this.id(scope, key);
    const existing = this.records.get(id);
    if (existing && existing.expiresAt <= now) this.records.delete(id);

    const current = this.records.get(id);
    if (!current) {
      this.records.set(id, { fingerprint, response: null, expiresAt: now + leaseMs });
      return { kind: 'proceed' };
    }
    if (current.fingerprint !== fingerprint) return { kind: 'mismatch' };
    if (!current.response) return { kind: 'in_progress' };
    // Return a copy so callers cannot mutate the stored response.
    return { kind: 'replay', response: JSON.parse(JSON.stringify(current.response)) };
  }

  async complete(
    scope: string,
    key: string,
    fingerprint: string,
    response: StoredApiResponse,
    expiresAt: number,
  ): Promise<void> {
    const record = this.records.get(this.id(scope, key));
    if (!record || record.fingerprint !== fingerprint || record.response) return;
    record.response = JSON.parse(JSON.stringify({ statusCode: response.statusCode, body: response.body ?? null }));
    record.expiresAt = expiresAt;
  }

  async abandon(scope: string, key: string, fingerprint: string): Promise<void> {
    const id = this.id(scope, key);
    const record = this.records.get(id);
    if (record && record.fingerprint === fingerprint && !record.response) this.records.delete(id);
  }

  async purgeExpired(now: number): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface IdempotentRequest {
  /** Raw header value, or null/undefined when the client sent none. */
  key: string | null | undefined;
  scope: string;
  method: string;
  path: string;
  body: unknown;
}

export interface IdempotentResult {
  response: StoredApiResponse;
  /** Headers to add to the HTTP response. */
  headers: Record<string, string>;
  replayed: boolean;
}

function errorResponse(statusCode: number, code: string, message: string): StoredApiResponse {
  return { statusCode, body: err(message, code) };
}

export class ApiIdempotencyService {
  readonly ttlMs: number;
  private readonly inProgressLeaseMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: ApiIdempotencyStore,
    options: { ttlMs?: number; inProgressLeaseMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_IDEMPOTENCY_TTL_MS;
    this.inProgressLeaseMs =
      options.inProgressLeaseMs && options.inProgressLeaseMs > 0
        ? options.inProgressLeaseMs
        : DEFAULT_IN_PROGRESS_LEASE_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Runs `handler` under the idempotency policy. `handler` must return the
   * response instead of writing it, so the same value can be stored and
   * replayed byte-for-byte.
   */
  async execute(request: IdempotentRequest, handler: () => Promise<StoredApiResponse>): Promise<IdempotentResult> {
    if (request.key === null || request.key === undefined) {
      return { response: await handler(), headers: {}, replayed: false };
    }

    const key = request.key;
    const invalid = validateIdempotencyKey(key);
    if (invalid) {
      return { response: errorResponse(400, 'IDEMPOTENCY_KEY_INVALID', invalid), headers: {}, replayed: false };
    }

    const fingerprint = computeRequestFingerprint(request.method, request.path, request.body);
    const logMeta = { scope: request.scope, method: request.method, path: request.path };

    let begin: BeginOutcome;
    try {
      begin = await this.store.begin(request.scope, key, fingerprint, this.now(), this.inProgressLeaseMs);
    } catch (error) {
      // Fail closed: running the mutation without the guarantee the client
      // asked for could apply it twice.
      logger.error('Idempotency store unavailable', { ...logMeta, error });
      return {
        response: errorResponse(503, 'IDEMPOTENCY_UNAVAILABLE', 'Idempotency store unavailable; retry later'),
        headers: { 'Retry-After': '1' },
        replayed: false,
      };
    }

    const keyHeaders = { 'Idempotency-Key': key };

    switch (begin.kind) {
      case 'replay':
        logger.info('Idempotent replay: returning stored response', logMeta);
        return {
          response: begin.response,
          headers: { ...keyHeaders, 'Idempotent-Replayed': 'true', 'X-Idempotent-Replay': 'true' },
          replayed: true,
        };
      case 'mismatch':
        logger.warn('Idempotency key reused with a different request', logMeta);
        return {
          response: errorResponse(
            409,
            'IDEMPOTENCY_KEY_MISMATCH',
            'Idempotency-Key was already used with a different request; use a new key',
          ),
          headers: keyHeaders,
          replayed: false,
        };
      case 'in_progress':
        return {
          response: errorResponse(
            409,
            'IDEMPOTENCY_REQUEST_IN_PROGRESS',
            'A request with this Idempotency-Key is still being processed',
          ),
          headers: { ...keyHeaders, 'Retry-After': '1' },
          replayed: false,
        };
      case 'proceed':
      default:
        break;
    }

    let response: StoredApiResponse;
    try {
      response = await handler();
    } catch (error) {
      await this.safeAbandon(request.scope, key, fingerprint);
      throw error;
    }

    if (response.statusCode >= 500) {
      await this.safeAbandon(request.scope, key, fingerprint);
    } else {
      try {
        await this.store.complete(request.scope, key, fingerprint, response, this.now() + this.ttlMs);
      } catch (error) {
        // The mutation already happened; report it rather than failing it.
        logger.error('Failed to store idempotent response', { ...logMeta, error });
      }
    }

    return {
      response,
      headers: { ...keyHeaders, 'Idempotent-Replayed': 'false', 'X-Idempotent-Replay': 'false' },
      replayed: false,
    };
  }

  async purgeExpired(): Promise<number> {
    return this.store.purgeExpired(this.now());
  }

  private async safeAbandon(scope: string, key: string, fingerprint: string): Promise<void> {
    try {
      await this.store.abandon(scope, key, fingerprint);
    } catch (error) {
      logger.warn('Failed to release in-progress idempotency key', { scope, error });
    }
  }
}
