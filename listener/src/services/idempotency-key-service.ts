import { IdempotencyKeyRepository } from './idempotency-key-repository';
import logger from '../utils/logger';

/**
 * ============================================================================
 * REPLAY ATTACK PROTECTION — Architecture
 * ============================================================================
 *
 * Two complementary layers are used to prevent duplicate / replayed requests:
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ LAYER 1 — Idempotency-Key header (explicit client-supplied nonce)       │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  Clients MAY send an `Idempotency-Key` HTTP header on every mutating    │
 * │  request.  The server hashes the request body, then records the tuple:  │
 * │                                                                         │
 * │    (idempotency_key, sha256(request_body), response_payload)            │
 * │                                                                         │
 * │  Retention: 24 hours (configurable via expirationMinutes).              │
 * │  Rules:                                                                 │
 * │    • First occurrence → execute, persist, return 201/202.               │
 * │    • Same key + same body within TTL → return CACHED response          │
 * │      (isDuplicate=true, 200/202 — callers can detect the shortcut).    │
 * │    • Same key + DIFFERENT body within TTL → 409 Conflict +             │
 * │      IdempotencyKeyMismatch error code.                                 │
 * │    • After the TTL the key is released and may be reused freely.       │
 * │                                                                         │
 * │  This defeats "double-click" bugs, network retries that bypass the     │
 * │  transport layer, and re-submissions captured by packet-capture tools.  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ LAYER 2 — Cryptographic timestamp binding on signed webhooks            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  For webhook traffic from trusted providers, HMAC-SHA256 is computed    │
 * │  over `timestamp + "." + rawBody` instead of just the body.            │
 * │  Stripping / forging the timestamp therefore breaks the HMAC and the    │
 * │  request is rejected with 401 AUTH_TIMESTAMP_EXPIRED / AUTH_INVALID.   │
 * │  See webhook-verifier.ts buildSigningInput().                           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ LAYER 3 — On-chain / event deduplication (off-chain event consumer)    │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  EventDeduplicationService caches seen (ledger, txHash, eventIdx)       │
 * │  tuples so Soroban re-orgs / re-streams do not re-trigger delivery.    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * A request is considered "replayed" if ANY of these three layers rejects
 * it as already-seen.  Each rejection emits a structured logger.warn for
 * audit / intrusion detection.
 * ============================================================================
 */

/**
 * Service for managing request idempotency.
 * Prevents duplicate notification creation by caching responses.
 * See module-level comment block above for the full replay-protection
 * architecture.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_HEADER_CAPITALIZED = 'Idempotency-Key';

export class IdempotencyKeyReuseError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_MISMATCH';
  readonly statusCode = 409;
  constructor(message?: string) {
    super(message ?? 'Idempotency key reused with a different request body');
    this.name = 'IdempotencyKeyReuseError';
  }
}

export class IdempotencyKeyService {
  constructor(private repository: IdempotencyKeyRepository) {}

  /**
   * Extract an idempotency key from HTTP request headers.
   * Accepts both lowercase (`idempotency-key`) and capitalized
   * (`Idempotency-Key`) forms.
   */
  static extractKey(
    headers: Record<string, string | string[] | undefined>
  ): string | null {
    const raw = headers[IDEMPOTENCY_HEADER] ?? headers[IDEMPOTENCY_HEADER_CAPITALIZED];
    if (!raw) return null;
    return Array.isArray(raw) ? raw[0] : raw;
  }

  /**
   * Process a request with idempotency support.
   *
   * Returns:
   *   - result: the processor return value (fresh or cached)
   *   - isDuplicate: true when the response came from the replay cache
   *   - notificationId: associated persisted notification id (if any)
   *
   * Throws:
   *   - IdempotencyKeyReuseError (409) when the same key is reused with a
   *     different body inside the TTL window.
   */
  async processWithIdempotency<T>(
    idempotencyKey: string | undefined,
    requestBody: any,
    processor: () => Promise<T>,
    options?: {
      expirationMinutes?: number;
      requestId?: string;
      correlationId?: string;
    }
  ): Promise<{
    result: T;
    isDuplicate: boolean;
    notificationId?: number;
  }> {
    if (!idempotencyKey) {
      const result = await processor();
      return { result, isDuplicate: false };
    }

    const logMeta = {
      idempotencyKey,
      requestId: options?.requestId,
      correlationId: options?.correlationId,
    };

    const cached = await this.repository.getCachedResponse(idempotencyKey);
    if (cached) {
      const isValidRequest = await this.repository.validateRequestHash(
        idempotencyKey,
        requestBody
      );
      if (!isValidRequest) {
        logger.warn('Idempotency key reused with different request body (replay suspected)', logMeta);
        throw new IdempotencyKeyReuseError();
      }

      logger.info('Replay intercepted: returning cached idempotent response', {
        ...logMeta,
        notificationId: cached.notificationId,
      });
      return {
        result: cached.response,
        isDuplicate: true,
        notificationId: cached.notificationId,
      };
    }

    // Expiration policy (issue #1114): once a key's TTL has passed it is
    // released and may be reused with any body. Without this the expired row
    // would make a new body look like a mismatch and its INSERT would collide
    // with the UNIQUE key.
    const released = await this.repository.releaseExpiredKey(idempotencyKey);
    if (released > 0) {
      logger.info('Expired idempotency key released for reuse', logMeta);
    }

    const isValidRequest = await this.repository.validateRequestHash(
      idempotencyKey,
      requestBody
    );

    if (!isValidRequest) {
      logger.warn('Idempotency key reused with different request body', logMeta);
      throw new IdempotencyKeyReuseError();
    }

    logger.info('Processing new idempotent request', logMeta);
    const result = await processor();

    const notificationId =
      typeof result === 'number' ? result : (result as any)?.id;

    await this.repository.storeResponse(
      idempotencyKey,
      requestBody,
      notificationId ?? 0,
      result,
      options?.expirationMinutes
    );

    return {
      result,
      isDuplicate: false,
      notificationId,
    };
  }

  /**
   * Clean up expired keys (should be called periodically)
   */
  async cleanupExpiredKeys(): Promise<number> {
    return await this.repository.cleanupExpiredKeys();
  }

  /**
   * Get statistics about idempotency key usage
   */
  async getStatistics() {
    return await this.repository.getStats();
  }
}
