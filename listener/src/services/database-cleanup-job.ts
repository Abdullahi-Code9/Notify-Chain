import { Database } from '../database/database';
import { AppCleanupConfig } from '../types';
import { EventRegistry } from '../store/event-registry';
import logger from '../utils/logger';
import { getWorkerManager } from './worker-manager';

const DELETE_BATCH_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type RetentionOverride = keyof NonNullable<AppCleanupConfig['retentionOverridesMs']>;

interface CleanupTarget {
  table: string;
  requiredColumns: string[];
  where: string;
  params: (now: string, cutoff: string) => unknown[];
  retentionOverride?: RetentionOverride;
}

export interface DatabaseCleanupResult {
  runId: string;
  deletedCounts: Record<string, number>;
  skippedTables: Record<string, string>;
  failedTables: string[];
  durationMs: number;
}

const CLEANUP_TARGETS: CleanupTarget[] = [
  {
    table: 'idempotency_keys',
    requiredColumns: ['expires_at', 'created_at', 'status'],
    where: `(
      (datetime(expires_at) IS NOT NULL AND datetime(expires_at) < datetime(?))
      OR (status = 'EXPIRED' AND datetime(created_at) < datetime(?))
    )`,
    params: (now, cutoff) => [now, cutoff],
  },
  {
    table: 'processed_events',
    requiredColumns: ['processed_at'],
    where: 'datetime(processed_at) < datetime(?)',
    params: (_now, cutoff) => [cutoff],
    retentionOverride: 'processedEvents',
  },
  {
    table: 'dead_letter_queue',
    requiredColumns: ['created_at'],
    where: 'datetime(created_at) < datetime(?)',
    params: (_now, cutoff) => [cutoff],
  },
  {
    table: 'notification_execution_log',
    requiredColumns: ['execution_time', 'scheduled_notification_id'],
    where: `datetime(execution_time) < datetime(?)
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_notifications n
        WHERE n.id = notification_execution_log.scheduled_notification_id
          AND n.status IN ('PENDING', 'PROCESSING')
      )`,
    params: (_now, cutoff) => [cutoff],
    retentionOverride: 'executionLogs',
  },
  {
    table: 'rate_limit_events',
    requiredColumns: ['timestamp', 'window_ms'],
    where: `datetime(timestamp) < datetime(?)
      AND julianday(timestamp) + (window_ms / 86400000.0) < julianday(?)`,
    params: (now, cutoff) => [cutoff, now],
    retentionOverride: 'rateLimitEvents',
  },
  {
    table: 'backpressure_events',
    requiredColumns: ['event_type', 'timestamp'],
    where: `event_type = 'DEACTIVATED' AND datetime(timestamp) < datetime(?)`,
    params: (_now, cutoff) => [cutoff],
  },
];

/** Periodically removes expired temporary and derived records in small transactions. */
export class DatabaseCleanupJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeRun: Promise<DatabaseCleanupResult | null> | null = null;
  private runSequence = 0;

  constructor(
    private readonly db: Database,
    private readonly config: AppCleanupConfig,
    private readonly registry?: EventRegistry,
  ) {}

  start(): void {
    if (this.timer) return;
    if (!this.config.enabled) {
      logger.info('Database cleanup job is disabled', {
        intervalMs: this.config.intervalMs,
        retentionDays: this.config.retentionDays,
      });
      return;
    }

    this.registry?.startCleanup(this.config.intervalMs);
    logger.info('Database cleanup job started', {
      intervalMs: this.config.intervalMs,
      retentionDays: this.config.retentionDays,
    });
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.config.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.registry?.stopCleanup();
    if (this.activeRun) await this.activeRun;
    logger.info('Database cleanup job stopped');
  }

  async runOnce(): Promise<DatabaseCleanupResult | null> {
    if (this.activeRun) return this.activeRun;
    const run = this.executeRun();
    this.activeRun = run;
    try {
      return await run;
    } finally {
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  private async executeRun(): Promise<DatabaseCleanupResult | null> {
    const runId = `database-cleanup-${Date.now()}-${++this.runSequence}`;
    const workerManager = getWorkerManager();
    if (!workerManager.startJob(runId)) {
      logger.warn('Database cleanup skipped during shutdown', { runId });
      return null;
    }

    const startedAt = Date.now();
    const now = new Date(startedAt).toISOString();
    const globalRetentionMs = this.config.retentionDays * DAY_MS;
    const deletedCounts: Record<string, number> = {};
    const skippedTables: Record<string, string> = {
      scheduled_notifications:
        'Rows are retained or moved by ArchiveService; stale processing locks are recovered by the repository.',
      notification_archive: 'ArchiveService owns archived_at-based retention and purging.',
      notification_metrics_snapshots: 'NotificationMetricsRunner owns snapshot retention.',
      polling_cursors: 'Cursor and reorg state is required to resume event polling safely.',
      notification_templates: 'Template definitions remain active application configuration.',
      notification_template_audit_log:
        'Template audit history is immutable and retained for compliance.',
    };
    const failedTables: string[] = [];

    try {
      logger.warn('Database cleanup delegated tables are skipped', { runId, skippedTables });
      for (const target of CLEANUP_TARGETS) {
        deletedCounts[target.table] = 0;
        try {
          const columns = await this.db.all<{ name: string }>(`PRAGMA table_info(${target.table})`);
          const availableColumns = new Set(columns.map((column) => column.name));
          const missingColumns = target.requiredColumns.filter(
            (column) => !availableColumns.has(column),
          );
          if (missingColumns.length > 0) {
            skippedTables[target.table] =
              `Missing required timestamp/schema column(s): ${missingColumns.join(', ')}`;
            logger.warn('Database cleanup table skipped', {
              runId,
              table: target.table,
              missingColumns,
            });
            continue;
          }

          const retentionMs = target.retentionOverride
            ? (this.config.retentionOverridesMs?.[target.retentionOverride] ?? globalRetentionMs)
            : globalRetentionMs;
          const cutoff = new Date(startedAt - retentionMs).toISOString();
          const deletion = await this.deleteInBatches(target, now, cutoff);
          deletedCounts[target.table] = deletion.deleted;
          if (deletion.error) {
            failedTables.push(target.table);
            logger.error('Database cleanup table failed', {
              runId,
              table: target.table,
              error: deletion.error,
            });
          }
        } catch (error) {
          failedTables.push(target.table);
          logger.error('Database cleanup table failed', {
            runId,
            table: target.table,
            error,
          });
        }
      }
    } catch (error) {
      logger.error('Database cleanup run failed', { runId, error });
    } finally {
      workerManager.completeJob(runId);
    }

    const result: DatabaseCleanupResult = {
      runId,
      deletedCounts,
      skippedTables,
      failedTables,
      durationMs: Date.now() - startedAt,
    };
    logger.info('Database cleanup run completed', {
      runId,
      perTableDeleted: deletedCounts,
      skippedTables,
      failedTables,
      retentionDays: this.config.retentionDays,
      intervalMs: this.config.intervalMs,
      durationMs: result.durationMs,
    });
    return result;
  }

  private async deleteInBatches(
    target: CleanupTarget,
    now: string,
    cutoff: string,
  ): Promise<{ deleted: number; error?: unknown }> {
    let totalDeleted = 0;
    while (true) {
      let deleted = 0;
      try {
        await this.db.transaction(async () => {
          const result = await this.db.run(
            `DELETE FROM ${target.table}
             WHERE rowid IN (
               SELECT rowid FROM ${target.table}
               WHERE ${target.where}
               LIMIT ?
             )`,
            [...target.params(now, cutoff), DELETE_BATCH_SIZE],
          );
          deleted = result.changes;
        });
      } catch (error) {
        return { deleted: totalDeleted, error };
      }
      totalDeleted += deleted;
      if (deleted < DELETE_BATCH_SIZE) return { deleted: totalDeleted };
    }
  }
}
