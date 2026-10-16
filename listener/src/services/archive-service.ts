/**
 * ArchiveService
 *
 * Background worker that enforces the notification retention policy:
 *
 *   Phase 1 – Archive
 *     Every `intervalMs`, rows in `scheduled_notifications` with a terminal
 *     status (COMPLETED | FAILED | CANCELLED) whose `processing_completed_at`
 *     is older than `archiveAfterMs` are MOVED (copy + delete) into the
 *     `notification_archive` table.  Processing is capped at `batchSize` rows
 *     per cycle to keep individual transactions short.
 *
 *   Phase 2 – Purge
 *     Within the same cycle, rows in `notification_archive` whose `archived_at`
 *     is older than `deleteAfterMs` are permanently deleted (when deleteAfterMs > 0).
 *
 * Both phases run inside the same `setInterval` tick so that the full
 * retention policy is applied atomically per cycle.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../database/database';
import { ArchiveConfig } from './archive-config';
import { ArchiveStore } from './archive-store';
import logger from '../utils/logger';
import { getWorkerManager } from './worker-manager';

/** Shape of the raw SQLite row from scheduled_notifications. */
interface NotificationRow {
  id: number;
  payload: string;
  notification_type: string;
  target_recipient: string;
  execute_at: string;
  expires_at: string | null;
  created_at: string;
  processing_completed_at: string | null;
  status: string;
  retry_count: number;
  last_error: string | null;
  event_id: string | null;
  contract_address: string | null;
  metadata: string | null;
}

export interface ArchiveCycleResult {
  archived: number;
  purged: number;
  durationMs: number;
}

export class ArchiveService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly store: ArchiveStore;

  constructor(
    private readonly db: Database,
    private readonly config: ArchiveConfig,
  ) {
    this.store = new ArchiveStore(db);
  }

  /** Ensure the archive schema exists (idempotent). */
  async initialize(): Promise<void> {
    const schemaPath = path.join(__dirname, '../database/archive-schema.sql');
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Archive schema not found: ${schemaPath}`);
    }
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    await this.db.exec(sql);
    logger.info('ArchiveService: schema ready');
  }

  start(): void {
    if (this.timer) return;
    logger.info('ArchiveService started', {
      intervalMs: this.config.intervalMs,
      archiveAfterMs: this.config.archiveAfterMs,
      deleteAfterMs: this.config.deleteAfterMs,
      batchSize: this.config.batchSize,
    });
    // Run immediately on start, then on the configured interval.
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), this.config.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Wait for any in-flight archival cycles to complete
    const workerManager = getWorkerManager();
    if (workerManager.getActiveJobCount() > 0) {
      logger.info('Waiting for active archival jobs to complete', {
        activeJobs: workerManager.getActiveJobCount(),
      });
      await workerManager.initiateGracefulShutdown();
    }

    logger.info('ArchiveService stopped');
  }

  /**
   * Run one full archive + purge cycle.
   * Exposed publicly so callers (tests, admin tooling) can trigger on demand.
   * Tracks job execution with WorkerManager for graceful shutdown.
   */
  async runCycle(): Promise<ArchiveCycleResult> {
    const jobId = `archive-cycle-${Date.now()}`;
    const workerManager = getWorkerManager();

    // Skip this cycle if shutdown is in progress
    if (!workerManager.startJob(jobId)) {
      logger.info('Skipping archival cycle - shutdown in progress');
      return { archived: 0, purged: 0, durationMs: 0 };
    }

    const t0 = Date.now();
    let archived = 0;
    let purged = 0;

    try {
      archived = await this._archiveOldNotifications();
      purged = await this._purgeExpiredArchive();
    } catch (err) {
      logger.error('ArchiveService: cycle error', { error: err, jobId });
    } finally {
      workerManager.completeJob(jobId);
    }

    const durationMs = Date.now() - t0;
    logger.info('ArchiveService: cycle complete', { archived, purged, durationMs, jobId });
    return { archived, purged, durationMs };
  }

  /**
   * Immediately archive a single processed notification by id.
   * Used when a notification reaches a terminal state so active storage
   * stays lean without waiting for the next background cycle.
   * Returns true if the row was archived, false if not found / not terminal.
   */
  async archiveProcessedById(id: number): Promise<boolean> {
    const row = await this.db.get<NotificationRow>(
            `SELECT id, payload, notification_type, target_recipient, execute_at,
              expires_at, created_at, processing_completed_at, status, retry_count,
              last_error, event_id, contract_address, metadata
       FROM scheduled_notifications
       WHERE id = ?
         AND status IN ('COMPLETED','FAILED','CANCELLED','EXPIRED')`,
      [id],
    );

    if (!row) {
      return false;
    }

    await this.db.transaction(async () => {
      await this.store.insertBatch([
        {
          originalId: row.id,
          payload: row.payload,
          notificationType: row.notification_type,
          targetRecipient: row.target_recipient,
          executeAt: row.execute_at,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          processingCompletedAt: row.processing_completed_at,
          status: row.status,
          retryCount: row.retry_count,
          lastError: row.last_error,
          eventId: row.event_id,
          contractAddress: row.contract_address,
          metadata: row.metadata,
        },
      ]);
      await this.db.run(`DELETE FROM scheduled_notifications WHERE id = ?`, [id]);
    });

    logger.info('ArchiveService: archived processed notification immediately', { id });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _archiveOldNotifications(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.archiveAfterMs).toISOString();

    logger.debug('Identifying archival candidates', {
      cutoff,
      maxRows: this.config.batchSize,
      archiveAfterDays: Math.round(this.config.archiveAfterMs / (1000 * 60 * 60 * 24)),
    });

    const rows = await this.db.all<NotificationRow>(
            `SELECT id, payload, notification_type, target_recipient, execute_at,
              expires_at, created_at, processing_completed_at, status, retry_count,
              last_error, event_id, contract_address, metadata
       FROM scheduled_notifications
             WHERE status IN ('COMPLETED','FAILED','CANCELLED','EXPIRED')
         AND processing_completed_at IS NOT NULL
         AND processing_completed_at < ?
       ORDER BY processing_completed_at ASC
       LIMIT ?`,
      [cutoff, this.config.batchSize],
    );

    if (rows.length === 0) {
      logger.debug('No notifications eligible for archival');
      return 0;
    }

    // Copy to archive, then delete originals — done inside a transaction.
    let inserted = 0;
    await this.db.transaction(async () => {
      inserted = await this.store.insertBatch(
        rows.map((r) => ({
          originalId: r.id,
          payload: r.payload,
          notificationType: r.notification_type,
          targetRecipient: r.target_recipient,
          executeAt: r.execute_at,
          expiresAt: r.expires_at,
          createdAt: r.created_at,
          processingCompletedAt: r.processing_completed_at,
          status: r.status,
          retryCount: r.retry_count,
          lastError: r.last_error,
          eventId: r.event_id,
          contractAddress: r.contract_address,
          metadata: r.metadata,
        })),
      );

      // Remove originals
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      await this.db.run(
        `DELETE FROM scheduled_notifications WHERE id IN (${placeholders})`,
        ids,
      );

      logger.info('ArchiveService: archived notifications', {
        count: inserted,
        cutoff,
        statusDistribution: {
          completed: rows.filter((r) => r.status === 'COMPLETED').length,
          failed: rows.filter((r) => r.status === 'FAILED').length,
          cancelled: rows.filter((r) => r.status === 'CANCELLED').length,
          expired: rows.filter((r) => r.status === 'EXPIRED').length,
        },
      });
    });

    return inserted;
  }

  private async _purgeExpiredArchive(): Promise<number> {
    if (!this.config.deleteAfterMs) {
      logger.debug('Archive purge disabled (deleteAfterMs = 0)');
      return 0;
    }

    const cutoff = new Date(Date.now() - this.config.deleteAfterMs).toISOString();
    logger.debug('Purging expired archive records', {
      cutoff,
      deleteAfterDays: Math.round(this.config.deleteAfterMs / (1000 * 60 * 60 * 24)),
    });

    const purged = await this.store.purgeOlderThan(cutoff);

    if (purged > 0) {
      logger.info('ArchiveService: purged expired archive records', {
        count: purged,
        cutoff,
      });
    } else {
      logger.debug('No archived records eligible for purge');
    }
    return purged;
  }
}
