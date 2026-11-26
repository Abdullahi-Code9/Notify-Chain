import { Database } from '../database/database';
import logger from '../utils/logger';
import { generateFingerprint } from './notification-deduplicator';
import { MetadataStatus, TransactionMetadata } from '../types/transaction-metadata';

export interface ProcessedEventRecord {
  eventId: string;
  contractAddress: string;
  fingerprint: string;
  ledgerNumber: number;
  txHash?: string;
  eventType: string;
  isReorgDuplicate: boolean;
  reorgDetectionCount: number;
  notificationSent: boolean;
  status: 'PROCESSED' | 'SKIPPED' | 'ERROR';
  errorReason?: string;
  /** Completeness of the persisted transaction metadata, when recorded. */
  metadataStatus?: MetadataStatus | null;
  /** Blockchain transaction context enriched during ingestion, when recorded. */
  txMetadata?: TransactionMetadata | null;
}

/** Serialise transaction metadata for persistence; never throws. */
function serializeMetadata(metadata?: TransactionMetadata | null): string | null {
  if (!metadata) {
    return null;
  }
  try {
    return JSON.stringify(metadata);
  } catch (error) {
    logger.warn('Failed to serialise transaction metadata for persistence', { error });
    return null;
  }
}

/** Parse persisted transaction metadata; returns null on missing/invalid data. */
function parseMetadata(raw: unknown): TransactionMetadata | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw) as TransactionMetadata;
  } catch {
    return null;
  }
}

export interface PollingCursorRecord {
  contractAddress: string;
  cursor: string;
  ledgerNumber: number;
  reorgDetected: boolean;
  reorgDetectionCount: number;
}

export interface DeduplicationMetrics {
  totalProcessedEvents: number;
  reorgDuplicatesDetected: number;
  erroredEvents: number;
  currentCursorPositions: number;
  totalReorgsDetected: number;
}

/**
 * Event Deduplication Service
 *
 * Provides persistent, database-backed deduplication of blockchain events.
 * Ensures idempotent event processing even after:
 * - Service restarts
 * - Network reorgs (blockchain reorganizations)
 * - Cursor resets
 *
 * This service complements the in-memory NotificationDeduplicator by adding
 * long-term, permanent deduplication across service instances and restarts.
 */
export interface EventClaimResult {
  /** True when this caller now exclusively owns processing of the event. */
  claimed: boolean;
  /** True when the event had already been seen before (processed or in flight). */
  alreadySeen: boolean;
}

/**
 * How long an in-flight claim is honoured before another worker may take it
 * over. Protects against a worker crashing between claim and completion,
 * which would otherwise leave the event un-notified forever.
 */
export const DEFAULT_CLAIM_LEASE_SECONDS = 300;

export class EventDeduplicationService {
  private db: Database;
  private readonly claimLeaseSeconds: number;

  constructor(database: Database, options: { claimLeaseSeconds?: number } = {}) {
    this.db = database;
    this.claimLeaseSeconds = options.claimLeaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS;
  }

  /**
   * Atomically claim an event for processing.
   *
   * Exactly one concurrent caller — across async tasks, poll cycles, retry
   * paths and listener instances sharing the database — receives
   * `claimed: true`. The claim is a single `INSERT … ON CONFLICT` statement
   * keyed on the UNIQUE `fingerprint`, so there is no check-then-act window.
   *
   * A row left in `PROCESSING` longer than the claim lease (crashed worker) can
   * be re-claimed; completed rows (`PROCESSED` / `SKIPPED` / `ERROR`) never can.
   *
   * On database error this fails open (`claimed: true`), matching
   * `isDuplicate`'s availability-over-strictness policy.
   */
  async claimEvent(
    eventId: string,
    contractAddress: string,
    ledgerNumber: number,
    txHash: string | undefined,
    eventType: string,
  ): Promise<EventClaimResult> {
    const fingerprint = generateFingerprint(eventId, contractAddress);
    try {
      const result = await this.db.run(
        `
        INSERT INTO processed_events (
          event_id, contract_address, fingerprint, ledger_number, tx_hash,
          event_type, notification_sent, status, is_reorg_duplicate, processed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, 'PROCESSING', 0, CURRENT_TIMESTAMP)
        ON CONFLICT(fingerprint) DO UPDATE SET
          processed_at = CURRENT_TIMESTAMP,
          ledger_number = excluded.ledger_number
        WHERE processed_events.status = 'PROCESSING'
          AND processed_events.processed_at < datetime('now', ?)
        `,
        [
          eventId,
          contractAddress,
          fingerprint,
          ledgerNumber,
          txHash ?? null,
          eventType,
          `-${this.claimLeaseSeconds} seconds`,
        ],
      );

      if (result.changes === 1) {
        return { claimed: true, alreadySeen: false };
      }
      return { claimed: false, alreadySeen: true };
    } catch (error) {
      logger.error('Error claiming event for processing', {
        eventId,
        contractAddress,
        error,
      });
      return { claimed: true, alreadySeen: false };
    }
  }

  /**
   * Finalise a claimed event. A single atomic upsert (issue #1121): it
   * updates the claim row, or inserts one when no claim exists (claim failed
   * open). Previously an UPDATE followed by a separate INSERT could leave the
   * record half-written if the second statement failed.
   */
  async completeEvent(
    eventId: string,
    contractAddress: string,
    ledgerNumber: number,
    txHash: string | undefined,
    eventType: string,
    notificationSent: boolean,
    status: 'PROCESSED' | 'ERROR',
    errorReason?: string,
    txMetadata?: TransactionMetadata | null,
  ): Promise<void> {
    const fingerprint = generateFingerprint(eventId, contractAddress);
    const serializedMetadata = serializeMetadata(txMetadata);
    const metadataStatus = txMetadata?.metadataStatus ?? null;
    try {
      await this.db.run(
        `
        INSERT INTO processed_events (
          event_id, contract_address, fingerprint, ledger_number, tx_hash,
          event_type, notification_sent, status, error_reason, is_reorg_duplicate
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(fingerprint) DO UPDATE SET
          status = excluded.status,
          notification_sent = excluded.notification_sent,
          error_reason = excluded.error_reason,
          processed_at = CURRENT_TIMESTAMP
        `,
        [eventId, contractAddress, fingerprint, ledgerNumber, txHash ?? null, eventType,
          notificationSent ? 1 : 0, status, errorReason ?? null],
      );

        UPDATE processed_events
        SET status = ?, notification_sent = ?, error_reason = ?,
            tx_metadata = COALESCE(?, tx_metadata),
            metadata_status = COALESCE(?, metadata_status),
            processed_at = CURRENT_TIMESTAMP
        WHERE fingerprint = ?
        `,
        [status, notificationSent ? 1 : 0, errorReason ?? null, serializedMetadata, metadataStatus, fingerprint],
      );

      if (result.changes === 0) {
        await this.db.run(
          `
          INSERT INTO processed_events (
            event_id, contract_address, fingerprint, ledger_number, tx_hash,
            event_type, notification_sent, status, error_reason, is_reorg_duplicate,
            tx_metadata, metadata_status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT(fingerprint) DO NOTHING
          `,
          [eventId, contractAddress, fingerprint, ledgerNumber, txHash ?? null, eventType,
            notificationSent ? 1 : 0, status, errorReason ?? null, serializedMetadata, metadataStatus],
        );
      }

      logger.info('Event processed and recorded', {
        eventId,
        contractAddress,
        fingerprint,
        ledgerNumber,
        notificationSent,
        status,
      });
    } catch (error) {
      logger.error('Error completing processed event', { eventId, contractAddress, error });
    }
  }

  /**
   * Attach per-stage latency to the event's processed_events record
   * (issue #1120). One statement: the INSERT … SELECT resolves the parent row
   * and upserts its single timing row, so the FK and UNIQUE constraints on
   * event_processing_timings hold. When no processed_events row exists (dry
   * run, skipped event) nothing is written. Never throws: diagnostics must
   * not affect event processing.
   */
  async recordStageTimings(
    eventId: string,
    contractAddress: string,
    timings: {
      retrievalMs?: number;
      decodeValidationMs?: number;
      persistenceMs?: number;
      notificationPrepMs?: number;
      totalMs?: number | null;
      outcome: 'processed' | 'duplicate' | 'skipped' | 'error';
    },
  ): Promise<boolean> {
    const fingerprint = generateFingerprint(eventId, contractAddress);
    const value = (v: number | null | undefined) =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
    try {
      const result = await this.db.run(
        `
        INSERT INTO event_processing_timings (
          processed_event_id, retrieval_ms, decode_validation_ms, persistence_ms,
          notification_prep_ms, total_ms, outcome
        )
        SELECT id, ?, ?, ?, ?, ?, ? FROM processed_events WHERE fingerprint = ?
        ON CONFLICT(processed_event_id) DO UPDATE SET
          retrieval_ms = excluded.retrieval_ms,
          decode_validation_ms = excluded.decode_validation_ms,
          persistence_ms = excluded.persistence_ms,
          notification_prep_ms = excluded.notification_prep_ms,
          total_ms = excluded.total_ms,
          outcome = excluded.outcome,
          recorded_at = CURRENT_TIMESTAMP
        `,
        [
          value(timings.retrievalMs),
          value(timings.decodeValidationMs),
          value(timings.persistenceMs),
          value(timings.notificationPrepMs),
          value(timings.totalMs),
          timings.outcome,
          fingerprint,
        ],
      );
      return result.changes > 0;
    } catch (error) {
      logger.warn('Failed to persist event stage timings', {
        eventId,
        contractAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Reads the persisted stage timings for an event, or null when absent. */
  async getStageTimings(
    eventId: string,
    contractAddress: string,
  ): Promise<{
    retrievalMs: number | null;
    decodeValidationMs: number | null;
    persistenceMs: number | null;
    notificationPrepMs: number | null;
    totalMs: number | null;
    outcome: string;
    recordedAt: string;
  } | null> {
    try {
      const rows = await this.db.all<{
        retrieval_ms: number | null;
        decode_validation_ms: number | null;
        persistence_ms: number | null;
        notification_prep_ms: number | null;
        total_ms: number | null;
        outcome: string;
        recorded_at: string;
      }>(
        `
        SELECT t.retrieval_ms, t.decode_validation_ms, t.persistence_ms,
               t.notification_prep_ms, t.total_ms, t.outcome, t.recorded_at
        FROM event_processing_timings t
        JOIN processed_events p ON p.id = t.processed_event_id
        WHERE p.fingerprint = ?
        `,
        [generateFingerprint(eventId, contractAddress)],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        retrievalMs: row.retrieval_ms,
        decodeValidationMs: row.decode_validation_ms,
        persistenceMs: row.persistence_ms,
        notificationPrepMs: row.notification_prep_ms,
        totalMs: row.total_ms,
        outcome: row.outcome,
        recordedAt: row.recorded_at,
      };
    } catch (error) {
      logger.warn('Failed to read event stage timings', { eventId, contractAddress, error });
      return null;
    }
  }

  /**
   * Record that an already-seen event was detected again (reorg / overlapping
   * poll / concurrent delivery). Increments the counter atomically in SQL and
   * never overwrites the original processing outcome (`status`,
   * `notification_sent`). In-flight claims are left untouched.
   */
  async recordRedetection(
    eventId: string,
    contractAddress: string,
    ledgerNumber: number,
  ): Promise<void> {
    const fingerprint = generateFingerprint(eventId, contractAddress);
    try {
      await this.db.run(
        `
        UPDATE processed_events
        SET
          is_reorg_duplicate = 1,
          reorg_detection_count = reorg_detection_count + 1,
          last_redetected_at = CURRENT_TIMESTAMP,
          ledger_number = ?
        WHERE fingerprint = ? AND status != 'PROCESSING'
        `,
        [ledgerNumber, fingerprint],
      );
    } catch (error) {
      logger.error('Error recording event redetection', { eventId, contractAddress, error });
    }
  }

  /**
   * Check if an event has already been processed
   * Returns true if the event exists in the database (indicating it was already processed)
   */
  async isDuplicate(
    eventId: string,
    contractAddress: string
  ): Promise<{ isDuplicate: boolean; isReorgDuplicate: boolean }> {
    try {
      const fingerprint = generateFingerprint(eventId, contractAddress);
      const rows = await this.db.all(
        `
        SELECT event_id, is_reorg_duplicate 
        FROM processed_events 
        WHERE fingerprint = ?
        LIMIT 1
        `,
        [fingerprint]
      );

      if (rows.length === 0) {
        return { isDuplicate: false, isReorgDuplicate: false };
      }

      const record = rows[0] as any;
      return {
        isDuplicate: true,
        isReorgDuplicate: record.is_reorg_duplicate === 1,
      };
    } catch (error) {
      logger.error('Error checking for duplicate event', {
        eventId,
        contractAddress,
        error,
      });
      // On error, fail open (allow processing) to avoid cascading failures
      return { isDuplicate: false, isReorgDuplicate: false };
    }
  }

  /**
   * Record that an event has been processed
   */
  async recordProcessedEvent(
    eventId: string,
    contractAddress: string,
    ledgerNumber: number,
    txHash: string | undefined,
    eventType: string,
    notificationSent: boolean = true,
    status: 'PROCESSED' | 'SKIPPED' | 'ERROR' = 'PROCESSED',
    errorReason?: string,
    txMetadata?: TransactionMetadata | null,
  ): Promise<void> {
    try {
      const fingerprint = generateFingerprint(eventId, contractAddress);
      const serializedMetadata = serializeMetadata(txMetadata);
      const metadataStatus = txMetadata?.metadataStatus ?? null;

      // Single atomic upsert: insert a new record, or — if the fingerprint
      // already exists (reorg duplicate) — bump the counter in SQL. The old
      // SELECT-then-INSERT/UPDATE let concurrent callers lose increments or
      // hit the UNIQUE constraint.
      const rows = await this.db.all<{ reorg_detection_count: number }>(
        `
        INSERT INTO processed_events (
          event_id, contract_address, fingerprint, ledger_number, tx_hash,
          event_type, notification_sent, status, error_reason, is_reorg_duplicate,
          tx_metadata, metadata_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET
          is_reorg_duplicate = 1,
          reorg_detection_count = processed_events.reorg_detection_count + 1,
          last_redetected_at = CURRENT_TIMESTAMP,
          status = excluded.status,
          ledger_number = excluded.ledger_number,
          tx_metadata = COALESCE(excluded.tx_metadata, processed_events.tx_metadata),
          metadata_status = COALESCE(excluded.metadata_status, processed_events.metadata_status)
        RETURNING reorg_detection_count
        `,
        [eventId, contractAddress, fingerprint, ledgerNumber, txHash, eventType, notificationSent ? 1 : 0, status, errorReason, serializedMetadata, metadataStatus]
      );

      const reorgDetectionCount = rows[0]?.reorg_detection_count ?? 0;
      if (reorgDetectionCount > 0) {
        logger.warn('Reorg duplicate detected', {
          eventId,
          contractAddress,
          fingerprint,
          reorgDetectionCount,
          ledgerNumber,
        });
        return;
      }

      logger.info('Event processed and recorded', {
        eventId,
        contractAddress,
        fingerprint,
        ledgerNumber,
        notificationSent,
      });
    } catch (error) {
      logger.error('Error recording processed event', {
        eventId,
        contractAddress,
        error,
      });
      // Don't throw - allow processing to continue even if DB write fails
    }
  }

  /**
   * Fetch a single processed-event record (including its persisted transaction
   * metadata) by event identity. Returns null when the event has not been
   * recorded or the lookup fails.
   */
  async getProcessedEvent(
    eventId: string,
    contractAddress: string,
  ): Promise<ProcessedEventRecord | null> {
    try {
      const fingerprint = generateFingerprint(eventId, contractAddress);
      const rows = await this.db.all(
        `
        SELECT event_id, contract_address, fingerprint, ledger_number, tx_hash,
               event_type, is_reorg_duplicate, reorg_detection_count,
               notification_sent, status, error_reason, metadata_status, tx_metadata
        FROM processed_events
        WHERE fingerprint = ?
        LIMIT 1
        `,
        [fingerprint],
      );

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0] as any;
      return {
        eventId: row.event_id,
        contractAddress: row.contract_address,
        fingerprint: row.fingerprint,
        ledgerNumber: row.ledger_number,
        txHash: row.tx_hash ?? undefined,
        eventType: row.event_type,
        isReorgDuplicate: row.is_reorg_duplicate === 1,
        reorgDetectionCount: row.reorg_detection_count ?? 0,
        notificationSent: row.notification_sent === 1,
        status: row.status,
        errorReason: row.error_reason ?? undefined,
        metadataStatus: row.metadata_status ?? null,
        txMetadata: parseMetadata(row.tx_metadata),
      };
    } catch (error) {
      logger.error('Error retrieving processed event', { eventId, contractAddress, error });
      return null;
    }
  }

  /**
   * Update or create a polling cursor for a contract
   * Used to track the last known position for reorg detection
   */
  async updatePollingCursor(
    contractAddress: string,
    cursor: string,
    ledgerNumber: number,
    reorgDetected: boolean = false
  ): Promise<void> {
    try {
      // Atomic upsert keyed on the UNIQUE contract_address. The reorg counter
      // is incremented in SQL so concurrent poll cycles cannot lose updates
      // or collide on the first insert.
      await this.db.run(
        `
        INSERT INTO polling_cursors (
          contract_address, cursor, ledger_number, reorg_detected, reorg_detection_count
        )
        VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(contract_address) DO UPDATE SET
          cursor = excluded.cursor,
          ledger_number = excluded.ledger_number,
          reorg_detected = excluded.reorg_detected,
          reorg_detection_count = polling_cursors.reorg_detection_count + excluded.reorg_detected,
          updated_at = CURRENT_TIMESTAMP
        `,
        [contractAddress, cursor, ledgerNumber, reorgDetected ? 1 : 0]
      );

      if (reorgDetected) {
        logger.warn('Reorg detected and recorded', {
          contractAddress,
          cursor,
          ledgerNumber,
        });
      }
    } catch (error) {
      logger.error('Error updating polling cursor', {
        contractAddress,
        cursor,
        ledgerNumber,
        error,
      });
    }
  }

  /**
   * Get the last known cursor for a contract
   */
  async getLastCursor(contractAddress: string): Promise<PollingCursorRecord | null> {
    try {
      const rows = await this.db.all(
        `
        SELECT 
          contract_address, cursor, ledger_number, 
          reorg_detected, reorg_detection_count
        FROM polling_cursors 
        WHERE contract_address = ?
        LIMIT 1
        `,
        [contractAddress]
      );

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0] as any;
      return {
        contractAddress: row.contract_address,
        cursor: row.cursor,
        ledgerNumber: row.ledger_number,
        reorgDetected: row.reorg_detected === 1,
        reorgDetectionCount: row.reorg_detection_count || 0,
      };
    } catch (error) {
      logger.error('Error retrieving last cursor', {
        contractAddress,
        error,
      });
      return null;
    }
  }

  /**
   * Check if a reorg is likely by comparing ledger numbers
   * If the new ledger is less than the previous ledger, a reorg likely occurred
   */
  async detectReorg(contractAddress: string, newLedgerNumber: number): Promise<boolean> {
    try {
      const lastCursor = await this.getLastCursor(contractAddress);
      if (!lastCursor) {
        // First time seeing this contract
        return false;
      }

      const reorgDetected = newLedgerNumber < lastCursor.ledgerNumber;
      if (reorgDetected) {
        logger.warn('Blockchain reorg detected', {
          contractAddress,
          previousLedger: lastCursor.ledgerNumber,
          newLedger: newLedgerNumber,
        });
      }

      return reorgDetected;
    } catch (error) {
      logger.error('Error detecting reorg', {
        contractAddress,
        newLedgerNumber,
        error,
      });
      return false;
    }
  }

  /**
   * Get comprehensive deduplication metrics
   */
  async getMetrics(): Promise<DeduplicationMetrics> {
    try {
      const processedRows = await this.db.all(
        `
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN is_reorg_duplicate = 1 THEN 1 ELSE 0 END) as reorg_duplicates,
          SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END) as errors
        FROM processed_events
        `
      );

      const cursorRows = await this.db.all(
        `
        SELECT COUNT(*) as count FROM polling_cursors
        `
      );

      const reorgRows = await this.db.all(
        `
        SELECT SUM(reorg_detection_count) as total FROM polling_cursors
        `
      );

      const processedData = processedRows[0] as any;
      const cursorData = cursorRows[0] as any;
      const reorgData = reorgRows[0] as any;

      return {
        totalProcessedEvents: processedData.total || 0,
        reorgDuplicatesDetected: processedData.reorg_duplicates || 0,
        erroredEvents: processedData.errors || 0,
        currentCursorPositions: cursorData.count || 0,
        totalReorgsDetected: reorgData.total || 0,
      };
    } catch (error) {
      logger.error('Error retrieving deduplication metrics', { error });
      return {
        totalProcessedEvents: 0,
        reorgDuplicatesDetected: 0,
        erroredEvents: 0,
        currentCursorPositions: 0,
        totalReorgsDetected: 0,
      };
    }
  }

  /**
   * Clean up old processed event records (older than the specified number of days)
   * Keeps recent history for monitoring while reducing database size
   */
  async cleanupOldRecords(daysToKeep: number = 30): Promise<number> {
    try {
      const result = await this.db.run(
        `
        DELETE FROM processed_events 
        WHERE processed_at < datetime('now', '-' || ? || ' days')
          AND is_reorg_duplicate = 0
        `,
        [daysToKeep]
      );

      logger.info('Cleaned up old event records', {
        daysToKeep,
        recordsDeleted: result.changes,
      });

      return result.changes;
    } catch (error) {
      logger.error('Error cleaning up old records', {
        daysToKeep,
        error,
      });
      return 0;
    }
  }
}
