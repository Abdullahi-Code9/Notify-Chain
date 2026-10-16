import { Database } from '../database/database';
import logger from '../utils/logger';
import { EventRegistry } from '../store/event-registry';

export interface CleanupConfig {
  /** How often to run cleanup (ms). Default: 1 hour. */
  intervalMs: number;
  /** Retain completed/failed notifications for this long (ms). Default: 7 days. */
  notificationRetentionMs: number;
  /** Retain rate-limit audit events for this long (ms). Default: 24 hours. */
  rateLimitEventRetentionMs: number;
  /** Retain notification execution log rows for this long (ms). Default: 90 days. */
  executionLogRetentionMs: number;
  /** Retain processed event metadata for this long (ms). Default: 30 days. */
  processedEventRetentionMs: number;
}

const DEFAULTS: CleanupConfig = {
  intervalMs: 60 * 60 * 1000,
  notificationRetentionMs: 7 * 24 * 60 * 60 * 1000,
  rateLimitEventRetentionMs: 24 * 60 * 60 * 1000,
  executionLogRetentionMs: 90 * 24 * 60 * 60 * 1000,
  processedEventRetentionMs: 30 * 24 * 60 * 60 * 1000,
};

export class CleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly config: CleanupConfig;

  constructor(
    private readonly db: Database,
    private readonly registry: EventRegistry,
    config: Partial<CleanupConfig> = {},
  ) {
    this.config = { ...DEFAULTS, ...config };
  }

  start(): void {
    if (this.timer) return;
    this.registry.startCleanup(this.config.intervalMs);
    this.timer = setInterval(() => void this.runDbCleanup(), this.config.intervalMs);
    logger.info('CleanupService started', this.config as unknown as Record<string, unknown>);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.registry.stopCleanup();
    logger.info('CleanupService stopped');
  }

  async runDbCleanup(): Promise<{
    notifications: number;
    executionLogs: number;
    rateLimitEvents: number;
    processedEvents: number;
  }> {
    const notificationCutoff = new Date(Date.now() - this.config.notificationRetentionMs).toISOString();
    const rateLimitCutoff = new Date(Date.now() - this.config.rateLimitEventRetentionMs).toISOString();
    const executionLogCutoff = new Date(Date.now() - this.config.executionLogRetentionMs).toISOString();
    const processedEventRetentionSeconds = this.config.processedEventRetentionMs / 1000;

    const [notifResult, rateLimitResult, executionLogResult, processedEventResult] = await Promise.all([
      this.db.run(
        `DELETE FROM scheduled_notifications
         WHERE status IN ('COMPLETED','FAILED','CANCELLED','EXPIRED')
           AND processing_completed_at < ?`,
        [notificationCutoff],
      ),
      this.db.run(
        `DELETE FROM rate_limit_events WHERE timestamp < ?`,
        [rateLimitCutoff],
      ),
      this.db.run(
        `DELETE FROM notification_execution_log WHERE execution_time < ?`,
        [executionLogCutoff],
      ),
      this.db.run(
        `DELETE FROM processed_events
         WHERE processed_at < datetime('now', '-' || ? || ' seconds')`,
        [processedEventRetentionSeconds],
      ),
    ]);

    const result = {
      notifications: notifResult.changes,
      executionLogs: executionLogResult.changes,
      rateLimitEvents: rateLimitResult.changes,
      processedEvents: processedEventResult.changes,
    };

    logger.info('DB cleanup completed', result);
    return result;
  }
}
