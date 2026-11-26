import { Database } from '../database/database';
import logger from '../utils/logger';
import * as crypto from 'crypto';

export interface IdempotencyKeyRecord {
  id: number;
  idempotency_key: string;
  request_hash: string;
  response_notification_id: number;
  response_data: string;
  created_at: string;
  expires_at: string;
  status: string;
}

export interface IdempotencyResponse {
  notificationId: number;
  isDuplicate: boolean;
  response: any;
}

/**
 * Repository for managing idempotency keys
 * Prevents duplicate notification creation from duplicate requests
 */
export class IdempotencyKeyRepository {
  private readonly defaultExpirationMinutes = 24 * 60; // 24 hours

  constructor(private db: Database) {}

  /**
   * Check if a request with this idempotency key has already been processed
   * If it has, returns the cached response
   */
  async getCachedResponse(idempotencyKey: string): Promise<IdempotencyResponse | null> {
    const sql = `
      SELECT * FROM idempotency_keys
      WHERE idempotency_key = ? AND status = 'PROCESSED'
    `;

    const row = await this.db.get<IdempotencyKeyRecord>(sql, [idempotencyKey]);

    if (!row) {
      return null;
    }

    // Check if the key has expired
    const expiresAt = new Date(row.expires_at);
    if (expiresAt <= new Date()) {
      // Mark as expired
      await this.db.run(
        'UPDATE idempotency_keys SET status = ? WHERE id = ?',
        ['EXPIRED', row.id]
      );
      return null;
    }

    logger.info('Found cached response for idempotency key', {
      idempotencyKey,
      notificationId: row.response_notification_id,
    });

    return {
      notificationId: row.response_notification_id,
      isDuplicate: true,
      response: JSON.parse(row.response_data),
    };
  }

  /**
   * Store a processed request's response for future deduplication
   */
  async storeResponse(
    idempotencyKey: string,
    requestBody: any,
    notificationId: number,
    response: any,
    expirationMinutes?: number
  ): Promise<number> {
    const requestHash = this.hashRequest(requestBody);
    const expirationMs = (expirationMinutes || this.defaultExpirationMinutes) * 60 * 1000;
    const expiresAt = new Date(Date.now() + expirationMs);

    const sql = `
      INSERT INTO idempotency_keys (
        idempotency_key, request_hash, response_notification_id,
        response_data, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, 'PROCESSED')
    `;

    try {
      const result = await this.db.run(sql, [
        idempotencyKey,
        requestHash,
        notificationId,
        JSON.stringify(response),
        expiresAt.toISOString(),
      ]);

      logger.info('Stored idempotency key response', {
        idempotencyKey,
        notificationId,
        expiresAt: expiresAt.toISOString(),
      });

      return result.lastID;
    } catch (error) {
      // If the key already exists, that's fine - another request beat us to it
      if ((error as any).message?.includes('UNIQUE constraint failed')) {
        logger.warn('Idempotency key already exists', { idempotencyKey });
        // Try to get the existing response
        const existing = await this.getCachedResponse(idempotencyKey);
        if (existing) {
          return existing.notificationId;
        }
      }
      throw error;
    }
  }

  /**
   * Validate that a request matches a previously stored request
   * Returns true if the hashes match, false otherwise
   */
  async validateRequestHash(
    idempotencyKey: string,
    requestBody: any
  ): Promise<boolean> {
    const sql = `
      SELECT request_hash FROM idempotency_keys
      WHERE idempotency_key = ?
    `;

    const row = await this.db.get<{ request_hash: string }>(sql, [idempotencyKey]);

    if (!row) {
      return true; // No previous request to validate against
    }

    const currentHash = this.hashRequest(requestBody);
    const matches = currentHash === row.request_hash;

    if (!matches) {
      logger.warn('Request hash mismatch for idempotency key', {
        idempotencyKey,
        expectedHash: row.request_hash,
        actualHash: currentHash,
      });
    }

    return matches;
  }

  /**
   * Release a key whose TTL has passed so it can be reused (issue #1114).
   * Only expired rows are removed; an active key is never touched.
   */
  async releaseExpiredKey(idempotencyKey: string, now: Date = new Date()): Promise<number> {
    const result = await this.db.run(
      `DELETE FROM idempotency_keys
       WHERE idempotency_key = ? AND (status = 'EXPIRED' OR expires_at <= ?)`,
      [idempotencyKey, now.toISOString()],
    );
    return result.changes;
  }

  /**
   * Clean up expired idempotency keys
   * Should be called periodically to maintain database size
   */
  async cleanupExpiredKeys(): Promise<number> {
    const sql = `
      DELETE FROM idempotency_keys
      WHERE expires_at < ?
    `;

    const result = await this.db.run(sql, [new Date().toISOString()]);

    if (result.changes > 0) {
      logger.info('Cleaned up expired idempotency keys', { count: result.changes });
    }

    return result.changes;
  }

  /**
   * Get statistics about idempotency keys
   */
  async getStats(): Promise<{
    total: number;
    processed: number;
    expired: number;
    oldestKey: string | null;
  }> {
    const totalSql = 'SELECT COUNT(*) as count FROM idempotency_keys';
    const processedSql = `SELECT COUNT(*) as count FROM idempotency_keys WHERE status = 'PROCESSED'`;
    const expiredSql = `SELECT COUNT(*) as count FROM idempotency_keys WHERE status = 'EXPIRED'`;
    const oldestSql = `SELECT idempotency_key FROM idempotency_keys ORDER BY created_at ASC LIMIT 1`;

    const [total, processed, expired, oldest] = await Promise.all([
      this.db.get<{ count: number }>(totalSql),
      this.db.get<{ count: number }>(processedSql),
      this.db.get<{ count: number }>(expiredSql),
      this.db.get<{ idempotency_key: string }>(oldestSql),
    ]);

    return {
      total: total?.count ?? 0,
      processed: processed?.count ?? 0,
      expired: expired?.count ?? 0,
      oldestKey: oldest?.idempotency_key ?? null,
    };
  }

  /**
   * Generate a hash of a request body for validation
   * Ensures requests with the same content are idempotent
   */
  private hashRequest(requestBody: any): string {
    const json = JSON.stringify(requestBody);
    return crypto.createHash('sha256').update(json).digest('hex');
  }
}
